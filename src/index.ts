#!/usr/bin/env node
/**
 * "nexus-mods" MCP server (stdio transport).
 * Exposes the Nexus Mods API (v1 REST + v2 GraphQL + v3 REST) as tools for an AI agent.
 *
 * Design goal: answer a question in as few tool calls as possible.
 *  - nexus_find_mods      -> name  ->  mod_id (no GraphQL introspection needed)
 *  - nexus_mod_overview   -> mod_id -> metadata + files + changelogs in ONE call
 *  - nexus_list_author_mods -> whole catalogue of an author in ONE call
 *  - nexus_upload_mod_file -> local archive -> published file/version in ONE call (v3 Upload API)
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  compactFile,
  compactMod,
  compareVersionsDesc,
  createResponders,
  modUrl,
  prune,
  stripMarkup,
  truncate,
} from "./format.js";
import { NexusClient, type V3Envelope } from "./nexus-client.js";
import { GRAPHQL_CHEATSHEET, SEARCH_MODS, SORT_KEYS, buildSort, type SearchModsResult, type SortKey } from "./queries.js";
import {
  SINGLE_PART_LIMIT_BYTES,
  UPLOAD_GUIDE,
  resolveArchivePath,
  uploadArchive,
  validateModFileName,
  validateModFileVersion,
} from "./upload.js";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, "..", ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

const API_KEY = process.env.NEXUS_API_KEY?.trim();
if (!API_KEY) {
  console.error(
    "[nexus-mods-mcp] NEXUS_API_KEY is missing. Set it in the environment or in Tools/nexus-mods-mcp/.env",
  );
  process.exit(1);
}

const SERVER_VERSION = "0.3.0";
const DEFAULT_GAME = process.env.NEXUS_DEFAULT_GAME?.trim() || "mountandblade2bannerlord";
const numberEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

const client = new NexusClient({
  apiKey: API_KEY,
  oauthToken: process.env.NEXUS_OAUTH_TOKEN?.trim() || undefined,
  userAgent: process.env.NEXUS_USER_AGENT?.trim() || `nexus-mods-mcp/${SERVER_VERSION} (Node)`,
  allowWrites: process.env.NEXUS_ALLOW_WRITES === "true",
  cacheTtlMs: numberEnv("NEXUS_CACHE_TTL_SECONDS", 300) * 1000,
  timeoutMs: numberEnv("NEXUS_TIMEOUT_SECONDS", 20) * 1000,
  maxRetries: numberEnv("NEXUS_MAX_RETRIES", 2),
});

/** Publishing is opt-in on top of NEXUS_ALLOW_WRITES: it changes a public mod page. */
const ALLOW_UPLOADS = process.env.NEXUS_ALLOW_UPLOADS === "true";
/** Optional sandbox: archives must live inside this directory to be uploadable. */
const UPLOAD_ROOT = process.env.NEXUS_UPLOAD_ROOT?.trim() || undefined;
const UPLOAD_TIMEOUT_MS = numberEnv("NEXUS_UPLOAD_TIMEOUT_SECONDS", 900) * 1000;

const { run } = createResponders(client);

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const gameArg = z
  .string()
  .optional()
  .describe(`Game domain, e.g. "skyrimspecialedition". Default: "${DEFAULT_GAME}"`);
const game = (value?: string): string => value?.trim() || DEFAULT_GAME;

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const writeOp = { readOnlyHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Categories that are noise for "what is published right now" questions. */
const STALE_CATEGORIES = new Set(["ARCHIVED", "OLD_VERSION"]);

type ValidateResponse = {
  user_id: number;
  name: string;
  is_premium?: boolean;
  is_supporter?: boolean;
};

/** Authenticated profile, cached by the client so it costs at most one request per TTL. */
async function viewer(): Promise<ValidateResponse> {
  return client.v1<ValidateResponse>("GET", "/users/validate.json", { cacheTtlMs: 3_600_000 });
}

function groupFiles(files: Array<Record<string, any>>): Record<string, unknown[]> {
  const grouped: Record<string, unknown[]> = {};
  for (const file of files) {
    const key = String(file.category_name ?? "UNKNOWN");
    (grouped[key] ??= []).push(compactFile(file));
  }
  return grouped;
}

/* ------------------------------------------------------------------ */
/* v3 helpers (upload / publish)                                       */
/* ------------------------------------------------------------------ */

type V3Mod = { id: string; game_scoped_id: string; game_id: string; name?: string | null };
type V3ModFile = {
  id: string;
  name: string;
  is_active?: boolean;
  versions_count?: number;
  archived_count?: number;
  removed_count?: number;
  last_file_uploaded_at?: string | null;
};
type V3ModFileVersion = {
  id: string;
  name: string;
  version: string;
  category: string;
  position: string;
  game_scoped_id: string;
  uploaded_at: string;
  is_primary?: boolean;
};

const FILE_CATEGORIES = ["main", "optional", "miscellaneous"] as const;

function assertUploadsAllowed(): void {
  if (!client.writesAllowed) {
    throw new Error("Write operations are disabled. Set NEXUS_ALLOW_WRITES=true to enable them.");
  }
  if (!ALLOW_UPLOADS) {
    throw new Error(
      "Publishing is disabled. Set NEXUS_ALLOW_UPLOADS=true to let this server upload files to Nexus.",
    );
  }
}

/**
 * v3 addresses mods by an internal id, not by the number in the page URL.
 * Cached for 10 minutes: it never changes for a given mod.
 */
async function resolveMod(domain: string, modId: number, refresh?: boolean): Promise<V3Mod> {
  const { data } = await client.v3<V3Envelope<V3Mod>>("GET", `/games/${domain}/mods/${modId}`, {
    refresh,
    cacheTtlMs: 600_000,
  });
  return data;
}

type PublishInput = {
  upload_id: string;
  name: string;
  version: string;
  file_category: (typeof FILE_CATEGORIES)[number];
  description?: string;
  primary_mod_manager_download?: boolean;
  allow_mod_manager_download?: boolean;
  show_requirements_pop_up?: boolean;
  update_mod_version?: boolean;
  archive_existing_file?: boolean;
  previous_version_id?: string;
};

/**
 * Turns a finalised upload into something visible on the mod page:
 * a brand new file, or a new version appended to an existing file's update chain.
 */
async function publishUpload(
  input: PublishInput & { mod_file_id?: string; mod_uid?: string },
): Promise<Record<string, unknown>> {
  validateModFileName(input.name);
  validateModFileVersion(input.version);

  const shared = prune({
    upload_id: input.upload_id,
    name: input.name,
    version: input.version,
    file_category: input.file_category,
    description: input.description,
    primary_mod_manager_download: input.primary_mod_manager_download,
    allow_mod_manager_download: input.allow_mod_manager_download,
    show_requirements_pop_up: input.show_requirements_pop_up,
    update_mod_version: input.update_mod_version,
  });

  if (input.mod_file_id) {
    const { data } = await client.v3<V3Envelope<Record<string, any>>>(
      "POST",
      `/mod-files/${input.mod_file_id}/versions`,
      {
        body: prune({
          ...shared,
          archive_existing_file: input.archive_existing_file,
          previous_version_id: input.previous_version_id,
        }),
        cache: false,
      },
    );
    return {
      action: "new_version",
      mod_file_id: data.file?.id ?? input.mod_file_id,
      mod_file_name: data.file?.name,
      version_id: data.version?.id,
      position: data.version?.position,
    };
  }

  if (!input.mod_uid) throw new Error("mod_file_id or a resolvable mod is required to publish.");
  const { data } = await client.v3<V3Envelope<Record<string, any>>>("POST", "/mod-files", {
    body: { ...shared, mod_id: input.mod_uid },
    cache: false,
  });
  return {
    action: "new_file",
    mod_file_id: data.id,
    mod_file_name: data.name,
    game_scoped_id: data.game_scoped_id,
    file_category: data.file_category,
  };
}


/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "nexus-mods", version: SERVER_VERSION },
  {
    instructions: [
      "Nexus Mods API server (v1 REST + v2 GraphQL + v3 REST/Upload API).",
      "",
      "Pick the tool that answers the question in a single call:",
      "1. You only know a mod NAME -> nexus_find_mods (returns mod_id + stats). Never introspect GraphQL for this.",
      "2. You know the mod_id -> nexus_mod_overview (metadata + published files + recent changelogs + page URL).",
      "3. You want everything published by an author, or 'my mods' -> nexus_list_author_mods.",
      "4. Trends / recent releases for a game -> nexus_list_mods.",
      "5. Unknown local archive -> nexus_search_md5.",
      "nexus_get_mod, nexus_get_mod_files and nexus_get_mod_changelogs are narrow follow-ups; do not chain them when nexus_mod_overview already returns the answer.",
      "nexus_graphql is a last-resort escape hatch: read the nexus://graphql-cheatsheet resource first, the schema is documented there.",
      "",
      "Publishing (v3 Upload API, read nexus://upload-guide before the first call):",
      "- Releasing a new version of an existing file -> nexus_mod_file_targets (get the mod_file_id) then nexus_upload_mod_file with that mod_file_id.",
      "- Adding a brand new file to a mod page -> nexus_upload_mod_file without mod_file_id.",
      "- nexus_upload_mod_file uploads AND publishes in one call; use dry_run=true first to check the plan.",
      "- If an upload finished but publishing failed, do NOT re-upload: reuse the upload_id with nexus_publish_upload.",
      "- Uploads need NEXUS_ALLOW_WRITES=true and NEXUS_ALLOW_UPLOADS=true; the archive must already exist on disk.",
      "",
      `Default game domain: ${DEFAULT_GAME} (omit game_domain_name to use it).`,
      "Responses are compacted and every reply ends with the remaining Nexus quota. Reads are cached for a few minutes: re-calling the same tool is cheap, but pass refresh=true when you need fresh data after an upload.",
    ].join("\n"),
  },
);

