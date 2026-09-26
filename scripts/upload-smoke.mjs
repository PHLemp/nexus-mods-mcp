/**
 * Transport-level checks for the v3 upload pipeline, against a fake storage endpoint.
 *
 * These exist because a wrong header on a presigned URL is invisible locally and only shows up as
 * `403 SignatureDoesNotMatch` in production. The contract asserted here mirrors Nexus' own upload
 * action (Nexus-Mods/upload-action): multipart for every size, `Content-Type` + `Content-Length`
 * on each part, and no API key / no custom `User-Agent` towards storage.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UploadTransferError, uploadArchive } from "../dist/upload.js";

const filename = "example.zip";

/** Fake storage: serves the part URLs and the multipart completion URL. */
async function startStorage({ failPartStatus, etagMode = "md5" } = {}) {
  const parts = new Map();
  let completionBody = null;
  let completionHeaders = null;

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://127.0.0.1");

      if (url.pathname.startsWith("/part/")) {
        const number = Number(url.pathname.slice("/part/".length));
        parts.set(number, { headers: request.headers, body, method: request.method });
        if (failPartStatus) {
          response.writeHead(failPartStatus, { "content-type": "application/xml" });
          response.end(
            "<Error><Code>SignatureDoesNotMatch</Code><Message>fake storage</Message></Error>",
          );
          return;
        }
        const md5 = createHash("md5").update(body).digest("hex");
        const etag =
          etagMode === "corrupt"
            ? createHash("md5").update(Buffer.concat([body, Buffer.from("!")])).digest("hex")
            : etagMode === "opaque"
              ? "server-side-encrypted-etag-1"
              : md5;
        response.writeHead(200, { ETag: `"${etag}"` });
        response.end();
        return;
      }

      if (url.pathname === "/complete") {
        completionHeaders = request.headers;
        completionBody = body.toString("utf8");
        response.writeHead(200, { "content-type": "application/xml" });
        response.end("<CompleteMultipartUploadResult/>");
        return;
      }

      response.writeHead(404);
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    parts,
    get completionBody() {
      return completionBody;
    },
    get completionHeaders() {
      return completionHeaders;
    },
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function fakeClient({ port, size, partSizeBytes, uploadId, calls }) {
  const partCount = Math.ceil(size / partSizeBytes);
  return {
    userAgent: "nexus-mods-mcp/upload-smoke",
    async v3(method, path, init = {}) {
      calls.push(`${method} ${path.replace(uploadId, "<id>")}`);

      if (method === "POST" && path === "/uploads/multipart") {
        assert.equal(init.body.size_bytes, size, "the session must declare the real size");
        assert.equal(init.body.filename, filename);
        assert.equal(init.body.md5, undefined, "the multipart endpoint takes no digest");
        return {
          data: {
            id: uploadId,
            state: "created",
            part_size_bytes: partSizeBytes,
            part_presigned_urls: Array.from(
              { length: partCount },
              (_, index) => `http://127.0.0.1:${port}/part/${index + 1}`,
            ),
            complete_presigned_url: `http://127.0.0.1:${port}/complete`,
          },
        };
      }
      if (method === "POST" && path === `/uploads/${uploadId}/finalise`) return { data: {} };
      if (method === "GET" && path === `/uploads/${uploadId}`) {
        return { data: { id: uploadId, state: "available" } };
      }
      throw new Error(`Unexpected fake Nexus call: ${method} ${path}`);
    },
  };
}

async function withArchive(contents, body) {
  const directory = await mkdtemp(join(tmpdir(), "nexus-upload-smoke-"));
  const filePath = join(directory, filename);
  await writeFile(filePath, contents);
  try {
    return await body(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertStorageHeaders(headers, expectedLength) {
  assert.equal(headers["content-type"], "application/octet-stream");
  assert.equal(headers["content-length"], String(expectedLength));
  assert.equal(headers["content-disposition"], undefined, "not part of a multipart signature");
  assert.equal(headers["content-md5"], undefined, "multipart parts carry no digest header");
  assert.equal(headers.apikey, undefined, "the API key must never reach storage");
  assert.equal(headers.authorization, undefined, "no credentials towards storage");
  // Nexus' own action sets no user-agent, so the runtime default (`node`) is what storage sees.
  assert(
    !/nexus-mods-mcp/.test(headers["user-agent"] ?? ""),
    "no application user-agent towards storage",
  );
}

/** Nominal upload, run once with a single part and once split across several parts. */
async function runUpload({ size, partSizeBytes, label }) {
  const contents = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) contents[index] = index % 251;
  const md5Hex = createHash("md5").update(contents).digest("hex");
  const uploadId = "00000000-0000-4000-8000-000000000001";
  const expectedParts = Math.ceil(size / partSizeBytes);

  await withArchive(contents, async (filePath) => {
    const storage = await startStorage();
    const calls = [];
    try {
      const outcome = await uploadArchive(
        fakeClient({ port: storage.port, size, partSizeBytes, uploadId, calls }),
        { filePath, filename, timeoutMs: 5_000, pollAttempts: 1 },
      );

      assert.equal(outcome.mode, "multipart", `${label}: every size goes through multipart`);
      assert.equal(outcome.parts, expectedParts);
      assert.equal(outcome.state, "available");
      assert.equal(outcome.md5, md5Hex);
      assert.equal(outcome.upload_id, uploadId);
      assert.equal(outcome.size_bytes, size);
      assert.equal(
        outcome.integrity,
        `MD5 verified on ${expectedParts}/${expectedParts} part(s) against the storage ETag`,
        `${label}: every part must be checked against its ETag`,
      );

      assert.equal(storage.parts.size, expectedParts, `${label}: one PUT per part`);
      const received = [];
      for (let number = 1; number <= expectedParts; number += 1) {
        const part = storage.parts.get(number);
        assert(part, `${label}: part ${number} was never sent`);
        assert.equal(part.method, "PUT");
        assertStorageHeaders(part.headers, part.body.length);
        received.push(part.body);
      }
      assert.deepEqual(
        Buffer.concat(received),
        contents,
        `${label}: the reassembled parts must equal the archive`,
      );

      assert.equal(storage.completionHeaders["content-type"], "application/xml");
      assert.equal(storage.completionHeaders.apikey, undefined);
      assert(!/nexus-mods-mcp/.test(storage.completionHeaders["user-agent"] ?? ""));
      for (let number = 1; number <= expectedParts; number += 1) {
        const etag = createHash("md5").update(storage.parts.get(number).body).digest("hex");
        assert(
          storage.completionBody.includes(`<PartNumber>${number}</PartNumber>`),
          `${label}: completion XML must list part ${number}`,
        );
        assert(
          storage.completionBody.includes(`<ETag>${etag}</ETag>`),
          `${label}: completion XML must carry the ETag of part ${number}`,
        );
      }
      assert(storage.completionBody.startsWith("<CompleteMultipartUpload>"));
      assert(storage.completionBody.trimEnd().endsWith("</CompleteMultipartUpload>"));

      assert.deepEqual(calls, [
        "POST /uploads/multipart",
        "POST /uploads/<id>/finalise",
        "GET /uploads/<id>",
      ]);
    } finally {
      await storage.close();
    }
  });
}

/** A storage rejection must surface the upload id instead of inviting a blind second upload. */
async function runTransferFailure() {
  const contents = Buffer.from("storage rejects this transfer");
  const uploadId = "00000000-0000-4000-8000-0000000000ff";

  await withArchive(contents, async (filePath) => {
    const storage = await startStorage({ failPartStatus: 403 });
    const calls = [];
    try {
      await assert.rejects(
        uploadArchive(
          fakeClient({
            port: storage.port,
            size: contents.length,
            partSizeBytes: 50 * 1024 * 1024,
            uploadId,
            calls,
          }),
          { filePath, filename, timeoutMs: 5_000, pollAttempts: 1 },
        ),
        (error) => {
          assert(error instanceof UploadTransferError, "failures must keep the upload session id");
          assert.equal(error.upload_id, uploadId);
          assert(error.message.includes(`[upload_id: ${uploadId}]`));
          assert(error.message.includes("SignatureDoesNotMatch"));
          assert(error.steps.some((step) => step.includes("upload session")));
          return true;
        },
      );

      assert.deepEqual(calls, ["POST /uploads/multipart"], "a failed transfer must not finalise");
    } finally {
      await storage.close();
    }
  });
}

/** Nexus answering with an inconsistent part plan must stop before any byte leaves the machine. */
async function runInconsistentPartPlan() {
  const contents = Buffer.from("inconsistent part plan");
  const uploadId = "00000000-0000-4000-8000-0000000000ee";

  await withArchive(contents, async (filePath) => {
    const storage = await startStorage();
    const calls = [];
    try {
      const client = fakeClient({
        port: storage.port,
        size: contents.length,
        partSizeBytes: 50 * 1024 * 1024,
        uploadId,
        calls,
      });
      const inner = client.v3.bind(client);
      client.v3 = async (method, path, init) => {
        const answer = await inner(method, path, init);
        if (method === "POST" && path === "/uploads/multipart") {
          // One part of data, but Nexus hands out two URLs: the second would be an empty part.
          answer.data.part_presigned_urls = [
            ...answer.data.part_presigned_urls,
            `http://127.0.0.1:${storage.port}/part/2`,
          ];
        }
        return answer;
      };

      await assert.rejects(
        uploadArchive(client, { filePath, filename, timeoutMs: 5_000, pollAttempts: 1 }),
        (error) => {
          assert(error instanceof UploadTransferError);
          assert.equal(error.upload_id, uploadId);
          assert(/expected 1/.test(error.message), error.message);
          return true;
        },
      );

      assert.equal(storage.parts.size, 0, "nothing may be sent when the part plan is inconsistent");
      assert.deepEqual(calls, ["POST /uploads/multipart"]);
    } finally {
      await storage.close();
    }
  });
}

/** Storage storing different bytes than we sent must abort before the session is finalised. */
async function runCorruptedStorage() {
  const contents = Buffer.from("these bytes get corrupted in transit");
  const uploadId = "00000000-0000-4000-8000-0000000000cc";

  await withArchive(contents, async (filePath) => {
    const storage = await startStorage({ etagMode: "corrupt" });
    const calls = [];
    try {
      await assert.rejects(
        uploadArchive(
          fakeClient({
            port: storage.port,
            size: contents.length,
            partSizeBytes: 50 * 1024 * 1024,
            uploadId,
            calls,
          }),
          { filePath, filename, timeoutMs: 5_000, pollAttempts: 1 },
        ),
        (error) => {
          assert(error instanceof UploadTransferError);
          assert.equal(error.upload_id, uploadId);
          assert(/stored corrupted/.test(error.message), error.message);
          assert(/does not match its local MD5/.test(error.message));
          return true;
        },
      );

      assert.deepEqual(calls, ["POST /uploads/multipart"], "a corrupted part must not finalise");
    } finally {
      await storage.close();
    }
  });
}

/** An opaque ETag (e.g. SSE-KMS) cannot prove integrity, but must not fail the upload either. */
async function runUnverifiableEtag() {
  const contents = Buffer.from("stored under server-side encryption");
  const uploadId = "00000000-0000-4000-8000-0000000000aa";

  await withArchive(contents, async (filePath) => {
    const storage = await startStorage({ etagMode: "opaque" });
    const calls = [];
    try {
      const outcome = await uploadArchive(
        fakeClient({
          port: storage.port,
          size: contents.length,
          partSizeBytes: 50 * 1024 * 1024,
          uploadId,
          calls,
        }),
        { filePath, filename, timeoutMs: 5_000, pollAttempts: 1 },
      );

      assert.equal(outcome.state, "available");
      assert.equal(
        outcome.integrity,
        "MD5 verified on 0/1 part(s); part(s) 1 returned a non-MD5 ETag and could not be checked",
      );
      assert.deepEqual(calls, [
        "POST /uploads/multipart",
        "POST /uploads/<id>/finalise",
        "GET /uploads/<id>",
      ]);
    } finally {
      await storage.close();
    }
  });
}

await runUpload({ size: 48_015, partSizeBytes: 50 * 1024 * 1024, label: "single part" });
await runUpload({ size: 1_000, partSizeBytes: 400, label: "uneven last part" });
await runUpload({ size: 800, partSizeBytes: 400, label: "exact part boundary" });
await runUpload({ size: 1, partSizeBytes: 400, label: "one byte" });
await runTransferFailure();
await runInconsistentPartPlan();
await runCorruptedStorage();
await runUnverifiableEtag();
console.log(
  "Upload transport checks passed (multipart, headers, MD5/ETag integrity, completion XML, recovery id).",
);




