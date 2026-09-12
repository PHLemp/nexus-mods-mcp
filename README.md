# nexus-mods-mcp

**MCP** (Model Context Protocol) server exposing the [Nexus Mods API](https://api-docs.nexusmods.com)
to an AI agent (GitHub Copilot, Claude, Junie...). Written in TypeScript, **stdio** transport.

Covers the read APIs (v1 REST, v2 GraphQL) **and the v3 Upload API**, so an agent can publish or
update one of your mods from a local archive.

Design goal: **answer a question in as few tool calls as possible**. Instead of a thin 1:1 mapping
over REST endpoints, the high-value tools aggregate several requests and return compacted results.

## 1. Concepts

A MCP server is a process speaking JSON-RPC 2.0 over stdin/stdout and declaring:

| Primitive     | Role                                   | Here                                      |
|---------------|----------------------------------------|-------------------------------------------|
| **Tools**     | actions the model can call             | 21 Nexus tools (`nexus_*`)                |
| **Resources** | documents the client can read          | `nexus://cheatsheet`, `nexus://graphql-cheatsheet`, `nexus://upload-guide` |
| **Prompts**   | reusable prompt templates              | `nexus_mod_report`, `nexus_release_update` |
| **Instructions** | global routing hints sent at `initialize` | "name -> find_mods -> mod_overview"  |

The agent never sees the URL nor the API key: it calls a typed tool, the server translates it into
HTTP calls, handles authentication, caching and quotas, then returns a compact result.

## 2. Install

Clone the repository, install the locked dependencies, and build the server:

```powershell
git clone https://github.com/PHLemp/nexus-mods-mcp.git
cd nexus-mods-mcp
npm ci
npm run build
```

The commands above assume Node.js and Git are installed. If you already have a checkout, run
`git pull`, then repeat `npm ci` and `npm run build` after updating the repository.

Get an API key: https://www.nexusmods.com/users/myaccount?tab=api%20access
(section "Personal API Key"), then:

```powershell
Copy-Item .env.example .env
# edit .env and paste the key into NEXUS_API_KEY
```

Check that everything works:

```powershell
npm run smoke        # offline: lists tools, resources and prompts
npm run smoke:live   # calls the read-only tools against the live API
npm run inspect      # MCP Inspector web UI
```

> Node gives precedence to the process environment over `.env`. If `NEXUS_API_KEY` is already set
> in the shell, that value wins.

## 3. Environment variables

| Variable                       | Required | Description                                                   |
|--------------------------------|----------|---------------------------------------------------------------|
| `NEXUS_API_KEY`                | yes      | Personal Nexus key (`apikey` header)                          |
| `NEXUS_OAUTH_TOKEN`            | no       | Bearer token for the v2 GraphQL / v3 REST APIs                |
| `NEXUS_DEFAULT_GAME`           | no       | Default domain (`mountandblade2bannerlord`)                   |
| `NEXUS_USER_AGENT`             | no       | Identifiable User-Agent, required by Nexus                    |
| `NEXUS_ALLOW_WRITES`           | no       | `true` to allow endorse / track / changelog / rename / mutations |
| `NEXUS_ALLOW_UPLOADS`          | no       | `true` to allow publishing files (also needs `NEXUS_ALLOW_WRITES`) |
| `NEXUS_UPLOAD_ROOT`            | no       | Restricts which directory archives may be uploaded from       |
| `NEXUS_UPLOAD_TIMEOUT_SECONDS` | no       | Timeout of each presigned transfer (default 900)              |
| `NEXUS_CACHE_TTL_SECONDS`      | no       | Read cache lifetime (default 300, `0` disables it)            |
| `NEXUS_TIMEOUT_SECONDS`        | no       | Per-request timeout (default 20)                              |
| `NEXUS_MAX_RETRIES`            | no       | Retries on network errors / 5xx (default 2)                   |

## 4. Wiring it into a MCP client

> **Recommended:** pass `NEXUS_API_KEY` (and any other overrides) through the `env` block of the
> client's own MCP config, the same way every MCP host is designed to inject configuration into the
> server subprocess. The `.env` file at the repo root is only a convenience fallback for local
> development and the `npm run smoke*` scripts — it is git-ignored and never required once a client
> supplies the key via `env`. Node's `process.loadEnvFile` never overrides a variable that is
> already set in the process environment, so a client-provided `env` value always wins over `.env`.

### JetBrains Rider + GitHub Copilot plugin (setup used here)

The Copilot plugin for JetBrains reads its MCP configuration from:

```
%LOCALAPPDATA%\github-copilot\intellij\mcp.json
```

Block to add under `servers`:

```json
"nexus-mods": {
  "type": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\path\\to\\nexus-mods-mcp\\dist\\index.js"],
  "env": {
    "NEXUS_API_KEY": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "NEXUS_DEFAULT_GAME": "mountandblade2bannerlord",
    "NEXUS_ALLOW_WRITES": "false"
  }
}
```

Replace the example path and key above with your checkout location and personal API key. If you'd
rather not store the key in this file, omit it from `env` and drop it into `<your checkout>/.env`
instead — both are read, but `env` takes precedence.
After changing the code, run `npm run build` and restart the server (or Rider) so the client picks
up the new tools.

### JetBrains AI Assistant / Junie

*Settings > Tools > AI Assistant > Model Context Protocol (MCP) > `+`*, button **As JSON**:

```json
{
  "mcpServers": {
    "nexus-mods": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\nexus-mods-mcp\\dist\\index.js"],
      "env": {
        "NEXUS_API_KEY": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

For a configuration versioned with the project (Junie): `.junie/mcp/mcp.json` at the repo root. Since
this file is typically committed, prefer leaving the key out of it and relying on `.env` (git-ignored)
for that particular workflow, or on a per-user Junie secrets mechanism if available.

### VS Code / GitHub Copilot — `.vscode/mcp.json` (optional)

```jsonc
{
  "servers": {
    "nexus-mods": {
      "type": "stdio",
      "command": "node",
      "args": ["E:\\Modding\\Tools\\nexus-mods-mcp\\dist\\index.js"],
      "env": { "NEXUS_API_KEY": "${input:nexusApiKey}" }
    }
  },
  "inputs": [
    { "id": "nexusApiKey", "type": "promptString", "description": "Nexus Mods API key", "password": true }
  ]
}
```

## 5. Troubleshooting

| Symptom                                   | Likely cause / fix                                                              |
|-------------------------------------------|---------------------------------------------------------------------------------|
| Server "failed to start" in Rider         | `dist/index.js` missing -> `npm run build`                                       |
| "NEXUS_API_KEY is missing"                | Set `NEXUS_API_KEY` in the client's `env` block (preferred) or in `.env`          |
| `node` not found                          | Use the absolute path `C:\Program Files\nodejs\node.exe`                          |
| Tools missing from the chat               | Switch the chat to **Agent** mode, then enable `nexus-mods` in the tool list      |
| HTTP 401 on every call                    | Invalid key -> test with `nexus_validate_user`                                    |
| New tools not showing up                  | Rebuild, then restart the MCP server from the client                              |
| HTTP 429                                  | Quota exhausted; the error states the reset time. Reuse cached results            |
| "Publishing is disabled"                  | Set `NEXUS_ALLOW_UPLOADS=true` (and `NEXUS_ALLOW_WRITES=true`)                    |
| Upload refused, "outside NEXUS_UPLOAD_ROOT" | The archive is not under the configured sandbox directory                       |
| HTTP 403 on a publishing call             | The API key does not belong to an author of that mod                             |
| HTTP 422 on publish                       | `name`/`version` or a flag broke a Nexus constraint; the field is named in the error |
| Upload succeeded but publishing failed    | Reuse the returned `upload_id` with `nexus_publish_upload`, do not re-upload      |

## 6. Tools

### Aggregating tools (prefer these)

| Tool                     | What it returns                                                             | Calls saved |
|--------------------------|------------------------------------------------------------------------------|-------------|
| `nexus_find_mods`        | name/keywords -> mod_id, version, author, downloads, endorsements, URL       | replaces GraphQL introspection + search |
| `nexus_mod_overview`     | metadata + files grouped by category + recent changelogs + page URL          | replaces `get_mod` + `get_mod_files` + `get_mod_changelogs` |
| `nexus_list_author_mods` | full catalogue of an author (or "my mods"), with download/endorsement totals | replaces one call per mod |
| `nexus_upload_mod_file`  | local archive -> published file or new version (+ optional changelog)        | replaces the 5-step v3 upload dance |

### Publishing tools (v3 Upload API)

| Tool                      | Nexus endpoint                                                    | Write |
|---------------------------|-------------------------------------------------------------------|-------|
| `nexus_mod_file_targets`  | `/v3/games/{domain}/mods/{id}` + `/v3/mods/{uid}/files` + versions | no    |
| `nexus_upload_mod_file`   | full upload session + `/v3/mod-files[/{id}/versions]`             | yes*  |
| `nexus_publish_upload`    | `/v3/mod-files[/{id}/versions]` from an existing `upload_id`      | yes*  |
| `nexus_upload_status`     | `/v3/uploads/{id}`                                                | no    |
| `nexus_add_changelog`     | `/v3/mods/{uid}/changelogs`                                       | yes   |
| `nexus_rename_mod_file`   | `PUT /v3/mod-files/{id}`                                          | yes   |

\* also requires `NEXUS_ALLOW_UPLOADS=true`.

### Supporting tools

| Tool                       | Nexus endpoint                                              | Write |
|----------------------------|--------------------------------------------------------------|-------|
| `nexus_validate_user`      | `/v1/users/validate.json`                                    | no    |
| `nexus_rate_limit_status`  | `x-rl-*` headers + server stats + cache reset                | no    |
| `nexus_list_games`         | `/v1/games.json` (+ local filter)                            | no    |
| `nexus_get_game`           | `/v1/games/{domain}.json`                                    | no    |
| `nexus_get_mod`            | `/v1/games/{domain}/mods/{id}.json`                          | no    |
| `nexus_get_mod_files`      | `.../files[.json\|/{file_id}.json]`                          | no    |
| `nexus_get_mod_changelogs` | `.../changelogs.json`                                        | no    |
| `nexus_list_mods`          | `latest_added` / `latest_updated` / `trending` / `updated`   | no    |
| `nexus_search_md5`         | `.../md5_search/{hash}.json`                                 | no    |
| `nexus_get_download_link`  | `.../download_link.json` (Premium)                           | no    |
| `nexus_tracked_mods`       | `/v1/user/tracked_mods.json`                                 | yes*  |
| `nexus_endorse_mod`        | `.../endorse.json` \| `abstain.json`                         | yes   |
| `nexus_graphql`            | `POST /v2/graphql`                                           | yes*  |

\* only for mutating actions, blocked unless `NEXUS_ALLOW_WRITES=true`.

### Publishing / updating a mod

Nexus vocabulary matters here, because the two operations are different endpoints:

| Term                  | Meaning                                                   |
|-----------------------|-----------------------------------------------------------|
| **mod file**          | one entry of the Files tab, i.e. a whole *update chain*    |
| **mod file version**  | one release inside that chain                             |

Updating a mod = adding a **new version to an existing mod file**. Adding a second entry to the
Files tab = creating a **new mod file**.

```text
nexus_find_mods            -> mod_id
nexus_mod_file_targets     -> mod_file_id of the file to update
nexus_upload_mod_file      -> dry_run: true, review the plan
nexus_upload_mod_file      -> for real
nexus_mod_overview         -> refresh: true, verify
```

`nexus_upload_mod_file` runs the whole v3 sequence in one call:

1. `POST /v3/uploads` (or `/uploads/multipart` above 100 MiB) with size, filename and MD5.
2. `PUT` the bytes to the presigned storage URL, with the exact `Content-Disposition` and
   `Content-MD5` the signature was built from; multipart also `POST`s the ETag list.
3. `POST /v3/uploads/{id}/finalise`, then polls `GET /v3/uploads/{id}` until `state: available`.
4. `POST /v3/mod-files/{mod_file_id}/versions` (update) or `POST /v3/mod-files` (new file).
5. Optionally `POST /v3/mods/{uid}/changelogs`.

If step 4 fails, the bytes are already on Nexus: **do not re-upload**, reuse the returned
`upload_id` with `nexus_publish_upload`.

Guardrails:

- two independent switches, `NEXUS_ALLOW_WRITES` **and** `NEXUS_ALLOW_UPLOADS`;
- `NEXUS_UPLOAD_ROOT` confines which directory archives may be read from, so the model cannot ask
  the server to publish an arbitrary file;
- `name` / `version` are validated against the Nexus patterns *before* any byte is sent;
- `dry_run: true` reports the plan (size, transfer mode, target, category) without contacting Nexus.

The `nexus_release_update` prompt drives the whole sequence and asks for confirmation before the
real upload. `nexus://upload-guide` documents it for the model.

## 7. Applied best practices

- **Guided routing**: server `instructions`, cross-referencing tool descriptions and a `next_step`
  field in results, so the model chains the right tools instead of probing.
- **No introspection needed**: `nexus://graphql-cheatsheet` documents `ModsFilter`, `ModsSort` and
  the operators, verified against the live API. Introspection queries are rejected with a pointer
  to that resource.
- **Bounded responses**: markup stripped (HTML/BBCode), archived files and upload history hidden by
  default, 45 000 character cap with an actionable message.
- **Quota aware**: every reply ends with the remaining quota. The v2/GraphQL endpoint sends no
  `x-rl-*` headers, so the last known v1 snapshot is kept instead of showing `?/?`.
- **Cache**: reads are cached in memory (default 5 minutes, one hour for `/games.json` and the
  profile), so a repeated call costs nothing. `refresh=true` forces a fresh read.
- **Resilience**: 20 s timeout, exponential-backoff retries on network errors and 5xx, HTTP status
  codes translated into actionable messages (401/403/404/429).
- **Protected writes**: explicit opt-in via `NEXUS_ALLOW_WRITES`, a second opt-in
  (`NEXUS_ALLOW_UPLOADS` + `NEXUS_UPLOAD_ROOT`) for anything that publishes to a mod page, plus MCP
  annotations (`readOnlyHint` / `destructiveHint`) so clients can display the risk.
- **Resumable publishing**: the upload id is always returned, so a failed publishing step never
  forces a re-upload (`nexus_publish_upload`).
- **Secrets out of the model**: the key lives in the environment, never in tool arguments.
- **stderr-only logging**: stdout is reserved for JSON-RPC (writing to it breaks the session).

## 8. Extending the server

| File                   | Role                                                        |
|------------------------|-------------------------------------------------------------|
| `src/nexus-client.ts`  | HTTP transport: auth, retry, timeout, cache, rate limit     |
| `src/format.ts`        | Compaction: markup stripping, `compactMod`, `compactFile`   |
| `src/queries.ts`       | GraphQL documents + schema crib sheet                       |
| `src/upload.ts`        | v3 upload session: MD5, presigned PUT, multipart, polling   |
| `src/index.ts`         | Tool/resource/prompt registration                           |
| `scripts/smoke.mjs`    | Capability checks + live read-only test suite               |

Adding a tool means adding a `server.registerTool(...)` block in `src/index.ts`, then
`npm run build`. Before doing so, ask whether an **existing tool could return the information
in the same call** - that is usually the better change.

Add a check to `scripts/smoke.mjs` for anything you add, then run `npm run smoke:live`.