/* ------------------------------ Account --------------------------- */

server.registerTool(
  "nexus_validate_user",
  {
    title: "Validate API key",
    description:
      "Validate the Nexus API key and return the profile (name, user id, premium/supporter status). Call this first when authentication looks broken, or to learn the current user before nexus_list_author_mods.",
    inputSchema: {
      refresh: z.boolean().optional().describe("Bypass the cache and re-query Nexus"),
    },
    annotations: readOnly,
  },
  async ({ refresh }) =>
    run(async () => {
      const profile = await client.v1<Record<string, any>>("GET", "/users/validate.json", {
        refresh,
        cacheTtlMs: 3_600_000,
      });
      return prune({
        user_id: profile.user_id,
        name: profile.name,
        is_premium: profile.is_premium,
        is_supporter: profile.is_supporter,
        profile_url: profile.user_id ? `https://www.nexusmods.com/users/${profile.user_id}` : undefined,
        note: profile.is_premium
          ? undefined
          : "Not Premium: nexus_get_download_link needs an nxm_key/expires pair.",
      });
    }),
);

server.registerTool(
  "nexus_rate_limit_status",
  {
    title: "Quota and server status",
    description:
      "Return the remaining Nexus quota (hourly/daily) plus this server's request and cache counters. Free of charge unless refresh=true. Use it before a batch of calls, or to decide whether to back off after an HTTP 429.",
    inputSchema: {
      refresh: z.boolean().optional().describe("Force a lightweight network call to refresh the quota"),
      clear_cache: z.boolean().optional().describe("Drop the in-memory read cache"),
    },
    annotations: { ...readOnly, readOnlyHint: false, idempotentHint: true },
  },
  async ({ refresh, clear_cache }) =>
    run(async () => {
      const cleared = clear_cache ? client.clearCache() : 0;
      if (refresh || !client.rateLimit) {
        await client.v1("GET", "/users/validate.json", { refresh: true, cacheTtlMs: 3_600_000 });
      }
      return prune({
        rate_limit: client.rateLimit ?? "no call made yet",
        stats: client.stats,
        cache_entries_cleared: clear_cache ? cleared : undefined,
        writes_allowed: client.writesAllowed,
        default_game: DEFAULT_GAME,
      });
    }),
);

/* ------------------------------ Games ----------------------------- */

server.registerTool(
  "nexus_list_games",
  {
    title: "List games",
    description:
      "List the games supported by Nexus Mods. Always pass 'filter' (case-insensitive, matches name or domain): the unfiltered catalogue has 2000+ entries. Use it to resolve a game domain before any other tool.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive match on the name or domain"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 25)"),
    },
    annotations: readOnly,
  },
  async ({ filter, limit }) =>
    run(async () => {
      // The games catalogue is huge and almost static: cache it for an hour.
      const games = (await client.v1<any[]>("GET", "/games.json", { cacheTtlMs: 3_600_000 })) ?? [];
      const needle = filter?.toLowerCase();
      const matched = needle
        ? games.filter(
            (entry) =>
              String(entry.name ?? "").toLowerCase().includes(needle) ||
              String(entry.domain_name ?? "").toLowerCase().includes(needle),
          )
        : games;
      return {
        total: games.length,
        matched: matched.length,
        games: matched.slice(0, limit ?? 25).map((entry) => ({
          id: entry.id,
          name: entry.name,
          domain_name: entry.domain_name,
          mods: entry.mods,
          downloads: entry.downloads,
        })),
      };
    }),
);

