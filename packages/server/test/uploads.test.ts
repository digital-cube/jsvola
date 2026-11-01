import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { encodeTusMetadata, FileInfoSchema } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files, uploads } from "../src/db/schema.js";
import { createTenant } from "../src/services/tenants.js";
import { sweepExpiredUploads, type UploadsDeps } from "../src/services/uploads.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { PartStore } from "../src/uploads/part-store.js";
import {
  bearer,
  config,
  type Fixture,
  mintKey,
  setupFixture,
  testDatabase,
  truncate,
} from "./helpers.js";
import { fileUpload, multipartHeaders } from "./multipart.js";

const handle = testDatabase(6);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let parts: PartStore;
let port: number;
let other: { tenantId: string; key: string };

const TYPE = "tickets";
const MAX_UPLOAD = 4 * 1024 * 1024;
const TUS = { "tus-resumable": "1.0.0" };
const PATCH_TYPE = "application/offset+octet-stream";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-uploads-"));
  storage = new FilesystemBackend(root);
  parts = new PartStore(join(root, "uploads"));
  fx = await setupFixture(handle, {
    storage,
    config: { ...config, storagePath: root, maxUploadBytes: MAX_UPLOAD },
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as { port: number }).port;
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other-full", "live", ["files:read", "files:write"]);
  other = { tenantId: tenant.id, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

type Headers = Record<string, string>;
const auth = (key = fx.full.key): Headers => ({ ...bearer(key), ...TUS });

/** `POST /uploads` with `Upload-Length` and the metadata pairs. */
async function create(
  length: number,
  meta: Record<string, string | undefined>,
  options: { key?: string; headers?: Headers; instanceId?: string } = {},
) {
  const instanceId = options.instanceId ?? meta.instance_id ?? randomUUID();
  const response = await app.inject({
    method: "POST",
    url: "/vola/uploads",
    headers: {
      ...auth(options.key),
      "upload-length": String(length),
      "upload-metadata": encodeTusMetadata({
        instance_type: TYPE,
        instance_id: instanceId,
        ...meta,
      }),
      ...(options.headers ?? {}),
    },
  });
  const location = response.headers.location as string | undefined;
  return { response, instanceId, location, id: location?.split("/").pop() ?? "" };
}

const head = (id: string, key?: string) =>
  app.inject({ method: "HEAD", url: `/vola/uploads/${id}`, headers: auth(key) });
const del = (id: string, key?: string) =>
  app.inject({ method: "DELETE", url: `/vola/uploads/${id}`, headers: auth(key) });

function patch(
  id: string,
  offset: number,
  body: Buffer | Readable,
  options: { key?: string; headers?: Headers } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "PATCH",
    url: `/vola/uploads/${id}`,
    headers: {
      ...auth(options.key),
      "content-type": PATCH_TYPE,
      "upload-offset": String(offset),
      ...(options.headers ?? {}),
    },
    payload: body,
  });
}

/** `GET /files/:type/:id/:fileId` as a Buffer. */
async function download(instanceId: string, fileId: string): Promise<Buffer> {
  const response = await app.inject({
    method: "GET",
    url: `/vola/files/${TYPE}/${instanceId}/${fileId}`,
    headers: bearer(fx.full.key),
  });
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
}

const info = async (instanceId: string, fileId: string) => {
  const response = await app.inject({
    method: "GET",
    url: `/vola/files/${TYPE}/${instanceId}/${fileId}/info`,
    headers: bearer(fx.full.key),
  });
  expect(response.statusCode, response.body).toBe(200);
  return FileInfoSchema.parse(response.json());
};

const partFiles = async () =>
  (await readdir(join(root, "uploads"))).filter((f) => f.endsWith(".part"));
