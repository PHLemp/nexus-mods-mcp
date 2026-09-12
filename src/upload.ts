/**
 * Upload pipeline for the Nexus Mods v3 API.
 *
 * Nexus never receives the archive through its own servers: it hands out a presigned S3 URL and
 * the bytes go straight to storage. The sequence is always the same, and every step is required:
 *
 *   1. POST /uploads (or /uploads/multipart)  -> upload id + presigned URL(s)
 *   2. PUT  <presigned url>                   -> the archive bytes
 *      (multipart: one PUT per part, then POST the ETag list to the complete URL)
 *   3. POST /uploads/{id}/finalise            -> closes the session
 *   4. GET  /uploads/{id}                     -> poll until state === "available"
 *   5. POST /mod-files or /mod-files/{id}/versions -> turn the upload into a published file
 *
 * Steps 1-4 live here; step 5 stays in the tool layer because it is what distinguishes
 * "new file on the mod page" from "new version of an existing file".
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { NexusClient, V3Envelope } from "./nexus-client.js";

/** Nexus rejects single-part uploads above this size. */
export const SINGLE_PART_LIMIT_BYTES = 100 * 1024 * 1024;

/** Nexus validation patterns, mirrored locally so a typo fails before any byte is sent. */
export const MOD_FILE_NAME_PATTERN = /^[a-zA-Z0-9 _'().-]+$/;
export const MOD_FILE_VERSION_PATTERN = /^[a-zA-Z0-9.-]+$/;

export type UploadState = "created" | "available";

export interface UploadOutcome {
  upload_id: string;
  state: UploadState;
  mode: "single-part" | "multipart";
  filename: string;
  size_bytes: number;
  parts: number;
  md5: string;
  steps: string[];
}

interface CreateUploadSuccess {
  id: string;
  state: UploadState;
  presigned_url: string;
}

interface CreateMultipartUploadSuccess {
  id: string;
  state: UploadState;
  part_size_bytes: number;
  part_presigned_urls: string[];
  complete_presigned_url: string;
}

interface UploadStatus {
  id: string;
  state: UploadState;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Turns an agent-supplied path into an absolute one, refusing anything outside `root`.
 * Without this guard the model could ask the server to publish any file readable by the process.
 */
export function resolveArchivePath(input: string, root?: string): string {
  const absolute = resolve(input);
  if (!root) return absolute;
  const base = resolve(root);
  const inside = relative(base, absolute);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`Refused: ${absolute} is outside NEXUS_UPLOAD_ROOT (${base}).`);
  }
  return absolute;
}

/** Nexus binds the presigned URL to the hex digest and validates the base64 one on the PUT. */
export async function md5Digests(path: string): Promise<{ hex: string; base64: string }> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const digest = hash.digest();
  return { hex: digest.toString("hex"), base64: digest.toString("base64") };
}

export function validateModFileName(name: string, maxLength = 50): void {
  if (name.length > maxLength || !MOD_FILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid mod file name "${name}": max ${maxLength} characters, only letters, digits, space and _ ' ( ) . -`,
    );
  }
}

