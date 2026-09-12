/**
 * Smoke test: starts the MCP server, inspects its capabilities and (optionally) calls the
 * high-level tools against the live Nexus API.
 *
 * Usage:
 *   node scripts/smoke.mjs            # offline: lists tools, resources and prompts
 *   node scripts/smoke.mjs --live     # also calls the read-only tools (needs a valid NEXUS_API_KEY)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");

// Node gives precedence to the environment over `.env`, so only inject a placeholder key when
// there is no real credential available - otherwise live calls would fail with HTTP 401.
const env = { ...process.env };
if (!env.NEXUS_API_KEY && !existsSync(resolve(root, ".env"))) env.NEXUS_API_KEY = "dummy-key";

const child = spawn(process.execPath, [resolve(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env,
});

let nextId = 1;
const pending = new Map();
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const request = (method, params) =>
  new Promise((done, fail) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) fail(new Error(`Timeout on ${method}`));
    }, 30_000);
  });

const firstText = (result) => result?.content?.find((part) => part.type === "text")?.text ?? "";
const preview = (text, max = 700) => (text.length > max ? `${text.slice(0, max)}\n  [...]` : text);

let failures = 0;
const check = (label, condition, detail = "") => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!condition) failures += 1;
};

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  notify("notifications/initialized");
  console.log("initialize OK ->", init.serverInfo);
  check("server sends routing instructions", Boolean(init.instructions?.includes("nexus_mod_overview")));

  const { tools } = await request("tools/list");
  console.log(`\ntools (${tools.length}):`);
  for (const tool of tools) console.log(`  - ${tool.name}`);
  const names = new Set(tools.map((tool) => tool.name));
  for (const expected of [
    "nexus_find_mods",
    "nexus_mod_overview",
    "nexus_list_author_mods",
    "nexus_get_mod",
    "nexus_get_mod_files",
    "nexus_graphql",
    "nexus_mod_file_targets",
    "nexus_upload_mod_file",
    "nexus_publish_upload",
    "nexus_upload_status",
    "nexus_add_changelog",
    "nexus_rename_mod_file",
  ]) {
    check(`tool ${expected} registered`, names.has(expected));
  }
  check(
    "tools expose annotations",
    tools.every((tool) => tool.annotations && typeof tool.annotations === "object"),
  );
  check("every tool has a description", tools.every((tool) => (tool.description ?? "").length > 40));

  const { resources } = await request("resources/list");
  console.log(`\nresources (${resources.length}): ${resources.map((item) => item.uri).join(", ")}`);
  check(
    "graphql cheat sheet exposed",
    resources.some((item) => item.uri === "nexus://graphql-cheatsheet"),
  );
  check(
    "upload guide exposed",
    resources.some((item) => item.uri === "nexus://upload-guide"),
  );

  const guide = await request("resources/read", { uri: "nexus://upload-guide" });
  check(
    "upload guide explains the recovery path",
    (guide?.contents?.[0]?.text ?? "").includes("nexus_publish_upload"),
  );

  // Uploads are gated twice. dry_run keeps this harmless even when both switches are on.
  const uploadGuard = await request("tools/call", {
    name: "nexus_upload_mod_file",
    arguments: {
      file_path: resolve(root, "package.json"),
      mod_id: 7501,
      name: "Smoke Test",
      version: "0.0.1",
      file_category: "main",
      dry_run: true,
    },
  });
  const uploadGuardText = firstText(uploadGuard);
  check(
    "upload is either blocked by the switches or answers with a plan only",
    uploadGuard.isError === true
      ? /NEXUS_ALLOW_(WRITES|UPLOADS)/.test(uploadGuardText)
      : uploadGuardText.includes('"dry_run": true'),
    uploadGuardText.slice(0, 120),
  );

  const badName = await request("tools/call", {
    name: "nexus_upload_mod_file",
    arguments: {
      file_path: resolve(root, "package.json"),
      mod_id: 7501,
      name: "bad/name",
      version: "0.0.1",
      file_category: "main",
      dry_run: true,
    },
  });
  check("invalid file names are rejected locally", badName.isError === true, firstText(badName).slice(0, 120));

  const { prompts } = await request("prompts/list");
  console.log(`prompts (${prompts.length}): ${prompts.map((item) => item.name).join(", ")}`);

  if (live) {
    console.log("\n--- live calls ---");

    const search = await request("tools/call", {
      name: "nexus_find_mods",
      arguments: { query: "Party Size Reunited", limit: 3 },
    });
    const searchText = firstText(search);
    console.log(`\nnexus_find_mods:\n${preview(searchText)}`);
    check("search finds a mod_id", /"mod_id":\s*\d+/.test(searchText));
    check("search reports the quota", searchText.includes("[nexus]"));

    const modId = Number(searchText.match(/"mod_id":\s*(\d+)/)?.[1]);
    if (!Number.isFinite(modId)) {
      check("overview skipped (no mod_id resolved)", false, "search step failed");
    } else {
      const overview = await request("tools/call", {
        name: "nexus_mod_overview",
        arguments: { mod_id: modId, changelog_versions: 2 },
      });
      const overviewText = firstText(overview);
      console.log(`\nnexus_mod_overview (mod ${modId}):\n${preview(overviewText, 1200)}`);
      check("overview returns files", overviewText.includes('"files"'));
      check("overview returns a page url", overviewText.includes('"page_url"'));
      check("overview hides archived files by default", !overviewText.includes('"ARCHIVED"'));
      check("markup is stripped", !overviewText.includes("<br />") && !overviewText.includes("[/list]"));
    }

    const author = await request("tools/call", {
      name: "nexus_list_author_mods",
      arguments: { limit: 5 },
    });
    const authorText = firstText(author);
    console.log(`\nnexus_list_author_mods:\n${preview(authorText)}`);
    check("author catalogue returns totals", authorText.includes('"totals"'));

    // Same search twice: the second one must be served from the cache.
    const cached = await request("tools/call", {
      name: "nexus_find_mods",
      arguments: { query: "Party Size Reunited", limit: 3 },
    });
    check("identical call is served from cache", /cache hits [1-9]/.test(firstText(cached)));

    const wildcard = await request("tools/call", {
      name: "nexus_find_mods",
      arguments: { query: "increase garrison size", match: "description", sort: "downloads", limit: 3 },
    });
    check("description search works", /"mod_id":\s*\d+/.test(firstText(wildcard)), firstText(wildcard).slice(0, 90));

    const fallback = await request("tools/call", {
      name: "nexus_find_mods",
      arguments: { query: "zzz unlikely title increase garrison", limit: 3 },
    });
    check(
      "empty title search falls back to descriptions automatically",
      firstText(fallback).includes("fallback_used") || firstText(fallback).includes('"total_matches": 0'),
    );

    const noCriteria = await request("tools/call", { name: "nexus_find_mods", arguments: {} });
    check("search without criteria is rejected", noCriteria.isError === true);

    const missing = await request("tools/call", {
      name: "nexus_mod_overview",
      arguments: { mod_id: 999999999 },
    });
    check(
      "unknown mod returns an actionable 404",
      missing.isError === true && firstText(missing).includes("404"),
      firstText(missing).slice(0, 120),
    );

    const files = await request("tools/call", {
      name: "nexus_get_mod_files",
      arguments: { mod_id: 7501, include_old: true, include_history: false },
    });
    const filesText = firstText(files);
    check("files tool hides the upload history by default", !filesText.includes("file_updates"));
    check("include_old reveals archived entries", filesText.includes("ARCHIVED"));

    const games = await request("tools/call", {
      name: "nexus_list_games",
      arguments: { filter: "bannerlord" },
    });
    check("game lookup works", firstText(games).includes("mountandblade2bannerlord"));

    const targets = await request("tools/call", {
      name: "nexus_mod_file_targets",
      arguments: { mod_id: 7501, versions_per_file: 2 },
    });
    const targetsText = firstText(targets);
    console.log(`\nnexus_mod_file_targets:\n${preview(targetsText, 900)}`);
    check("v3 resolves the mod and its files", targetsText.includes('"mod_file_id"'));

    const introspection = await request("tools/call", {
      name: "nexus_graphql",
      arguments: { query: "{ __schema { types { name } } }" },
    });
    check("introspection is blocked", introspection.isError === true, firstText(introspection).slice(0, 120));

    const writeAttempt = await request("tools/call", {
      name: "nexus_endorse_mod",
      arguments: { mod_id: 7501, action: "endorse" },
    });
    check(
      "writes are refused when NEXUS_ALLOW_WRITES is off",
      writeAttempt.isError === true && firstText(writeAttempt).includes("NEXUS_ALLOW_WRITES"),
      firstText(writeAttempt).slice(0, 120),
    );

    const status = await request("tools/call", { name: "nexus_rate_limit_status", arguments: {} });
    const statusText = firstText(status);
    console.log(`\nnexus_rate_limit_status:\n${preview(statusText, 500)}`);
    check("quota is known (not ?/?)", /"hourlyRemaining":\s*\d+/.test(statusText));
    check("cache is being used", /"cacheHits":\s*[1-9]/.test(statusText) || /"cacheEntries":\s*[1-9]/.test(statusText));
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
} catch (error) {
  console.error("Smoke test error:", error);
  failures += 1;
} finally {
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
}