const blobsOnDisk = async () =>
  (await readdir(storage.blobsDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

describe("OPTIONS /uploads", () => {
  it("announces tus 1.0 with creation, termination and expiration, without a key", async () => {
    const response = await app.inject({ method: "OPTIONS", url: "/vola/uploads" });
    expect(response.statusCode).toBe(204);
    expect(response.headers["tus-resumable"]).toBe("1.0.0");
    expect(response.headers["tus-version"]).toBe("1.0.0");
    expect(response.headers["tus-extension"]).toBe("creation,termination,expiration");
    expect(response.headers["tus-max-size"]).toBe(String(MAX_UPLOAD));
  });
});

describe("creation", () => {
  it("creates an upload: 201, Location, Upload-Expires, an empty part file", async () => {
    const { response, id } = await create(1000, { filename: "a.bin" });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers.location).toBe(`/vola/uploads/${id}`);
    expect(response.headers["tus-resumable"]).toBe("1.0.0");
    expect(response.headers["upload-offset"]).toBe("0");
    expect(response.headers["upload-length"]).toBe("1000");
    expect(response.headers["vola-file-id"]).toBeUndefined();
    const expires = new Date(response.headers["upload-expires"] as string);
    const hours = (expires.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    expect((await stat(parts.path(id))).size).toBe(0);

    const probe = await head(id);
    expect(probe.statusCode).toBe(200);
    expect(probe.headers["upload-offset"]).toBe("0");
    expect(probe.headers["upload-length"]).toBe("1000");
    expect(probe.headers["cache-control"]).toBe("no-store");
    expect(probe.headers["upload-metadata"]).toContain("filename ");
  });

  it("requires Tus-Resumable 1.0.0 (412 with Tus-Version), Upload-Length and the three metadata keys", async () => {
    const noVersion = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: { ...bearer(fx.full.key), "upload-length": "10" },
    });
    expect(noVersion.statusCode).toBe(412);
    expect(noVersion.headers["tus-version"]).toBe("1.0.0");
    expect(noVersion.headers["tus-resumable"]).toBe("1.0.0");
    expect(noVersion.json().error.code).toBe("tus_version_unsupported");

    const noLength = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: { ...auth(), "upload-metadata": encodeTusMetadata({ filename: "x" }) },
    });
    expect(noLength.statusCode).toBe(400);

    const deferred = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: { ...auth(), "upload-defer-length": "1" },
    });
    expect(deferred.statusCode).toBe(400);
    expect(deferred.json().error.code).toBe("upload_defer_length_unsupported");

    const noFilename = await create(10, {});
    expect(noFilename.response.statusCode).toBe(422);
    expect(noFilename.response.json().error.message).toContain("filename");

    const noInstance = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: {
        ...auth(),
        "upload-length": "10",
        "upload-metadata": encodeTusMetadata({ filename: "x" }),
      },
    });
    expect(noInstance.statusCode).toBe(422);
    expect(noInstance.json().error.message).toContain("instance_type");

    const badBase64 = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: { ...auth(), "upload-length": "10", "upload-metadata": "filename !!!" },
    });
    expect(badBase64.statusCode).toBe(400);
  });

  it("rejects an Upload-Length over VOLA_MAX_UPLOAD_BYTES with 413 and a bad instance with 422", async () => {
    const big = await create(MAX_UPLOAD + 1, { filename: "big.bin" });
    expect(big.response.statusCode).toBe(413);
    expect(big.response.json().error.code).toBe("file_too_large");
    const badType = await create(10, { filename: "x", instance_type: "Tickets" });
    expect(badType.response.statusCode).toBe(422);
    const badParent = await create(10, { filename: "x", parent_id: randomUUID() });
    expect(badParent.response.statusCode).toBe(404);
    expect(badParent.response.json().error.code).toBe("file_not_found");
    expect(await partFiles()).not.toContain(`${badParent.id}.part`);
  });

  it("needs files:write; a read-only key gets 403", async () => {
    const { response } = await create(10, { filename: "x" }, { key: fx.readOnly.key });
    expect(response.statusCode).toBe(403);
  });

  it("completes a zero-length upload at creation", async () => {
    const { response, instanceId } = await create(0, { filename: "empty.txt" });
    expect(response.statusCode, response.body).toBe(201);
    const file = FileInfoSchema.parse(response.json());
    expect(response.headers["vola-file-id"]).toBe(file.id);
    expect(file).toMatchObject({ size: 0, filename: "empty.txt", mime_type: "text/plain" });
    expect(await download(instanceId, file.id)).toEqual(Buffer.alloc(0));
  });
});