export function validateModFileVersion(version: string): void {
  if (version.length > 50 || !MOD_FILE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid version "${version}": max 50 characters, only letters, digits, dot and dash.`,
    );
  }
}

/** Runs the full upload session and returns once Nexus reports the upload as `available`. */
export async function uploadArchive(
  client: NexusClient,
  params: {
    filePath: string;
    filename: string;
    timeoutMs: number;
    /** How long to keep polling for `state: available` after finalising (default ~60 s). */
    pollAttempts?: number;
  },
): Promise<UploadOutcome> {
  const info = await stat(params.filePath);
  if (!info.isFile()) throw new Error(`${params.filePath} is not a file.`);
  if (info.size === 0) throw new Error(`${params.filePath} is empty.`);

  const md5 = await md5Digests(params.filePath);
  const steps: string[] = [`md5 ${md5.hex}`];

  const session =
    info.size <= SINGLE_PART_LIMIT_BYTES
      ? await singlePart(client, params, info.size, md5, steps)
      : await multipart(client, params, info.size, steps);

  await client.v3<V3Envelope<UploadStatus>>("POST", `/uploads/${session.id}/finalise`, {
    cache: false,
  });
  steps.push("finalised");

  const state = await waitUntilAvailable(client, session.id, params.pollAttempts ?? 30);
  steps.push(`state ${state}`);

  return {
    upload_id: session.id,
    state,
    mode: session.mode,
    filename: params.filename,
    size_bytes: info.size,
    parts: session.parts,
    md5: md5.hex,
    steps,
  };
}

async function singlePart(
  client: NexusClient,
  params: { filePath: string; filename: string; timeoutMs: number },
  size: number,
  md5: { hex: string; base64: string },
  steps: string[],
): Promise<{ id: string; mode: "single-part"; parts: number }> {
  const { data } = await client.v3<V3Envelope<CreateUploadSuccess>>("POST", "/uploads", {
    body: { size_bytes: size, filename: params.filename, md5: md5.hex },
    cache: false,
  });
  steps.push(`upload session ${data.id} (single part)`);

  const handle = await open(params.filePath, "r");
  try {
    const body = await readChunk(handle, 0, size);
    // Content-Disposition and Content-MD5 are part of the URL signature: storage rejects a
    // mismatch, so they must repeat exactly what was declared when creating the session.
    await putBytes(
      data.presigned_url,
      body,
      {
        "content-disposition": `attachment; filename="${params.filename}"`,
        "content-md5": md5.base64,
        "user-agent": client.userAgent,
      },
      params.timeoutMs,
      "upload body",
    );
  } finally {
    await handle.close();
  }
  steps.push(`uploaded ${size} bytes`);

  return { id: data.id, mode: "single-part", parts: 1 };
}

async function multipart(
  client: NexusClient,
  params: { filePath: string; filename: string; timeoutMs: number },
  size: number,
  steps: string[],
): Promise<{ id: string; mode: "multipart"; parts: number }> {
  const { data } = await client.v3<V3Envelope<CreateMultipartUploadSuccess>>(
    "POST",
    "/uploads/multipart",
    { body: { size_bytes: size, filename: params.filename }, cache: false },
  );
  const urls = data.part_presigned_urls ?? [];
  if (urls.length === 0) throw new Error("Nexus returned no presigned part URLs.");
  steps.push(`upload session ${data.id} (${urls.length} parts of ${data.part_size_bytes} bytes)`);

  const etags: string[] = [];
  const handle = await open(params.filePath, "r");
  try {
    for (let index = 0; index < urls.length; index += 1) {
      const offset = index * data.part_size_bytes;
      const length = Math.min(data.part_size_bytes, size - offset);
      const chunk = await readChunk(handle, offset, length);
      const response = await putBytes(
        urls[index]!,
        chunk,
        { "user-agent": client.userAgent },
        params.timeoutMs,
        `part ${index + 1}/${urls.length}`,
      );
      etags.push(readEtag(response, index + 1));
    }
  } finally {
    await handle.close();
  }
  steps.push(`uploaded ${size} bytes in ${urls.length} parts`);

  const complete = await fetch(data.complete_presigned_url, {
    method: "POST",
    headers: { "content-type": "application/xml", "user-agent": client.userAgent },
    body: completeMultipartXml(etags),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  if (!complete.ok) {
    throw new Error(
      `Multipart completion failed -> HTTP ${complete.status}: ${(await complete.text()).slice(0, 400)}`,
    );
  }
  steps.push("multipart completed");

  return { id: data.id, mode: "multipart", parts: urls.length };
}

async function waitUntilAvailable(
  client: NexusClient,
  uploadId: string,
  attempts: number,
): Promise<UploadState> {
  let state: UploadState = "created";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data } = await client.v3<V3Envelope<UploadStatus>>("GET", `/uploads/${uploadId}`, {
      cache: false,
    });
    state = data.state;
    if (state === "available") return state;
    await sleep(Math.min(1_000 * 2 ** Math.floor(attempt / 4), 8_000));
  }
  throw new Error(
    `Upload ${uploadId} is still "${state}" after ${attempts} checks. Nexus is still processing it: ` +
      "call nexus_upload_status later, then publish it with nexus_publish_upload.",
  );
}

async function readChunk(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) {
    throw new Error(`Short read at offset ${offset}: expected ${length} bytes, got ${bytesRead}.`);
  }
  return buffer;
}

/** Presigned URLs are storage-side: they must never receive the Nexus API key. */
async function putBytes(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      const detail = (await response.text()).slice(0, 400);
      lastError = `HTTP ${response.status}: ${detail}`;
      // 4xx from storage means the signature or the headers are wrong: retrying cannot help.
      if (response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error(`Failed to PUT ${label} -> ${lastError}`);
}

function readEtag(response: Response, partNumber: number): string {
  const raw = response.headers.get("etag");
  if (!raw) throw new Error(`Part ${partNumber} returned no ETag header.`);
  const etag = raw.replace(/"/g, "").trim();
  if (!/^[A-Za-z0-9-]+$/.test(etag)) {
    throw new Error(`Part ${partNumber} returned an unexpected ETag: ${raw}`);
  }
  return etag;
}

function completeMultipartXml(etags: string[]): string {
  return [
    "<CompleteMultipartUpload>",
    ...etags.map(
      (etag, index) =>
        `  <Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
    ),
    "</CompleteMultipartUpload>",
  ].join("\n");
}