server.registerTool(
  "nexus_get_game",
  {
    title: "Game details",
    description:
      "Return details for one game, including its category list (category_id values needed when publishing a mod).",
    inputSchema: { game_domain_name: gameArg },
    annotations: readOnly,
  },
  async ({ game_domain_name }) =>
    run(() => client.v1("GET", `/games/${game(game_domain_name)}.json`, { cacheTtlMs: 3_600_000 })),
);

/* ------------------------------ Search ---------------------------- */

server.registerTool(
  "nexus_find_mods",
  {
    title: "Find mods by name",
    description:
      "START HERE when you only know a mod's name/keywords: resolves it to a mod_id with version, author, downloads, endorsements, last update and page URL, in ONE call. Backed by the v2 search index - never write a raw GraphQL search yourself. If the name search finds nothing it automatically retries against mod descriptions, so a single call is normally enough. Follow up with nexus_mod_overview only if you need files or changelogs.",
    inputSchema: {
      query: z.string().optional().describe("Name or keywords, e.g. 'party size'"),
      match: z
        .enum(["name", "exact", "description"])
        .optional()
        .describe(
          "name = full-text on the title (default), exact = strict full title, description = full-text inside mod descriptions (use for 'a mod that does X')",
        ),
      author: z.string().optional().describe("Exact author name as shown on the mod page"),
      uploader: z.string().optional().describe("Exact Nexus account name of the uploader"),
      tag: z.string().optional().describe("Exact tag, e.g. 'Gameplay'"),
      category: z.string().optional().describe("Exact category name, e.g. 'Gameplay Changes'"),
      updated_since: z
        .string()
        .optional()
        .describe("ISO date (YYYY-MM-DD); keeps mods updated on or after it"),
      include_adult: z.boolean().optional().describe("Include adult content (default false)"),
      sort: z
        .enum(SORT_KEYS as [SortKey, ...SortKey[]])
        .optional()
        .describe("relevance (default when searching) | downloads | endorsements | updatedAt | createdAt | name | ..."),
      direction: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default DESC)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
      game_domain_name: gameArg,
      all_games: z.boolean().optional().describe("Search every game instead of a single domain"),
    },
    annotations: readOnly,
  },
  async (args) =>
    run(async () => {
      const domain = game(args.game_domain_name);
      const query = args.query?.trim();
      const match = args.match ?? "name";

      const baseFilter: Record<string, unknown> = {};
      if (!args.all_games) baseFilter.gameDomainName = [{ value: domain, op: "EQUALS" }];
      if (args.author) baseFilter.author = [{ value: args.author, op: "EQUALS" }];
      if (args.uploader) baseFilter.uploader = [{ value: args.uploader, op: "EQUALS" }];
      if (args.tag) baseFilter.tag = [{ value: args.tag, op: "EQUALS" }];
      if (args.category) baseFilter.categoryName = [{ value: args.category, op: "EQUALS" }];
      if (args.updated_since) baseFilter.updatedAt = [{ value: args.updated_since, op: "GTE" }];

      const hasCriteria =
        Boolean(query) ||
        Boolean(args.author || args.uploader || args.tag || args.category || args.updated_since);
      if (!hasCriteria) {
        throw new Error(
          "Provide at least one criterion (query, author, uploader, tag, category or updated_since).",
        );
      }

      // adultContent is a BooleanFilterValue: the value must be a real boolean, not a string.
      if (!args.include_adult) baseFilter.adultContent = [{ value: false, op: "EQUALS" }];

      const withQuery = (mode: "name" | "exact" | "description"): Record<string, unknown> => {
        const filter = { ...baseFilter };
        if (!query) return filter;
        if (mode === "exact") filter.name = [{ value: query, op: "EQUALS" }];
        else if (mode === "description") filter.description = [{ value: query, op: "MATCHES" }];
        else filter.nameStemmed = [{ value: query }];
        return filter;
      };

      const sortKey: SortKey = args.sort ?? (query ? "relevance" : "updatedAt");
      const sort = buildSort(sortKey, args.direction ?? (sortKey === "name" ? "ASC" : "DESC"));
      const count = args.limit ?? 10;
      const offset = args.offset ?? 0;

      let usedMatch = match;
      let data = await client.graphql<SearchModsResult>(SEARCH_MODS, {
        filter: withQuery(match),
        sort,
        count,
        offset,
      });

      // Saves the agent a second round-trip when the title search comes back empty.
      if ((data.mods?.totalCount ?? 0) === 0 && query && match === "name") {
        usedMatch = "description";
        data = await client.graphql<SearchModsResult>(SEARCH_MODS, {
          filter: withQuery("description"),
          sort,
          count,
          offset,
        });
      }

      const nodes = data.mods?.nodes ?? [];
      return prune({
        total_matches: data.mods?.totalCount ?? 0,
        returned: nodes.length,
        matched_on: usedMatch === "description" ? "mod description" : "mod title",
        fallback_used: usedMatch !== match ? `no title match, retried on ${usedMatch}` : undefined,
        sorted_by: `${sortKey} ${args.direction ?? "DESC"}`,
        scope: args.all_games ? "all games" : domain,
        mods: nodes.map((node) => compactMod(node, domain)),
        next_step:
          nodes.length > 0
            ? "Call nexus_mod_overview with the mod_id for files and changelogs."
            : "No match: try fewer keywords, all_games=true, or match='description'.",
      });
    }),
);

server.registerTool(
  "nexus_list_author_mods",
  {
    title: "Mods of an author",
    description:
      "List every mod published by a Nexus account, newest update first, in ONE call. With no argument it uses the authenticated account ('my mods'). Ideal for 'how are my mods doing?' - returns downloads, endorsements, version and last update for each mod.",
    inputSchema: {
      uploader: z.string().optional().describe("Nexus account name; defaults to the authenticated user"),
      user_id: z.number().int().positive().optional().describe("Numeric member id (takes precedence)"),
      game_domain_name: gameArg,
      all_games: z.boolean().optional().describe("Do not restrict to a single game (default true)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 25)"),
    },
    annotations: readOnly,
  },
  async ({ uploader, user_id, game_domain_name, all_games, limit }) =>
    run(async () => {
      const filter: Record<string, unknown> = {};
      let subject: string;

      if (user_id) {
        filter.uploaderId = [{ value: String(user_id), op: "EQUALS" }];
        subject = `member ${user_id}`;
      } else if (uploader) {
        filter.uploader = [{ value: uploader, op: "EQUALS" }];
        subject = uploader;
      } else {
        const profile = await viewer();
        filter.uploaderId = [{ value: String(profile.user_id), op: "EQUALS" }];
        subject = `${profile.name} (authenticated user)`;
      }

      const restrict = all_games === false;
      const domain = game(game_domain_name);
      if (restrict) filter.gameDomainName = [{ value: domain, op: "EQUALS" }];

      const data = await client.graphql<SearchModsResult>(SEARCH_MODS, {
        filter,
        sort: buildSort("updatedAt", "DESC"),
        count: limit ?? 25,
      });

      const nodes = data.mods?.nodes ?? [];
      const totals = nodes.reduce(
        (acc, node) => ({
          downloads: acc.downloads + (Number(node.downloads) || 0),
          endorsements: acc.endorsements + (Number(node.endorsements) || 0),
        }),
        { downloads: 0, endorsements: 0 },
      );

      return {
        author: subject,
        scope: restrict ? domain : "all games",
        total_matches: data.mods?.totalCount ?? 0,
        returned: nodes.length,
        totals,
        mods: nodes.map((node) => compactMod(node)),
      };
    }),
);