describe("PATCH", () => {
  it("creation + one PATCH: the file is byte-identical and shares the blob with a plain upload", async () => {
    const data = randomBytes(200_000);
    // The same bytes through POST /files first: the resumable one must deduplicate onto them.
    const instanceId = randomUUID();
    const plain = await app.inject({
      method: "POST",
      url: `/vola/files/${TYPE}/${instanceId}`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: fileUpload("plain.bin", data),
    });
    expect(plain.statusCode).toBe(201);
    const blobsBefore = (await blobsOnDisk()).length;

    const { response, id } = await create(data.length, {
      filename: "report.pdf",
      instance_id: instanceId,
      content_type: "application/pdf",
      metadata: JSON.stringify({ via: "tus" }),
    });
    expect(response.statusCode).toBe(201);
    const done = await patch(id, 0, data, { headers: { "x-user-id": "igor" } });
    expect(done.statusCode, done.body).toBe(204);
    expect(done.headers["upload-offset"]).toBe(String(data.length));
    const fileId = done.headers["vola-file-id"] as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);

    const file = await info(instanceId, fileId);
    expect(file).toMatchObject({
      hash: sha256(data),
      size: data.length,
      filename: "report.pdf",
      mime_type: "application/pdf",
      metadata: { via: "tus" },
      created_by: "igor",
      instance_id: instanceId,
    });
    expect(await download(instanceId, fileId)).toEqual(data);
    expect((await blobsOnDisk()).length).toBe(blobsBefore); // dedup: no new blob
    expect(await partFiles()).not.toContain(`${id}.part`);

    const after = await head(id);
    expect(after.statusCode).toBe(200);
    expect(after.headers["upload-offset"]).toBe(String(data.length));
    expect(after.headers["vola-file-id"]).toBe(fileId);

    const [row] = await handle.db.select().from(uploads).where(eq(uploads.id, id));
    expect(row?.completedFileId).toBe(fileId);
    expect(row?.offset).toBe(data.length);
  });

  it("three PATCHes of uneven size, HEAD between them, the hash of the whole", async () => {
    const data = randomBytes(300_001);
    const { id, instanceId } = await create(data.length, { filename: "chunks.bin" });
    const cuts = [0, 70_000, 199_999, data.length];
    let fileId: string | undefined;
    for (let i = 0; i < cuts.length - 1; i++) {
      const [from, to] = [cuts[i] as number, cuts[i + 1] as number];
      const probe = await head(id);
      expect(probe.headers["upload-offset"]).toBe(String(from));
      const response = await patch(id, from, data.subarray(from, to));
      expect(response.statusCode, response.body).toBe(204);
      expect(response.headers["upload-offset"]).toBe(String(to));
      fileId = (response.headers["vola-file-id"] as string | undefined) ?? fileId;
      if (to < data.length) expect(response.headers["vola-file-id"]).toBeUndefined();
    }
    expect(fileId).toBeDefined();
    expect(sha256(await download(instanceId, fileId as string))).toBe(sha256(data));
  });

  it("a wrong Upload-Offset is 409 upload_offset_mismatch and changes nothing", async () => {
    const data = randomBytes(10_000);
    const { id } = await create(data.length, { filename: "x.bin" });
    expect((await patch(id, 0, data.subarray(0, 4000))).statusCode).toBe(204);
    const stale = await patch(id, 0, data.subarray(0, 4000));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("upload_offset_mismatch");
    const ahead = await patch(id, 5000, data.subarray(5000));
    expect(ahead.statusCode).toBe(409);
    expect((await head(id)).headers["upload-offset"]).toBe("4000");
    expect((await stat(parts.path(id))).size).toBe(4000);
  });

  it("a body longer than what is left is 400 upload_overflow and the PATCH is undone", async () => {
    const { id } = await create(1000, { filename: "x.bin" });
    expect((await patch(id, 0, randomBytes(600))).statusCode).toBe(204);
    const over = await patch(id, 600, randomBytes(401));
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe("upload_overflow");
    expect((await head(id)).headers["upload-offset"]).toBe("600");
    expect((await stat(parts.path(id))).size).toBe(600);
  });

  it("a chunked body (no Content-Length) that overflows is drained, answered 400 and undone", async () => {
    const { id } = await create(1000, { filename: "x.bin" });
    expect((await patch(id, 0, randomBytes(600))).statusCode).toBe(204);
    const over = await patch(id, 600, Readable.from([randomBytes(300), randomBytes(300)]));
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe("upload_overflow");
    expect((await head(id)).headers["upload-offset"]).toBe("600");
    expect((await stat(parts.path(id))).size).toBe(600);
    // The upload is still usable.
    const done = await patch(id, 600, randomBytes(400));
    expect(done.statusCode, done.body).toBe(204);
    expect(done.headers["vola-file-id"]).toBeDefined();
  });

  it("requires application/offset+octet-stream (415) and an integer Upload-Offset (400)", async () => {
    const { id } = await create(10, { filename: "x.bin" });
    const wrongType = await app.inject({
      method: "PATCH",
      url: `/vola/uploads/${id}`,
      headers: { ...auth(), "content-type": "application/octet-stream", "upload-offset": "0" },
      payload: randomBytes(10),
    });
    expect(wrongType.statusCode).toBe(415);
    const noOffset = await app.inject({
      method: "PATCH",
      url: `/vola/uploads/${id}`,
      headers: { ...auth(), "content-type": PATCH_TYPE },
      payload: randomBytes(10),
    });
    expect(noOffset.statusCode).toBe(400);
    const negative = await patch(id, 0, randomBytes(10), { headers: { "upload-offset": "-1" } });
    expect(negative.statusCode).toBe(400);
  });

  it("a parallel PATCH on the same upload is 409 upload_locked", async () => {
    const data = randomBytes(20_000);
    const { id } = await create(data.length, { filename: "x.bin" });
    // The first PATCH streams slowly: the body is handed out in two halves, the second only
    // after the competing request has been answered.
    const body = new Readable({ read() {} });
    body.push(data.subarray(0, 10_000));
    const first = patch(id, 0, body);
    // Give the first request time to take the row lock.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await patch(id, 0, data.subarray(0, 10_000));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("upload_locked");
    const concurrentDelete = await del(id);
    expect(concurrentDelete.statusCode).toBe(409);
    body.push(data.subarray(10_000));
    body.push(null);
    const done = await first;
    expect(done.statusCode, done.body).toBe(204);
    expect(done.headers["upload-offset"]).toBe(String(data.length));
    expect(done.headers["vola-file-id"]).toBeDefined();
  });

  it("an interrupted PATCH keeps what arrived: HEAD tells the exact offset and the upload resumes", async () => {
    const data = randomBytes(600_000);
    const { id, instanceId } = await create(data.length, { filename: "resume.bin" });
    // A real socket: write 200 000 bytes of a body announced as the whole file, then cut.
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        method: "PATCH",
        path: `/vola/uploads/${id}`,
        headers: {
          ...auth(),
          "content-type": PATCH_TYPE,
          "upload-offset": "0",
          "content-length": String(data.length),
        },
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(data.subarray(0, 200_000), () => {
        setTimeout(() => req.destroy(), 100);
      });
    });
    // The server may still be committing the offset of the cut body.
    let offset = -1;
    for (let attempt = 0; attempt < 50 && offset < 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const probe = await head(id);
      const value = Number(probe.headers["upload-offset"]);
      if (value > 0 && value === (await stat(parts.path(id))).size) offset = value;
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(200_000);
    const rest = await patch(id, offset, data.subarray(offset));
    expect(rest.statusCode, rest.body).toBe(204);
    const fileId = rest.headers["vola-file-id"] as string;
    expect(await download(instanceId, fileId)).toEqual(data);
  });

  it("a PATCH on a completed upload is 409 upload_completed", async () => {
    const data = randomBytes(100);
    const { id } = await create(data.length, { filename: "x.bin" });
    expect((await patch(id, 0, data)).statusCode).toBe(204);
    const again = await patch(id, 100, Buffer.alloc(0));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("upload_completed");
  });
});

