/**
 * Upload pipeline for the Nexus Mods v3 API.
 *
 * Nexus never receives the archive through its own servers: it hands out presigned S3 URLs and
 * the bytes go straight to storage. The sequence is always the same, and every step is required:
 *
 *   1. POST /uploads/multipart       -> upload id + one presigned URL per part
 *   2. PUT  <part presigned url>     -> the part bytes, keeping the ETag of each answer
 *   3. POST <complete presigned url> -> the ETag list, as S3 multipart XML
 *   4. POST /uploads/{id}/finalise   -> closes the session
 *   5. GET  /uploads/{id}            -> poll until state === "available"
 *   6. POST /mod-files or /mod-files/{id}/versions -> turn the upload into a published file
 *
 * Steps 1-5 live here; step 6 stays in the tool layer because it is what distinguishes
 * "new file on the mod page" from "new version of an existing file".
 *
 * Why multipart for every size, including a 48 KiB archive:
 * `POST /uploads` returns a presigned URL whose AWS signature also covers `Content-Disposition`
 * (and `Content-MD5` when a digest was supplied). Reproducing that signed header set byte for byte
 * is brittle, and storage answers `403 SignatureDoesNotMatch` when anything differs - with or
 * without the MD5 binding. Nexus' own GitHub Action (Nexus-Mods/upload-action) abandoned the
 * single-part route in March 2026 and now multiparts every file, sending only
 * `Content-Type: application/octet-stream` and `Content-Length` on each part, and no custom
 * `User-Agent`. This module mirrors that reference implementation deliberately.
 *
 * Where the MD5 stands:
 * Nexus marks `md5` as "required from 2026-12-01", but that badge is on `POST /uploads` only, and
 * it is required there because the digest is folded into the presigned signature. The multipart
 * route is a different contract: `CreateUploadRequest` has no `md5` field at all, and
 * `GET /uploads/{id}` returns no checksum. The deadline therefore does not reach the route used
 * here, and nothing in this module should pretend otherwise.
 *
 * Should `POST /uploads` ever be reinstated, treat the digest as mandatory from that date: hex in
 * the request body, and the same digest base64-encoded in `Content-MD5` on the PUT.
 *
 * Separately - and not as a stand-in for that API requirement - each part is compared with the MD5
 * S3 returns as its `ETag`. That is a local integrity check on an irreversible publication, and it
 * is reported as unverifiable rather than enforced when storage returns an opaque ETag.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { NexusClient, V3Envelope } from "./nexus-client.js";

/** Nexus validation patterns, mirrored locally so a typo fails before any byte is sent. */
export const MOD_FILE_NAME_PATTERN = /^[a-zA-Z0-9 _'().-]+$/;
export const MOD_FILE_VERSION_PATTERN = /^[a-zA-Z0-9.-]+$/;

export type UploadState = "created" | "available";

/**
 * Raised once an upload session exists on Nexus.
 *
 * The id must reach the caller: after this point the bytes may already be stored, so the correct
 * recovery is `nexus_upload_status` + `nexus_publish_upload`, never a blind second upload.
 */
export class UploadTransferError extends Error {
  constructor(
    message: string,
    readonly upload_id: string | null,
    readonly steps: string[] = [],
  ) {
    super(upload_id ? `${message} [upload_id: ${upload_id}]` : message);
    this.name = "UploadTransferError";
  }
}

export interface UploadOutcome {
  upload_id: string;
  state: UploadState;
  mode: "multipart";
  filename: string;
  size_bytes: number;
  parts: number;
  md5: string;
  /** Result of the mandatory client-side MD5 check of every transferred part. */
  integrity: string;
  steps: string[];
}

interface CreateMultipartUploadSuccess {
  id: string;
  state: UploadState;
  part_size_bytes: number;
  part_presigned_urls: string[];
  complete_presigned_url: string;
}

interface MultipartSession {
  id: string;
  urls: string[];
  partSizeBytes: number;
  completeUrl: string;
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

/** Hex digest of the whole archive, streamed so a large file is never held in memory. */
export async function md5Hex(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
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

  // The multipart endpoint takes no digest, so this is only reported back to the caller; the
  // per-part check against the storage ETag happens in transferParts.
  const md5 = await md5Hex(params.filePath);
  const steps: string[] = [`md5 ${md5}`];

  // Everything after this line owns an upload id, so failures must carry it.
  const session = await createMultipartSession(client, params.filename, info.size, steps);

  try {
    const transfer = await transferParts(params, info.size, session, steps);

    await client.v3<V3Envelope<UploadStatus>>("POST", `/uploads/${session.id}/finalise`, {
      cache: false,
    });
    steps.push("finalised");

    const state = await waitUntilAvailable(client, session.id, params.pollAttempts ?? 30, steps);
    steps.push(`state ${state}`);

    return {
      upload_id: session.id,
      state,
      mode: "multipart",
      filename: params.filename,
      size_bytes: info.size,
      parts: session.urls.length,
      md5,
      integrity: describeIntegrity(transfer, session.urls.length),
      steps,
    };
  } catch (error) {
    if (error instanceof UploadTransferError) throw error;
    throw new UploadTransferError(
      error instanceof Error ? error.message : String(error),
      session.id,
      steps,
    );
  }
}

async function createMultipartSession(
  client: NexusClient,
  filename: string,
  size: number,
  steps: string[],
): Promise<MultipartSession> {
  const { data } = await client.v3<V3Envelope<CreateMultipartUploadSuccess>>(
    "POST",
    "/uploads/multipart",
    { body: { size_bytes: size, filename }, cache: false },
  );

  const urls = data.part_presigned_urls ?? [];
  if (urls.length === 0) {
    throw new UploadTransferError("Nexus returned no presigned part URLs.", data.id ?? null, steps);
  }
  if (!Number.isFinite(data.part_size_bytes) || data.part_size_bytes <= 0) {
    throw new UploadTransferError(
      `Nexus returned an unusable part size (${data.part_size_bytes}).`,
      data.id ?? null,
      steps,
    );
  }

  // Guards against sending an empty trailing part, which storage would reject.
  const expected = Math.ceil(size / data.part_size_bytes);
  if (urls.length !== expected) {
    throw new UploadTransferError(
      `Nexus returned ${urls.length} part URL(s) for ${size} bytes split into ` +
        `${data.part_size_bytes}-byte parts, expected ${expected}.`,
      data.id ?? null,
      steps,
    );
  }
  if (!data.complete_presigned_url) {
    throw new UploadTransferError(
      "Nexus returned no multipart completion URL.",
      data.id ?? null,
      steps,
    );
  }

  steps.push(
    `upload session ${data.id} (${urls.length} part(s) of up to ${data.part_size_bytes} bytes)`,
  );
  return {
    id: data.id,
    urls,
    partSizeBytes: data.part_size_bytes,
    completeUrl: data.complete_presigned_url,
  };
}

interface TransferReport {
  verifiedParts: number;
  /** Parts whose ETag was not an MD5 (e.g. SSE-KMS), so integrity could not be proven. */
  unverifiedParts: number[];
}

async function transferParts(
  params: { filePath: string; timeoutMs: number },
  size: number,
  session: MultipartSession,
  steps: string[],
): Promise<TransferReport> {
  const etags: string[] = [];
  const unverifiedParts: number[] = [];
  const handle = await open(params.filePath, "r");
  try {
    for (let index = 0; index < session.urls.length; index += 1) {
      const partNumber = index + 1;
      const offset = index * session.partSizeBytes;
      const length = Math.min(session.partSizeBytes, size - offset);
      const chunk = await readChunk(handle, offset, length);
      const expectedMd5 = createHash("md5").update(chunk).digest("hex");

      const response = await putBytes(
        session.urls[index]!,
        chunk,
        params.timeoutMs,
        `part ${partNumber}/${session.urls.length}`,
      );
      const etag = readEtag(response, partNumber);

      // S3 returns the MD5 of a part as its ETag. Comparing it restores exactly the guarantee the
      // signed `Content-MD5` header gave on the single-part route, which the multipart body cannot
      // carry. This check is mandatory: a mismatch means stored bytes differ from the archive.
      if (/^[0-9a-f]{32}$/i.test(etag)) {
        if (etag.toLowerCase() !== expectedMd5) {
          throw new Error(
            `Part ${partNumber}/${session.urls.length} was stored corrupted: ETag ${etag} does not ` +
              `match its local MD5 ${expectedMd5}. Nothing was finalised.`,
          );
        }
      } else {
        unverifiedParts.push(partNumber);
      }

      etags.push(etag);
    }
  } finally {
    await handle.close();
  }

  const report: TransferReport = {
    verifiedParts: session.urls.length - unverifiedParts.length,
    unverifiedParts,
  };
  steps.push(`uploaded ${size} bytes in ${session.urls.length} part(s)`);
  steps.push(describeIntegrity(report, session.urls.length));

  // Storage-side URL: same single header Nexus' own action sends, and never the API key.
  const complete = await fetch(session.completeUrl, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: completeMultipartXml(etags),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  if (!complete.ok) {
    throw new Error(
      `Multipart completion failed -> HTTP ${complete.status}: ${(await complete.text()).slice(0, 400)}`,
    );
  }
  steps.push("multipart completed");

  return report;
}

function describeIntegrity(report: TransferReport, parts: number): string {
  if (report.unverifiedParts.length === 0) {
    return `MD5 verified on ${report.verifiedParts}/${parts} part(s) against the storage ETag`;
  }
  return (
    `MD5 verified on ${report.verifiedParts}/${parts} part(s); part(s) ` +
    `${report.unverifiedParts.join(", ")} returned a non-MD5 ETag and could not be checked`
  );
}

async function waitUntilAvailable(
  client: NexusClient,
  uploadId: string,
  attempts: number,
  steps: string[],
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
  throw new UploadTransferError(
    `Upload is still "${state}" after ${attempts} checks. Nexus is still processing it: ` +
      "call nexus_upload_status later, then publish it with nexus_publish_upload.",
    uploadId,
    steps,
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

/**
 * Presigned URLs are storage-side: they must never receive the Nexus API key, and they must carry
 * exactly the headers the signature was built for - no custom `User-Agent`, no `Content-Disposition`.
 * This is the header set Nexus' own upload action sends for every part.
 */
async function putBytes(
  url: string,
  body: Buffer,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.byteLength),
        },
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

/** Same layout as the sample in the Nexus OpenAPI spec and in Nexus' own upload action. */
function completeMultipartXml(etags: string[]): string {
  const parts = etags
    .map(
      (etag, index) =>
        `  <Part>\n    <PartNumber>${index + 1}</PartNumber>\n    <ETag>${etag}</ETag>\n  </Part>`,
    )
    .join("\n");
  return `<CompleteMultipartUpload>\n${parts}\n</CompleteMultipartUpload>`;
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

1. \`POST /v3/uploads/multipart\` with size and filename - used for **every** size, not only above
   100 MiB, because that is what Nexus' own upload action does.
2. \`PUT\` each part to its presigned storage URL with \`Content-Type: application/octet-stream\`
   and \`Content-Length\`, keeping each \`ETag\`, then \`POST\` the ETag list to the completion URL.
3. \`POST /v3/uploads/{id}/finalise\`, then polls \`GET /v3/uploads/{id}\` until \`state: available\`.
4. \`POST /v3/mod-files/{mod_file_id}/versions\` (update) or \`POST /v3/mod-files\` (new file).
5. Optionally \`POST /v3/mods/{mod_uid}/changelogs\`.

The single-part \`POST /v3/uploads\` route is deliberately not used: its presigned signature also
covers \`Content-Disposition\` (and \`Content-MD5\`), and storage answers
\`403 SignatureDoesNotMatch\` on the slightest mismatch.

## Content integrity (the \`md5\` question)

Nexus badges \`md5\` as "required from 2026-12-01". That badge is on \`POST /v3/uploads\` **only**,
where the digest is folded into the presigned signature. The multipart request body has no \`md5\`
field, and \`GET /v3/uploads/{id}\` returns no checksum, so the deadline does not apply to the route
this server uses. If the single-part route is ever reinstated, the digest is mandatory from that
date: hex in the body, and the same digest base64-encoded in \`Content-MD5\` on the PUT.

Independently of the API, each part is compared with the MD5 that S3 returns as its \`ETag\`, as a
local check on an irreversible publication. The result is reported as \`integrity\`; an opaque ETag
is reported as unverifiable rather than treated as a failure.

If anything fails once the session was created, the error carries \`[upload_id: ...]\`: the bytes
may already be on Nexus, so **do not re-upload**. Check \`nexus_upload_status\`, then reuse that
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