/* ------------------------------ Mods ------------------------------ */

server.registerTool(
  "nexus_mod_overview",
  {
    title: "Full mod report (one call)",
    description:
      "ONE-CALL mod report: metadata, currently published files grouped by category, recent changelogs and the page URL. Prefer this over chaining nexus_get_mod + nexus_get_mod_files + nexus_get_mod_changelogs. Archived/old files and the upload history are hidden unless you ask for them.",
    inputSchema: {
      mod_id: z.number().int().positive().describe("Numeric mod id (visible in the page URL)"),
      game_domain_name: gameArg,
      description: z
        .enum(["summary", "full", "none"])
        .optional()
        .describe("Amount of page description to include (default summary, markup stripped)"),
      changelog_versions: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("Number of recent versions to include (default 3, 0 to skip)"),
      include_old_files: z
        .boolean()
        .optional()
        .describe("Include ARCHIVED/OLD_VERSION files (default false)"),
      refresh: z.boolean().optional().describe("Bypass the cache (use after an upload)"),
    },
    annotations: readOnly,
  },
  async ({ mod_id, game_domain_name, description, changelog_versions, include_old_files, refresh }) =>
    run(async () => {
      const domain = game(game_domain_name);
      const base = `/games/${domain}/mods/${mod_id}`;
      const wantChangelogs = (changelog_versions ?? 3) > 0;

      const [mod, filesPayload, changelogs] = await Promise.all([
        client.v1<Record<string, any>>("GET", `${base}.json`, { refresh }),
        client.v1<Record<string, any>>("GET", `${base}/files.json`, { refresh }),
        wantChangelogs
          ? client
              .v1<Record<string, string[]>>("GET", `${base}/changelogs.json`, { refresh })
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const allFiles: Array<Record<string, any>> = filesPayload?.files ?? [];
      const visible = include_old_files
        ? allFiles
        : allFiles.filter((file) => !STALE_CATEGORIES.has(String(file.category_name)));
      const primary = allFiles.find((file) => file.is_primary) ?? null;

      const descriptionText = stripMarkup(mod.description);
      const descriptionMode = description ?? "summary";

      let recentChangelogs: Record<string, string[]> | undefined;
      if (changelogs && wantChangelogs) {
        const keep = Object.keys(changelogs)
          .sort(compareVersionsDesc)
          .slice(0, changelog_versions ?? 3);
        recentChangelogs = Object.fromEntries(
          keep.map((version) => [
            version,
            (changelogs[version] ?? []).map((line) => stripMarkup(line)).filter(Boolean),
          ]),
        );
      }

      return prune({
        mod: compactMod(mod, domain),
        description:
          descriptionMode === "none"
            ? undefined
            : descriptionMode === "full"
              ? descriptionText
              : truncate(descriptionText, 1200),
        primary_file: primary ? compactFile(primary) : undefined,
        files: groupFiles(visible),
        file_counts: {
          total: allFiles.length,
          shown: visible.length,
          hidden_old_or_archived: allFiles.length - visible.length,
        },
        recent_changelogs: recentChangelogs,
        page_url: modUrl(domain, mod_id),
        hints: prune({
          old_files: include_old_files
            ? undefined
            : "Set include_old_files=true to see ARCHIVED/OLD_VERSION entries.",
          changelogs:
            wantChangelogs && !changelogs ? "This mod has no changelog endpoint." : undefined,
        }),
      });
    }),
);

server.registerTool(
  "nexus_get_mod",
  {
    title: "Mod metadata",
    description:
      "Raw metadata for a single mod (name, version, author, counters, status). Narrow follow-up tool: if you also need files or changelogs, call nexus_mod_overview instead of chaining calls.",
    inputSchema: {
      mod_id: z.number().int().positive().describe("Numeric mod id (visible in the page URL)"),
      game_domain_name: gameArg,
      compact: z.boolean().optional().describe("Trim the payload (default true)"),
      refresh: z.boolean().optional().describe("Bypass the cache"),
    },
    annotations: readOnly,
  },
  async ({ mod_id, game_domain_name, compact, refresh }) =>
    run(async () => {
      const domain = game(game_domain_name);
      const mod = await client.v1<Record<string, any>>("GET", `/games/${domain}/mods/${mod_id}.json`, {
        refresh,
      });
      return compact === false ? mod : compactMod(mod, domain);
    }),
);

server.registerTool(
  "nexus_get_mod_files",
  {
    title: "Mod files",
    description:
      "List the files published for a mod. By default archived/old versions and the upload history are filtered out. Pass file_id for a single file. For a complete picture (metadata + files + changelogs) prefer nexus_mod_overview.",
    inputSchema: {
      mod_id: z.number().int().positive(),
      game_domain_name: gameArg,
      category: z
        .string()
        .optional()
        .describe("Nexus filter, e.g. 'main,update' or 'old_version'"),
      file_id: z.number().int().positive().optional().describe("Details of one specific file"),
      include_old: z.boolean().optional().describe("Include ARCHIVED/OLD_VERSION (default false)"),
      include_history: z
        .boolean()
        .optional()
        .describe("Include the file_updates replacement history (default false, very verbose)"),
      compact: z.boolean().optional().describe("Trim each file entry (default true)"),
      refresh: z.boolean().optional().describe("Bypass the cache"),
    },
    annotations: readOnly,
  },
  async ({ mod_id, game_domain_name, category, file_id, include_old, include_history, compact, refresh }) =>
    run(async () => {
      const base = `/games/${game(game_domain_name)}/mods/${mod_id}/files`;
      if (file_id) {
        const file = await client.v1<Record<string, any>>("GET", `${base}/${file_id}.json`, { refresh });
        return compact === false ? file : compactFile(file);
      }

      const payload = await client.v1<Record<string, any>>("GET", `${base}.json`, {
        query: { category },
        refresh,
      });
      const files: Array<Record<string, any>> = payload?.files ?? [];
      const visible = include_old
        ? files
        : files.filter((file) => !STALE_CATEGORIES.has(String(file.category_name)));

      return prune({
        counts: { total: files.length, shown: visible.length },
        files: visible.map((file) => (compact === false ? file : compactFile(file))),
        file_updates: include_history ? payload?.file_updates : undefined,
      });
    }),
);

server.registerTool(
  "nexus_get_mod_changelogs",
  {
    title: "Mod changelogs",
    description:
      "Per-version changelogs for a mod, newest first. Narrow follow-up tool: nexus_mod_overview already returns the most recent versions.",
    inputSchema: {
      mod_id: z.number().int().positive(),
      game_domain_name: gameArg,
      versions: z.number().int().min(1).max(50).optional().describe("How many versions to keep (default 10)"),
      refresh: z.boolean().optional().describe("Bypass the cache"),
    },
    annotations: readOnly,
  },
  async ({ mod_id, game_domain_name, versions, refresh }) =>
    run(async () => {
      const changelogs = await client.v1<Record<string, string[]>>(
        "GET",
        `/games/${game(game_domain_name)}/mods/${mod_id}/changelogs.json`,
        { refresh },
      );
      const keep = Object.keys(changelogs ?? {})
        .sort(compareVersionsDesc)
        .slice(0, versions ?? 10);
      return Object.fromEntries(
        keep.map((version) => [
          version,
          (changelogs[version] ?? []).map((line) => stripMarkup(line)).filter(Boolean),
        ]),
      );
    }),
);

server.registerTool(
  "nexus_list_mods",
  {
    title: "Recent / trending mods",
    description:
      "Browse a game's feeds: latest_added, latest_updated, trending, or updated (needs period=1d|1w|1m). Use it for discovery; to look for a specific mod use nexus_find_mods instead.",
    inputSchema: {
      feed: z.enum(["latest_added", "latest_updated", "trending", "updated"]),
      game_domain_name: gameArg,
      period: z.enum(["1d", "1w", "1m"]).optional().describe("Required for feed=updated"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 15)"),
      compact: z.boolean().optional().describe("Trim each entry (default true)"),
    },
    annotations: readOnly,
  },
  async ({ feed, game_domain_name, period, limit, compact }) =>
    run(async () => {
      const domain = game(game_domain_name);
      const path =
        feed === "updated"
          ? `/games/${domain}/mods/updated.json`
          : `/games/${domain}/mods/${feed}.json`;
      const mods =
        (await client.v1<any[]>("GET", path, {
          query: feed === "updated" ? { period: period ?? "1d" } : undefined,
          cacheTtlMs: 120_000,
        })) ?? [];
      const sliced = mods.slice(0, limit ?? 15);
      return {
        feed,
        game: domain,
        returned: sliced.length,
        of: mods.length,
        mods: sliced.map((mod) => (compact === false ? mod : compactMod(mod, domain))),
      };
    }),
);

server.registerTool(
  "nexus_search_md5",
  {
    title: "Identify a file by MD5",
    description:
      "Resolve an MD5 hash to its Nexus mod and file: the reliable way to identify an unknown local archive.",
    inputSchema: {
      md5_hash: z.string().length(32).describe("32 hexadecimal characters"),
      game_domain_name: gameArg,
    },
    annotations: readOnly,
  },
  async ({ md5_hash, game_domain_name }) =>
    run(() =>
      client.v1("GET", `/games/${game(game_domain_name)}/mods/md5_search/${md5_hash}.json`),
    ),
);

server.registerTool(
  "nexus_get_download_link",
  {
    title: "Download link",
    description:
      "Generate a download link for a file. Requires a Premium account, unless nxm_key/expires (taken from an nxm:// link) are supplied.",
    inputSchema: {
      mod_id: z.number().int().positive(),
      file_id: z.number().int().positive(),
      game_domain_name: gameArg,
      nxm_key: z.string().optional().describe("key parameter of an nxm:// link"),
      expires: z.number().int().optional().describe("expires parameter of an nxm:// link"),
    },
    annotations: readOnly,
  },
  async ({ mod_id, file_id, game_domain_name, nxm_key, expires }) =>
    run(() =>
      client.v1(
        "GET",
        `/games/${game(game_domain_name)}/mods/${mod_id}/files/${file_id}/download_link.json`,
        { query: { key: nxm_key, expires }, cache: false },
      ),
    ),
);

/* ------------------------------ User actions ---------------------- */

server.registerTool(
  "nexus_tracked_mods",
  {
    title: "Tracked mods",
    description:
      "Manage the mods tracked by the authenticated user. action=list is read-only; track/untrack are writes and require NEXUS_ALLOW_WRITES=true.",
    inputSchema: {
      action: z.enum(["list", "track", "untrack"]),
      mod_id: z.number().int().positive().optional().describe("Required for track/untrack"),
      game_domain_name: gameArg,
    },
    annotations: writeOp,
  },
  async ({ action, mod_id, game_domain_name }) =>
    run(() => {
      if (action === "list") return client.v1("GET", "/user/tracked_mods.json", { cacheTtlMs: 60_000 });
      if (!mod_id) throw new Error("mod_id is required for track/untrack.");
      return client.v1(action === "track" ? "POST" : "DELETE", "/user/tracked_mods.json", {
        query: { domain_name: game(game_domain_name) },
        body: { mod_id },
      });
    }),
);

server.registerTool(
  "nexus_endorse_mod",
  {
    title: "Endorse a mod",
    description:
      "Endorse a mod or withdraw the endorsement. Write operation: requires NEXUS_ALLOW_WRITES=true. The version must match the one Nexus knows (nexus_get_mod returns it).",
    inputSchema: {
      mod_id: z.number().int().positive(),
      action: z.enum(["endorse", "abstain"]),
      version: z.string().optional().describe("Mod version, required by the API"),
      game_domain_name: gameArg,
    },
    annotations: writeOp,
  },
  async ({ mod_id, action, version, game_domain_name }) =>
    run(async () => {
      const domain = game(game_domain_name);
      let resolved = version;
      if (!resolved) {
        const mod = await client.v1<Record<string, any>>("GET", `/games/${domain}/mods/${mod_id}.json`);
        resolved = String(mod.version ?? "1.0.0");
      }
      return client.v1("POST", `/games/${domain}/mods/${mod_id}/${action}.json`, {
        body: { version: resolved },
      });
    }),
);

/* ------------------------------ Publishing (v3) ------------------- */

server.registerTool(
  "nexus_mod_file_targets",
  {
    title: "Upload targets of a mod",
    description:
      "START HERE before updating a mod: lists the v3 identifiers needed to publish. Returns the internal mod id plus every mod file (the update chain shown on the Files tab) with its mod_file_id and latest versions. Pass the mod_file_id to nexus_upload_mod_file to release a new version of that file; omit it to create a brand new file. The numeric mod_id is the one in the page URL.",
    inputSchema: {
      mod_id: z.number().int().positive().describe("Numeric mod id (visible in the page URL)"),
      game_domain_name: gameArg,
      include_versions: z
        .boolean()
        .optional()
        .describe("Fetch the version chain of each file (default true, one extra call per file)"),
      versions_per_file: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many recent versions to keep per file (default 3)"),
      refresh: z.boolean().optional().describe("Bypass the cache (use right after an upload)"),
    },
    annotations: readOnly,
  },
  async ({ mod_id, game_domain_name, include_versions, versions_per_file, refresh }) =>
    run(async () => {
      const domain = game(game_domain_name);
      const mod = await resolveMod(domain, mod_id, refresh);
      const { data } = await client.v3<V3Envelope<{ mod_files: V3ModFile[] }>>(
        "GET",
        `/mods/${mod.id}/files`,
        { refresh, cacheTtlMs: 60_000 },
      );
      const modFiles = data.mod_files ?? [];
      const keep = versions_per_file ?? 3;

      const detailed = await Promise.all(
        modFiles.map(async (file) => {
          const base = prune({
            mod_file_id: file.id,
            name: file.name,
            is_active: file.is_active,
            versions_count: file.versions_count,
            archived_count: file.archived_count,
            last_upload: file.last_file_uploaded_at,
          });
          if (include_versions === false) return base;
          const versions = await client
            .v3<V3Envelope<{ versions: V3ModFileVersion[] }>>("GET", `/mod-files/${file.id}/versions`, {
              refresh,
              cacheTtlMs: 60_000,
            })
            .then(({ data: payload }) => payload.versions ?? [])
            .catch(() => []);
          return {
            ...base,
            latest_versions: versions
              .slice()
              .sort((a, b) => Number(b.position) - Number(a.position))
              .slice(0, keep)
              .map((version) =>
                prune({
                  version_id: version.id,
                  name: version.name,
                  version: version.version,
                  category: version.category,
                  file_id: version.game_scoped_id,
                  is_primary: version.is_primary ? true : undefined,
                  uploaded_at: version.uploaded_at,
                }),
              ),
          };
        }),
      );

      return {
        mod: prune({ mod_uid: mod.id, mod_id, name: mod.name, url: modUrl(domain, mod_id) }),
        mod_files: detailed,
        next_step:
          "Pass mod_file_id to nexus_upload_mod_file to add a version to that file, or omit it to create a new file.",
      };
    }),
);

server.registerTool(
  "nexus_upload_mod_file",
  {
    title: "Upload and publish a mod file",
    description:
      "Uploads a local archive to Nexus and publishes it, in ONE call (v3 Upload API): creates the upload session, sends the bytes to the presigned storage URL, finalises, waits for processing, then either appends a new version to an existing file (pass mod_file_id, from nexus_mod_file_targets) or creates a new file on the mod page. Multipart is used automatically above 100 MiB. Optionally posts a changelog entry. Requires NEXUS_ALLOW_WRITES=true and NEXUS_ALLOW_UPLOADS=true. Always run with dry_run=true first to confirm the plan before the real upload.",
    inputSchema: {
      file_path: z.string().describe("Absolute path of the archive to upload (must already exist)"),
      mod_id: z.number().int().positive().describe("Numeric mod id (visible in the page URL)"),
      game_domain_name: gameArg,
      name: z
        .string()
        .max(50)
        .describe("File name shown on the mod page (max 50 chars, letters/digits/space/_'().-)"),
      version: z.string().max(50).describe("File version (max 50 chars, letters/digits/dot/dash)"),
      file_category: z.enum(FILE_CATEGORIES).describe("main | optional | miscellaneous"),
      mod_file_id: z
        .string()
        .optional()
        .describe("Existing file to add this version to (omit to create a new file)"),
      description: z.string().optional().describe("Short description shown under the file"),
      changelog: z
        .string()
        .optional()
        .describe("Changelog text to append for this version (posted after publishing)"),
      update_mod_version: z
        .boolean()
        .optional()
        .describe("Bump the mod page version to match this file (default false)"),
      archive_existing_file: z
        .boolean()
        .optional()
        .describe("Archive the version being replaced (new versions only, default false)"),
      previous_version_id: z
        .string()
        .optional()
        .describe("version_id this release replaces (new versions only)"),
      primary_mod_manager_download: z
        .boolean()
        .optional()
        .describe("Make it the default mod-manager download"),
      allow_mod_manager_download: z.boolean().optional().describe("Allow mod manager downloads"),
      show_requirements_pop_up: z.boolean().optional().describe("Show the requirements pop-up"),
      upload_filename: z
        .string()
        .optional()
        .describe("Archive name sent to storage (defaults to the file name on disk)"),
      dry_run: z
        .boolean()
        .optional()
        .describe("Validate everything and report the plan without contacting Nexus"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) =>
    run(async () => {
      assertUploadsAllowed();
      validateModFileName(args.name);
      validateModFileVersion(args.version);

      const domain = game(args.game_domain_name);
      const filePath = resolveArchivePath(args.file_path, UPLOAD_ROOT);
      if (!existsSync(filePath)) throw new Error(`Archive not found: ${filePath}`);
      const size = statSync(filePath).size;
      const filename = args.upload_filename?.trim() || basename(filePath);

      const plan = prune({
        archive: filePath,
        size_bytes: size,
        upload_mode: size > SINGLE_PART_LIMIT_BYTES ? "multipart" : "single-part",
        target: args.mod_file_id
          ? `new version of mod file ${args.mod_file_id}`
          : `new file on ${modUrl(domain, args.mod_id)}`,
        file: { name: args.name, version: args.version, category: args.file_category },
        update_mod_version: args.update_mod_version ?? false,
        archive_existing_file: args.archive_existing_file ?? false,
        changelog: args.changelog ? `${args.changelog.length} characters` : undefined,
      });

      if (args.dry_run) {
        return { dry_run: true, plan, note: "Nothing was sent. Re-run without dry_run to publish." };
      }

      // Resolve the mod first: a wrong mod_id must fail before megabytes leave the machine.
      const mod = args.mod_file_id ? null : await resolveMod(domain, args.mod_id);

      const upload = await uploadArchive(client, {
        filePath,
        filename,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });

      const published = await publishUpload({
        upload_id: upload.upload_id,
        mod_file_id: args.mod_file_id,
        mod_uid: mod?.id,
        name: args.name,
        version: args.version,
        file_category: args.file_category,
        description: args.description,
        primary_mod_manager_download: args.primary_mod_manager_download,
        allow_mod_manager_download: args.allow_mod_manager_download,
        show_requirements_pop_up: args.show_requirements_pop_up,
        update_mod_version: args.update_mod_version,
        archive_existing_file: args.archive_existing_file,
        previous_version_id: args.previous_version_id,
      });

      let changelog: unknown;
      if (args.changelog) {
        const target = mod ?? (await resolveMod(domain, args.mod_id));
        changelog = await client
          .v3<V3Envelope<Record<string, unknown>>>("POST", `/mods/${target.id}/changelogs`, {
            body: { version: args.version, changelog: args.changelog },
            cache: false,
          })
          .then(() => "added")
          .catch((error: unknown) => `failed: ${error instanceof Error ? error.message : error}`);
      }

      return prune({
        plan,
        upload,
        published,
        changelog,
        page_url: modUrl(domain, args.mod_id),
        next_step:
          "Call nexus_mod_overview with refresh=true to confirm what the mod page now shows.",
      });
    }),
);

server.registerTool(
  "nexus_publish_upload",
  {
    title: "Publish an existing upload",
    description:
      "Recovery tool: turns an already finalised upload_id into a mod file or a new version, without re-sending the archive. Use it when nexus_upload_mod_file uploaded the bytes but the publishing step failed, or when the upload was still processing. Check nexus_upload_status shows state=available first.",
    inputSchema: {
      upload_id: z.string().uuid().describe("Upload id returned by nexus_upload_mod_file"),
      mod_id: z.number().int().positive().describe("Numeric mod id (visible in the page URL)"),
      game_domain_name: gameArg,
      name: z.string().max(50),
      version: z.string().max(50),
      file_category: z.enum(FILE_CATEGORIES),
      mod_file_id: z
        .string()
        .optional()
        .describe("Existing file to add this version to (omit to create a new file)"),
      description: z.string().optional(),
      update_mod_version: z.boolean().optional(),
      archive_existing_file: z.boolean().optional(),
      previous_version_id: z.string().optional(),
      primary_mod_manager_download: z.boolean().optional(),
      allow_mod_manager_download: z.boolean().optional(),
      show_requirements_pop_up: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ mod_id, game_domain_name, mod_file_id, ...rest }) =>
    run(async () => {
      assertUploadsAllowed();
      const domain = game(game_domain_name);
      const mod = mod_file_id ? null : await resolveMod(domain, mod_id);
      const published = await publishUpload({ ...rest, mod_file_id, mod_uid: mod?.id });
      return { published, page_url: modUrl(domain, mod_id) };
    }),
);

server.registerTool(
  "nexus_upload_status",
  {
    title: "Upload session status",
    description:
      "Return the state of an upload session: 'created' means Nexus is still processing the archive, 'available' means it can be published with nexus_publish_upload.",
    inputSchema: { upload_id: z.string().uuid() },
    annotations: readOnly,
  },
  async ({ upload_id }) =>
    run(async () => {
      const { data } = await client.v3<V3Envelope<Record<string, unknown>>>(
        "GET",
        `/uploads/${upload_id}`,
        { cache: false },
      );
      return prune({
        ...data,
        next_step:
          data.state === "available"
            ? "Publish it with nexus_publish_upload."
            : "Still processing: wait a few seconds and check again.",
      });
    }),
);

server.registerTool(
  "nexus_add_changelog",
  {
    title: "Add changelog entries",
    description:
      "Append changelog text for a version of one of your mods. Additive only: calling it twice for the same version appends, it does not replace. Write operation (NEXUS_ALLOW_WRITES=true).",
    inputSchema: {
      mod_id: z.number().int().positive().describe("Numeric mod id (visible in the page URL)"),
      version: z.string().max(50).describe("Version the entries apply to"),
      changelog: z.string().min(1).max(65_535).describe("Changelog text"),
      game_domain_name: gameArg,
    },
    annotations: writeOp,
  },
  async ({ mod_id, version, changelog, game_domain_name }) =>
    run(async () => {
      validateModFileVersion(version);
      const domain = game(game_domain_name);
      const mod = await resolveMod(domain, mod_id);
      const { data } = await client.v3<V3Envelope<Record<string, unknown>>>(
        "POST",
        `/mods/${mod.id}/changelogs`,
        { body: { version, changelog }, cache: false },
      );
      return { added: data, page_url: modUrl(domain, mod_id) };
    }),
);

server.registerTool(
  "nexus_rename_mod_file",
  {
    title: "Rename a mod file",
    description:
      "Rename an existing mod file (the whole update chain, not a single version). Get the mod_file_id from nexus_mod_file_targets. Write operation (NEXUS_ALLOW_WRITES=true).",
    inputSchema: {
      mod_file_id: z.string().describe("v3 mod file id, from nexus_mod_file_targets"),
      name: z.string().max(255).describe("New name (letters/digits/space/_'().- only)"),
    },
    annotations: writeOp,
  },
  async ({ mod_file_id, name }) =>
    run(async () => {
      validateModFileName(name, 255);
      await client.v3("PUT", `/mod-files/${mod_file_id}`, { body: { name }, cache: false });
      return { mod_file_id, name, result: "renamed" };
    }),
);

/* ------------------------------ Escape hatch ---------------------- */

server.registerTool(
  "nexus_graphql",
  {
    title: "Raw GraphQL query (API v2)",
    description:
      "Escape hatch for the v2 GraphQL API (collections, media, advanced filters). Read the nexus://graphql-cheatsheet resource first: the schema is already documented, so introspection queries are unnecessary. For plain mod searches use nexus_find_mods. Filters look like {\"gameDomainName\":[{\"value\":\"<domain>\",\"op\":\"EQUALS\"}],\"nameStemmed\":[{\"value\":\"<text>\"}]}; sorts look like [{\"updatedAt\":{\"direction\":\"DESC\"}}].",
    inputSchema: {
      query: z.string().describe("GraphQL document (query only unless writes are enabled)"),
      variables: z.record(z.unknown()).optional(),
      refresh: z.boolean().optional().describe("Bypass the cache"),
    },
    annotations: readOnly,
  },
  async ({ query, variables, refresh }) =>
    run(() => {
      if (/\bmutation\b/i.test(query) && !client.writesAllowed) {
        throw new Error("GraphQL mutations are disabled (NEXUS_ALLOW_WRITES=false).");
      }
      if (/__schema|__type/.test(query)) {
        throw new Error(
          "Introspection is blocked on purpose: read the nexus://graphql-cheatsheet resource, it documents ModsFilter, ModsSort and the available fields.",
        );
      }
      return client.graphql(query, variables, { refresh });
    }),
);

/* ------------------------------------------------------------------ */
/* Resources (embedded documentation)                                  */
/* ------------------------------------------------------------------ */

server.registerResource(
  "nexus-api-cheatsheet",
  "nexus://cheatsheet",
  {
    title: "Nexus Mods API crib sheet",
    description: "Endpoints, quotas and conventions of the Nexus Mods API, plus tool routing rules.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: [
          "# Nexus Mods API - crib sheet",
          "",
          "- Official docs: https://api-docs.nexusmods.com (OpenAPI: https://api.nexusmods.com/openapi.yaml)",
          "- v1 auth: `apikey` header (personal API key).",
          "- v2 auth: OAuth `Authorization: Bearer <token>`, falling back to `apikey`.",
          "- v3 auth: same (`apikey` header or Bearer JWT). Base URL `https://api.nexusmods.com/v3`.",
          "- Quotas: 2500 requests/day and 100/hour for a free account (headers `x-rl-*`); HTTP 429 once exceeded.",
          "- Premium-only endpoint: download link generation.",
          "- The v2/GraphQL endpoint does not return `x-rl-*` headers; this server keeps the last v1 snapshot.",
          "",
          "## Choosing a tool (fewest calls wins)",
          "| Question | Tool |",
          "|---|---|",
          "| \"Find mod X\" | `nexus_find_mods` |",
          "| \"Everything about mod 7501\" | `nexus_mod_overview` |",
          "| \"How are my mods doing?\" | `nexus_list_author_mods` |",
          "| \"What is new for this game?\" | `nexus_list_mods` |",
          "| \"What is this archive?\" | `nexus_search_md5` |",
          "| \"Publish / update one of my mods\" | `nexus_mod_file_targets` then `nexus_upload_mod_file` (see `nexus://upload-guide`) |",
          "| Anything else | `nexus_graphql` + `nexus://graphql-cheatsheet` |",
          "",
          "## Main v1 endpoints",
          "- `/v1/users/validate.json`",
          "- `/v1/games.json`, `/v1/games/{domain}.json`",
          "- `/v1/games/{domain}/mods/{id}.json`",
          "- `/v1/games/{domain}/mods/{id}/files.json`",
          "- `/v1/games/{domain}/mods/{id}/changelogs.json`",
          "- `/v1/games/{domain}/mods/latest_added|latest_updated|trending.json`",
          "- `/v1/games/{domain}/mods/updated.json?period=1d|1w|1m`",
          "- `/v1/games/{domain}/mods/md5_search/{hash}.json`",
          "",
          "## Main v3 endpoints (writes)",
          "- `POST /v3/uploads`, `POST /v3/uploads/multipart`, `POST /v3/uploads/{id}/finalise`, `GET /v3/uploads/{id}`",
          "- `POST /v3/mod-files` (new file), `POST /v3/mod-files/{id}/versions` (new version), `PUT /v3/mod-files/{id}` (rename)",
          "- `GET /v3/games/{domain}/mods/{mod_id}` (numeric mod id -> internal mod id), `GET /v3/mods/{mod_uid}/files`",
          "- `POST /v3/mods/{mod_uid}/changelogs`",
          "",
          "## File categories returned by Nexus",
          "`MAIN`, `UPDATE`, `OPTIONAL`, `MISCELLANEOUS`, `OLD_VERSION`, `ARCHIVED`.",
          "Tools hide `OLD_VERSION`/`ARCHIVED` by default (`include_old_files=true` to show them).",
          "A **new** upload can only be `main`, `optional` or `miscellaneous`.",
          "",
          `Default game domain for this server: \`${DEFAULT_GAME}\``,
        ].join("\n"),
      },
    ],
  }),
);