describe("metadata: folder_path, slug, parent_id, filetype", () => {
  it("lands the file in the folder (created when missing) under the slug, as a new version", async () => {
    const instanceId = randomUUID();
    const v1 = randomBytes(1000);
    const first = await create(v1.length, {
      filename: "report.pdf",
      instance_id: instanceId,
      folder_path: "docs/q4",
      slug: "report",
      filetype: "application/pdf",
    });
    expect(first.response.statusCode, first.response.body).toBe(201);
    const done1 = await patch(first.id, 0, v1);
    expect(done1.statusCode, done1.body).toBe(204);
    const file1 = await info(instanceId, done1.headers["vola-file-id"] as string);
    expect(file1).toMatchObject({
      slug: "report",
      filename: "report.pdf",
      mime_type: "application/pdf",
    });
    expect(file1.folder_id).not.toBeNull();
    const byPath = await app.inject({
      method: "GET",
      url: `/vola/files/${TYPE}/${instanceId}/path/docs/q4/report.pdf`,
      headers: bearer(fx.full.key),
    });
    expect(byPath.statusCode).toBe(200);
    expect(byPath.rawPayload).toEqual(v1);

    const v2 = randomBytes(1200);
    const second = await create(v2.length, {
      filename: "report.pdf",
      instance_id: instanceId,
      parent_id: file1.id,
      slug: "report",
    });
    expect(second.response.statusCode, second.response.body).toBe(201);
    const done2 = await patch(second.id, 0, v2);
    expect(done2.statusCode, done2.body).toBe(204);
    const file2 = await info(instanceId, done2.headers["vola-file-id"] as string);
    expect(file2).toMatchObject({
      parent_id: file1.id,
      folder_id: file1.folder_id,
      slug: "report",
    });
    expect(file2.filename).toBe("report.pdf"); // inherited, no "(1)" against its own chain
    // The slug upsert soft-deleted v1.
    const [old] = await handle.db.select().from(files).where(eq(files.id, file1.id));
    expect(old?.deletedAt).not.toBeNull();
  });

  it("validates folder_path, slug and metadata at creation", async () => {
    expect((await create(10, { filename: "x", folder_path: "a//b" })).response.statusCode).toBe(
      422,
    );
    expect((await create(10, { filename: "x", slug: "Not Valid" })).response.statusCode).toBe(422);
    expect((await create(10, { filename: "x", metadata: "[1]" })).response.statusCode).toBe(422);
    expect((await create(10, { filename: "x", metadata: "{" })).response.statusCode).toBe(422);
    expect((await create(10, { filename: "x", parent_id: "nope" })).response.statusCode).toBe(422);
  });
});

