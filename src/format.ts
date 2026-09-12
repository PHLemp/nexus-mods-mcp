/**
 * Presentation layer: turns raw Nexus payloads into compact, agent-friendly results.
 *
 * Why it matters: the raw v1 payloads carry BBCode descriptions, archived files and a full
 * `file_updates` history. Feeding all of that to a model wastes context and pushes it to make
 * follow-up calls. Everything here trims noise while keeping the identifiers an agent needs.
 */
import type { NexusClient } from "./nexus-client.js";
import { NexusApiError } from "./nexus-client.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Hard cap on a single tool result, to protect the model context window. */
export const MAX_CHARS = 45_000;

export function modUrl(domain: string, modId: number | string): string {
  return `https://www.nexusmods.com/${domain}/mods/${modId}`;
}

/** Removes HTML and BBCode markup used by Nexus descriptions/changelogs. */
export function stripMarkup(input?: string | null): string {
  if (!input) return "";
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|li|ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\[\*]/g, "\n- ")
    .replace(/\[\/\*]/g, "")
    .replace(
      /\[\/?(?:b|i|u|s|url|img|size|color|font|center|left|right|quote|spoiler|list|code|youtube|line)[^\]]*]/gi,
      "",
    )
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\uFEFF/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}... [truncated]`;
}

/** Drops undefined/null/empty-string keys so the JSON stays small. */
export function prune<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === "") continue;
    out[key] = item;
  }
  return out as Partial<T>;
}

/** Newest first, tolerant to prefixes like `v1.2.3` or `2.0.0-beta`. */
export function compareVersionsDesc(a: string, b: string): number {
  const parse = (value: string): number[] => (value.match(/\d+/g) ?? []).map(Number);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return b.localeCompare(a);
}

/** Works with both the v1 REST shape (snake_case) and the v2 GraphQL shape (camelCase). */
export function compactMod(mod: Record<string, any>, fallbackDomain?: string): Record<string, unknown> {
  const domain: string | undefined = mod.domain_name ?? mod.game?.domainName ?? fallbackDomain;
  const modId: number | undefined = mod.mod_id ?? mod.modId;
  return prune({
    mod_id: modId,
    name: mod.name,
    version: mod.version,
    author: mod.author,
    uploaded_by: mod.uploaded_by ?? mod.uploader?.name,
    status: mod.status,
    category: mod.category_name ?? mod.modCategory?.name,
    summary: truncate(stripMarkup(mod.summary), 280),
    downloads: mod.mod_downloads ?? mod.downloads,
    unique_downloads: mod.mod_unique_downloads ?? mod.uniqueDownloads,
    endorsements: mod.endorsement_count ?? mod.endorsements,
    created: mod.created_time ?? mod.createdAt,
    updated: mod.updated_time ?? mod.updatedAt,
    adult: mod.contains_adult_content ?? mod.adultContent ? true : undefined,
    game: domain,
    url: domain && modId !== undefined ? modUrl(domain, modId) : undefined,
  });
}

export function compactFile(file: Record<string, any>): Record<string, unknown> {
  return prune({
    file_id: file.file_id,
    name: file.name,
    version: file.mod_version ?? file.version,
    category: file.category_name,
    is_primary: file.is_primary ? true : undefined,
    size_kb: file.size_kb ?? file.size,
    uploaded: file.uploaded_time,
    file_name: file.file_name,
    notes: truncate(stripMarkup(file.changelog_html ?? file.description), 400),
  });
}

/** `ok` / `fail` / `run` bound to a client, so every answer can report the live quota. */
export function createResponders(client: NexusClient) {
  const footer = (): string => {
    const rl = client.rateLimit;
    const stats = client.stats;
    const parts: string[] = [];
    if (rl) {
      const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(rl.capturedAt)) / 1000));
      parts.push(
        `quota hourly ${rl.hourlyRemaining ?? "?"}/${rl.hourlyLimit ?? "?"}, daily ${rl.dailyRemaining ?? "?"}/${rl.dailyLimit ?? "?"}` +
          (ageSeconds > 90 ? ` (measured ${ageSeconds}s ago)` : ""),
      );
    }
    parts.push(`http ${stats.httpRequests}`, `cache hits ${stats.cacheHits}`);
    return `\n\n[nexus] ${parts.join(" | ")}`;
  };

  const ok = (data: unknown, note?: string): ToolResult => {
    let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (text.length > MAX_CHARS) {
      text = `${text.slice(0, MAX_CHARS)}\n... [truncated: ${text.length} characters total. Narrow the request (limit, filters, compact=true) instead of retrying as is.]`;
    }
    return { content: [{ type: "text", text: `${note ? `${note}\n\n` : ""}${text}${footer()}` }] };
  };

  const fail = (error: unknown): ToolResult => {
    const message =
      error instanceof NexusApiError || error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}${footer()}` }],
      isError: true,
    };
  };

  const run = async (fn: () => Promise<unknown>, note?: string): Promise<ToolResult> => {
    try {
      return ok(await fn(), note);
    } catch (error) {
      return fail(error);
    }
  };

  return { ok, fail, run };
}