/** Exposed as the `nexus://upload-guide` MCP resource. */
export const UPLOAD_GUIDE = `# Publishing to Nexus Mods (v3 Upload API)

Docs: https://api-docs.nexusmods.com - OpenAPI: https://api.nexusmods.com/openapi.yaml

## Vocabulary

| Nexus term | What it is | Where the id comes from |
|---|---|---|
| mod id | the number in \`nexusmods.com/<game>/mods/7501\` | \`nexus_find_mods\` |
| mod uid | internal v3 id of the same mod | resolved automatically by the tools |
| **mod file** | one entry of the Files tab, i.e. a whole *update chain* | \`nexus_mod_file_targets\` -> \`mod_file_id\` |
| **mod file version** | one release inside that chain | \`nexus_mod_file_targets\` -> \`version_id\` |

Updating a mod = adding a **new version to an existing mod file**. Creating a second entry on the
Files tab = creating a **new mod file**. Picking the wrong one is the usual mistake.

## Recommended sequence

1. \`nexus_find_mods\` (or you already know the numeric mod id).
2. \`nexus_mod_file_targets\` - copy the \`mod_file_id\` of the file you are updating.
3. \`nexus_upload_mod_file\` with \`dry_run: true\` - check the plan (size, target, category).
4. \`nexus_upload_mod_file\` for real.
5. \`nexus_mod_overview\` with \`refresh: true\` - confirm the mod page.

## What nexus_upload_mod_file does for you

1. \`POST /v3/uploads\` (or \`/uploads/multipart\` above 100 MiB) with size, filename and MD5.
2. \`PUT\` the bytes to the presigned storage URL, with the exact \`Content-Disposition\` and
   \`Content-MD5\` the signature was built from. Multipart also \`POST\`s the ETag list.
3. \`POST /v3/uploads/{id}/finalise\`, then polls \`GET /v3/uploads/{id}\` until \`state: available\`.
4. \`POST /v3/mod-files/{mod_file_id}/versions\` (update) or \`POST /v3/mod-files\` (new file).
5. Optionally \`POST /v3/mods/{mod_uid}/changelogs\`.

If step 4 fails, the bytes are already on Nexus: **do not re-upload**. Reuse the returned
\`upload_id\` with \`nexus_publish_upload\`.

## Field constraints (validated locally before anything is sent)

- \`name\`: max 50 characters, \`^[a-zA-Z0-9 _'().-]+$\`
- \`version\`: max 50 characters, \`^[a-zA-Z0-9.-]+$\`
- \`file_category\`: \`main\` | \`optional\` | \`miscellaneous\` (\`update\`, \`old_version\` and
  \`archived\` are states Nexus assigns, they cannot be set on a new upload)
- \`update_mod_version: true\` bumps the version shown on the mod page
- \`archive_existing_file: true\` archives the version being replaced (new versions only)

## Configuration

- \`NEXUS_ALLOW_WRITES=true\` **and** \`NEXUS_ALLOW_UPLOADS=true\` are both required.
- \`NEXUS_UPLOAD_ROOT\` (optional) restricts which directory archives may be read from.
- \`NEXUS_UPLOAD_TIMEOUT_SECONDS\` (default 900) applies to each presigned transfer.
`;