describe("DELETE", () => {
  it("removes the row and the part file; a second DELETE is 404", async () => {
    const { id } = await create(5000, { filename: "x.bin" });
    expect((await patch(id, 0, randomBytes(2000))).statusCode).toBe(204);
    expect(await partFiles()).toContain(`${id}.part`);
    const response = await del(id);
    expect(response.statusCode).toBe(204);
    expect(await partFiles()).not.toContain(`${id}.part`);
    expect((await head(id)).statusCode).toBe(404);
    expect((await del(id)).statusCode).toBe(404);
    expect((await patch(id, 0, randomBytes(10))).statusCode).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("another tenant's key sees 404 on HEAD, PATCH and DELETE; a second key of the same tenant may resume", async () => {
    const data = randomBytes(3000);
    const { id, instanceId } = await create(data.length, { filename: "x.bin" });
    expect((await patch(id, 0, data.subarray(0, 1000))).statusCode).toBe(204);
    expect((await head(id, other.key)).statusCode).toBe(404);
    expect((await patch(id, 1000, data.subarray(1000), { key: other.key })).statusCode).toBe(404);
    expect((await del(id, other.key)).statusCode).toBe(404);
    expect((await head(id)).headers["upload-offset"]).toBe("1000");

    const sibling = await mintKey(handle, fx.tenant.id, "sibling", "live", ["files:write"]);
    const done = await patch(id, 1000, data.subarray(1000), { key: sibling.key });
    expect(done.statusCode, done.body).toBe(204);
    expect(await download(instanceId, done.headers["vola-file-id"] as string)).toEqual(data);
    const bogus = await head(randomUUID());
    expect(bogus.statusCode).toBe(404);
    expect((await head("not-a-uuid")).statusCode).toBe(404);
  });
});

describe("expiration", () => {
  it("an expired upload is 410 on HEAD and PATCH; the sweep removes rows, part files and orphans", async () => {
    const { id } = await create(5000, { filename: "x.bin" });
    expect((await patch(id, 0, randomBytes(1000))).statusCode).toBe(204);
    const past = new Date(Date.now() - 1000);
    await handle.db.update(uploads).set({ expiresAt: past }).where(eq(uploads.id, id));
    const expired = await head(id);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe("upload_expired");
    expect((await patch(id, 1000, randomBytes(10))).statusCode).toBe(410);

    // A completed upload past its TTL goes too (its file stays), and an orphan part file that
    // nobody has written to for a TTL.
    const data = randomBytes(100);
    const finished = await create(data.length, { filename: "done.bin" });
    const done = await patch(finished.id, 0, data);
    expect(done.statusCode).toBe(204);
    await handle.db.update(uploads).set({ expiresAt: past }).where(eq(uploads.id, finished.id));
    const orphan = randomUUID();
    await parts.create(orphan);
    const live = await create(10, { filename: "live.bin" });

    const service: UploadsDeps = {
      db: handle.db,
      storage,
      parts,
      maxUploadBytes: MAX_UPLOAD,
      ttlMs: 0,
    };
    const swept = await sweepExpiredUploads(service);
    expect(swept.uploads).toBe(2);
    expect(swept.orphans).toBe(1);
    expect((await head(id)).statusCode).toBe(404);
    expect(await partFiles()).not.toContain(`${id}.part`);
    expect(await partFiles()).not.toContain(`${orphan}.part`);
    expect(await partFiles()).toContain(`${live.id}.part`);
    expect((await head(live.id)).statusCode).toBe(200);
    const [file] = await handle.db
      .select()
      .from(files)
      .where(eq(files.id, done.headers["vola-file-id"] as string));
    expect(file).toBeDefined();
  });
});
