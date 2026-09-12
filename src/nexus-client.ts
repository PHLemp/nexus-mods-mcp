/**
 * Minimal HTTP client for the Nexus Mods API.
 *  - v1 (REST)    : https://api.nexusmods.com/v1
 *  - v2 (GraphQL) : https://api.nexusmods.com/v2/graphql
 *  - v3 (REST)    : https://api.nexusmods.com/v3  (uploads, mod files, changelogs)
 * Docs: https://api-docs.nexusmods.com
 *
 * Everything transport related lives here (never in the tool layer):
 *  - authentication headers
 *  - request timeout + retry on transient failures
 *  - rate-limit tracking (merged, because v2/GraphQL does not return `x-rl-*` headers)
 *  - short-lived response cache, so repeated agent calls do not burn the quota
 */
import { createHash } from "node:crypto";

const V1_BASE = "https://api.nexusmods.com/v1";
const V2_GRAPHQL = "https://api.nexusmods.com/v2/graphql";
const V3_BASE = "https://api.nexusmods.com/v3";

/** Every v3 endpoint wraps its payload in a `data` envelope. */
export type V3Envelope<T> = { data: T };

export interface RateLimitSnapshot {
  hourlyLimit: number | null;
  hourlyRemaining: number | null;
  hourlyReset: string | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  dailyReset: string | null;
  /** ISO date of the response that produced this snapshot. */
  capturedAt: string;
}

export interface ClientStats {
  httpRequests: number;
  cacheHits: number;
  cacheEntries: number;
  retries: number;
  startedAt: string;
}

export class NexusApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly rateLimit: RateLimitSnapshot | null,
  ) {
    super(message);
    this.name = "NexusApiError";
  }
}

export interface NexusClientOptions {
  apiKey: string;
  oauthToken?: string;
  userAgent: string;
  allowWrites: boolean;
  /** Time-to-live of the in-memory read cache, in milliseconds (default 5 min). */
  cacheTtlMs?: number;
  /** Per-request timeout in milliseconds (default 20 s). */
  timeoutMs?: number;
  /** Retries for network errors and 5xx responses (default 2). */
  maxRetries?: number;
}

export type V3Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Query = Record<string, string | number | boolean | undefined | null>;

export interface CallOptions {
  query?: Query;
  body?: unknown;
  /** Force cache usage on/off. Defaults to `true` for GET requests. */
  cache?: boolean;
  /** Override the cache TTL for this call. */
  cacheTtlMs?: number;
  /** Bypass the cache and store the fresh response. */
  refresh?: boolean;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * v1 answers with `{ message }`, v3 with RFC 9457 `application/problem+json`
 * (`title` / `detail`, plus a per-field `errors` array on 422).
 */
function describeErrorBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const payload = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "detail", "title"]) {
    const value = payload[key];
    if (typeof value === "string" && value && !parts.includes(value)) parts.push(value);
  }
  if (Array.isArray(payload.errors)) {
    const fields = payload.errors
      .map((item) => {
        if (typeof item !== "object" || item === null) return String(item);
        const entry = item as Record<string, unknown>;
        return `${entry.pointer ?? "?"}: ${entry.detail ?? "invalid"}`;
      })
      .slice(0, 10);
    if (fields.length) parts.push(fields.join("; "));
  }
  return parts.length ? parts.join(" - ") : null;
}

export class NexusClient {
  private lastRateLimit: RateLimitSnapshot | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly counters = {
    httpRequests: 0,
    cacheHits: 0,
    retries: 0,
    startedAt: new Date().toISOString(),
  };

  constructor(private readonly options: NexusClientOptions) {}

  get rateLimit(): RateLimitSnapshot | null {
    return this.lastRateLimit;
  }

  get writesAllowed(): boolean {
    return this.options.allowWrites;
  }

  get userAgent(): string {
    return this.options.userAgent;
  }