server.registerResource(
  "nexus-graphql-cheatsheet",
  "nexus://graphql-cheatsheet",
  {
    title: "Nexus GraphQL v2 crib sheet",
    description:
      "Verified shapes for mods(filter, sort): ModsFilter fields, comparison operators, sort keys. Read this instead of running introspection.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: GRAPHQL_CHEATSHEET }],
  }),
);

server.registerResource(
  "nexus-upload-guide",
  "nexus://upload-guide",
  {
    title: "Publishing to Nexus Mods (v3 Upload API)",
    description:
      "How mod / mod file / mod file version relate, the exact upload sequence, the field constraints and the recovery path. Read this before the first nexus_upload_mod_file call.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: UPLOAD_GUIDE }],
  }),
);

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

server.registerPrompt(
  "nexus_mod_report",
  {
    title: "Mod status report",
    description: "Produce a status report for a mod (stats, published files, recent changes).",
    argsSchema: {
      mod: z.string().describe("Mod name or numeric id"),
      game_domain_name: z.string().optional().describe(`Game domain (default ${DEFAULT_GAME})`),
    },
  },
  ({ mod, game_domain_name }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Produce a status report for the Nexus mod "${mod}" (game: ${game_domain_name || DEFAULT_GAME}).`,
            "",
            "Procedure, keeping tool calls to a minimum:",
            "1. If the mod is given as a name, resolve it with nexus_find_mods (one call).",
            "2. Call nexus_mod_overview with the mod_id (one call) - do not chain nexus_get_mod / nexus_get_mod_files / nexus_get_mod_changelogs.",
            "3. Summarise: current version and release date, downloads (total and unique), endorsements, primary file, and the highlights of the latest changelog.",
            "4. Flag anything odd: mod not published, no primary file, files still marked as old versions, description out of sync with the current version.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "nexus_release_update",
  {
    title: "Release an update",
    description: "Publish a new version of one of your files on an existing mod page.",
    argsSchema: {
      mod: z.string().describe("Mod name or numeric id"),
      file_path: z.string().describe("Absolute path of the archive to upload"),
      version: z.string().describe("Version of the release, e.g. 2.1.0"),
      game_domain_name: z.string().optional().describe(`Game domain (default ${DEFAULT_GAME})`),
    },
  },
  ({ mod, file_path, version, game_domain_name }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Publish version ${version} of "${mod}" from the archive ${file_path} (game: ${game_domain_name || DEFAULT_GAME}).`,
            "",
            "Read the nexus://upload-guide resource first, then:",
            "1. Resolve the numeric mod_id with nexus_find_mods if it was given as a name.",
            "2. Call nexus_mod_file_targets and pick the mod_file_id of the file this release updates. If none matches, say so and stop: creating a new file is a different decision.",
            "3. Call nexus_upload_mod_file with dry_run=true and show me the plan.",
            "4. Wait for my explicit confirmation before running it for real.",
            "5. After publishing, verify with nexus_mod_overview (refresh=true) and report the new state of the Files tab.",
          ].join("\n"),
        },
      },
    ],
  }),
);

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(
    `[nexus-mods-mcp] ready (v${SERVER_VERSION}, default game: ${DEFAULT_GAME}, writes: ${client.writesAllowed}, uploads: ${ALLOW_UPLOADS}${UPLOAD_ROOT ? `, upload root: ${UPLOAD_ROOT}` : ""})`,
  );
}

main().catch((error) => {
  console.error("[nexus-mods-mcp] startup failed:", error);
  process.exit(1);
});