  get stats(): ClientStats {
    return {
      httpRequests: this.counters.httpRequests,
      cacheHits: this.counters.cacheHits,
      cacheEntries: this.cache.size,
      retries: this.counters.retries,
      startedAt: this.counters.startedAt,
    };
  }

  clearCache(): number {
    const size = this.cache.size;
    this.cache.clear();
    return size;
  }

  /** REST call against the v1 API. */
  async v1<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: CallOptions = {},
  ): Promise<T> {
    if (method !== "GET") this.assertWritesAllowed(`${method} ${path}`);

    const url = new URL(`${V1_BASE}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const cacheable = method === "GET" && (init.cache ?? true);
    const cacheKey = cacheable ? `v1:${url.toString()}` : null;
    if (cacheKey && !init.refresh) {
      const hit = this.readCache<T>(cacheKey);
      if (hit !== undefined) return hit;
    }

    const response = await this.fetchWithRetry(
      url,
      {
        method,
        headers: {
          apikey: this.options.apiKey,
          accept: "application/json",
          "user-agent": this.options.userAgent,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      },
      `${method} ${url.pathname}`,
    );

    const data = await this.parse<T>(response, `${method} ${url.pathname}`);
    if (cacheKey) this.writeCache(cacheKey, data, init.cacheTtlMs);
    // A write may invalidate cached reads.
    if (method !== "GET") this.cache.clear();
    return data;
  }

  /**
   * REST call against the v3 API (uploads, mod files, changelogs).
   * Returns the raw body, so callers keep access to the `data` envelope and `meta`.
   */
  async v3<T = unknown>(method: V3Method, path: string, init: CallOptions = {}): Promise<T> {
    if (method !== "GET") this.assertWritesAllowed(`${method} /v3${path}`);

    const url = new URL(`${V3_BASE}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const cacheable = method === "GET" && (init.cache ?? true);
    const cacheKey = cacheable ? `v3:${url.toString()}` : null;
    if (cacheKey && !init.refresh) {
      const hit = this.readCache<T>(cacheKey);
      if (hit !== undefined) return hit;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.options.userAgent,
    };
    if (this.options.oauthToken) headers.authorization = `Bearer ${this.options.oauthToken}`;
    else headers.apikey = this.options.apiKey;
    if (init.body !== undefined) headers["content-type"] = "application/json";

    const response = await this.fetchWithRetry(
      url,
      {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      `${method} /v3${url.pathname.replace("/v3", "")}`,
    );

    const data = await this.parse<T>(response, `${method} ${url.pathname}`);
    if (cacheKey) this.writeCache(cacheKey, data, init.cacheTtlMs);
    if (method !== "GET") this.cache.clear();
    return data;
  }

  /** GraphQL query against the v2 API. */
  async graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    init: { cache?: boolean; cacheTtlMs?: number; refresh?: boolean } = {},
  ): Promise<T> {
    const isMutation = /\bmutation\b/i.test(query);
    const cacheable = (init.cache ?? true) && !isMutation;
    const cacheKey = cacheable
      ? `v2:${createHash("sha1")
          .update(`${query}|${JSON.stringify(variables ?? {})}`)
          .digest("hex")}`
      : null;
    if (cacheKey && !init.refresh) {
      const hit = this.readCache<T>(cacheKey);
      if (hit !== undefined) return hit;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": this.options.userAgent,
    };
    if (this.options.oauthToken) headers.authorization = `Bearer ${this.options.oauthToken}`;
    else headers.apikey = this.options.apiKey;

    const response = await this.fetchWithRetry(
      V2_GRAPHQL,
      { method: "POST", headers, body: JSON.stringify({ query, variables: variables ?? {} }) },
      "POST /v2/graphql",
    );

    const payload = await this.parse<{ data?: T; errors?: unknown[] }>(response, "POST /v2/graphql");
    if (payload.errors?.length) {
      throw new NexusApiError(
        `GraphQL returned errors: ${JSON.stringify(payload.errors)}`,
        response.status,
        payload,
        this.lastRateLimit,
      );
    }

    const data = payload.data as T;
    if (cacheKey) this.writeCache(cacheKey, data, init.cacheTtlMs);
    if (isMutation) this.cache.clear();
    return data;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                        */
  /* ---------------------------------------------------------------- */

  private assertWritesAllowed(action: string): void {
    if (!this.options.allowWrites) {
      throw new Error(
        `Write operation refused (${action}). Set NEXUS_ALLOW_WRITES=true to enable it.`,
      );
    }
  }

  private readCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.counters.cacheHits += 1;
    return entry.value as T;
  }

  private writeCache(key: string, value: unknown, ttlMs?: number): void {
    const ttl = ttlMs ?? this.options.cacheTtlMs ?? 300_000;
    if (ttl <= 0) return;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
    // Cheap bound so a long session cannot grow the cache indefinitely.
    if (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private async fetchWithRetry(
    url: URL | string,
    init: RequestInit,
    label: string,
  ): Promise<Response> {
    const maxRetries = this.options.maxRetries ?? 2;
    const timeoutMs = this.options.timeoutMs ?? 20_000;
    let lastResponse: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        this.counters.httpRequests += 1;
        this.captureRateLimit(response.headers);
        // Retry server-side hiccups only; 4xx are deterministic and must surface immediately.
        if (response.status >= 500 && attempt < maxRetries) {
          lastResponse = response;
          this.counters.retries += 1;
          await sleep(400 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) break;
        this.counters.retries += 1;
        await sleep(400 * 2 ** attempt);
      }
    }

    if (lastResponse) return lastResponse;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    const hint = /timeout|abort/i.test(reason)
      ? ` (no answer within ${timeoutMs} ms - Nexus may be slow, retry later)`
      : " (network failure - check connectivity/proxy)";
    throw new NexusApiError(`${label} -> ${reason}${hint}`, 0, null, this.lastRateLimit);
  }

  private async parse<T>(response: Response, label: string): Promise<T> {
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON response: keep the raw text */
    }

    if (!response.ok) {
      const detail = describeErrorBody(body) ?? String(raw).slice(0, 500);
      throw new NexusApiError(
        `${label} -> HTTP ${response.status}${this.describeStatus(response.status)}: ${detail}`,
        response.status,
        body,
        this.lastRateLimit,
      );
    }
    return body as T;
  }

  private describeStatus(status: number): string {
    switch (status) {
      case 401:
        return " (missing or invalid API key - run nexus_validate_user)";
      case 403:
        return " (forbidden - Premium-only endpoint, or you are not an author of this mod)";
      case 404:
        return " (not found - check game_domain_name and mod_id, or the mod is hidden/deleted)";
      case 422:
        return " (payload rejected - check the field constraints reported below)";
      case 429: {
        const reset = this.lastRateLimit?.hourlyReset ?? this.lastRateLimit?.dailyReset;
        return ` (Nexus quota exhausted${reset ? `, resets at ${reset}` : ""} - stop polling and reuse cached data)`;
      }
      default:
        return status >= 500 ? " (Nexus server error, already retried)" : "";
    }
  }

  private captureRateLimit(headers: Headers): void {
    const num = (name: string): number | null => {
      const value = headers.get(name);
      return value === null || value === "" ? null : Number(value);
    };
    const snapshot = {
      hourlyLimit: num("x-rl-hourly-limit"),
      hourlyRemaining: num("x-rl-hourly-remaining"),
      hourlyReset: headers.get("x-rl-hourly-reset"),
      dailyLimit: num("x-rl-daily-limit"),
      dailyRemaining: num("x-rl-daily-remaining"),
      dailyReset: headers.get("x-rl-daily-reset"),
    };

    // The v2/GraphQL endpoint does not emit `x-rl-*` headers: keep the last known
    // snapshot instead of overwriting it with nulls (which used to display "?/?").
    if (!Object.values(snapshot).some((value) => value !== null)) return;

    this.lastRateLimit = { ...snapshot, capturedAt: new Date().toISOString() };
  }
}

