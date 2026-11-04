import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInfoSchema, FileListSchema, PurgeResultSchema } from "@vol-a/core";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { files } from "../src/db/schema.js";
import { LastUsedThrottle } from "../src/services/apikeys.js";
import { parseLimit, parseMetadata } from "../src/services/files.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import {
  bearer,
  config,
  type Fixture,
  mintKey,
  setupFixture,
  testDatabase,
  truncate,
} from "./helpers.js";
import { fileUpload, multipartBody, multipartHeaders } from "./multipart.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let other: { tenantId: string; key: string };

const TYPE = "tickets";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
// A 1×1 PNG with a well-formed IHDR and IEND: `file-type` walks the chunk list, so the random
// bytes that make each run's hash unique sit INSIDE a well-formed `tEXt` chunk (length, type,
// data, CRC), never after IEND — random bytes after the signature made the detection flaky.
const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b55", "hex"),
  Buffer.from("0000004074455874", "hex"), // length 64, "tEXt"
  randomBytes(64),
  randomBytes(4), // CRC (not checked by file-type)
  Buffer.from("0000000049454e44ae426082", "hex"),
]);

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-files-"));
  storage = new FilesystemBackend(root);
  fx = await setupFixture(handle, { storage, accessThrottle: new LastUsedThrottle(60_000) });
  app = fx.app;
  await app.ready();
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other-full", "live", ["files:read", "files:write"]);
  other = { tenantId: tenant.id, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

/** `POST /files/:type/:id` with one file part. */
async function upload(
  data: Buffer,
  filename: string,
  options: {
    instanceId?: string;
    key?: string;
    contentType?: string;
    fields?: Record<string, string>;
    fieldsFirst?: boolean;
    headers?: Record<string, string>;
    type?: string;
  } = {},
) {
  const instanceId = options.instanceId ?? randomUUID();
  const response = await app.inject({
    method: "POST",
    url: `/vola/files/${options.type ?? TYPE}/${instanceId}`,
    headers: multipartHeaders({
      ...bearer(options.key ?? fx.full.key),
      ...(options.headers ?? {}),
    }),
    payload: fileUpload(filename, data, {
      contentType: options.contentType,
      fields: options.fields,
      fieldsFirst: options.fieldsFirst,
    }),
  });
  return { response, instanceId };
}

const get = (url: string, headers: Record<string, string> = {}, key = fx.full.key) =>
  app.inject({ method: "GET", url, headers: { ...bearer(key), ...headers } });
const head = (url: string, headers: Record<string, string> = {}, key = fx.full.key) =>
  app.inject({ method: "HEAD", url, headers: { ...bearer(key), ...headers } });
const del = (url: string, key = fx.full.key) =>
  app.inject({ method: "DELETE", url, headers: bearer(key) });

const blobsOnDisk = async () =>
  (await readdir(storage.blobsDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

describe("upload and download", () => {
  it("round-trips bytes exactly, with the headers of a download", async () => {
    const data = randomBytes(70_000);
    const { response, instanceId } = await upload(data, "report.pdf", {
      contentType: "application/pdf",
      headers: { "x-user-id": "igor" },
      fields: { metadata: JSON.stringify({ source: "scanner", pages: 3 }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info).toMatchObject({
      tenant_id: fx.tenant.id,
      instance_type: TYPE,
      instance_id: instanceId,
      slug: null,
      hash: sha256(data),
      size: data.length,
      filename: "report.pdf",
      extension: "pdf",
      mime_type: "application/pdf",
      kind: "document",
      metadata: { source: "scanner", pages: 3 },
      folder_id: null,
      parent_id: null,
      is_public: false,
      is_global_public: false,
      encryption: "none",
      enc_format: null,
      keyring_id: null,
      created_by: "igor",
      deleted_at: null,
      last_accessed_at: null,
    });
    expect(response.json()).not.toHaveProperty("fk_ct");
    expect(response.json()).not.toHaveProperty("meta_ct");
    expect(await storage.exists(info.hash)).toBe(true);
    expect(await readdir(storage.tmpDir)).toEqual([]);

    const download = await get(`/vola/files/${TYPE}/${instanceId}/${info.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(data)).toBe(true);
    expect(download.headers).toMatchObject({
      "content-type": "application/pdf",
      "content-length": String(data.length),
      "accept-ranges": "bytes",
      etag: `"${info.hash}"`,
      "content-disposition": 'inline; filename="report.pdf"',
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-cache",
    });
    expect(download.headers["last-modified"]).toBe(new Date(info.created_at).toUTCString());
  });

  it("detects the MIME type from magic bytes, then the extension, then the declared type", async () => {
    const png = await upload(PNG, "notes.txt", { contentType: "text/plain" });
    expect(png.response.json()).toMatchObject({
      mime_type: "image/png",
      kind: "image",
      extension: "txt",
    });
    const text = await upload(Buffer.from("plain words"), "notes.md", { contentType: "x/y" });
    expect(text.response.json()).toMatchObject({ mime_type: "text/markdown", kind: "text" });
    const declared = await upload(Buffer.from("opaque"), "blob", {
      contentType: "application/x-thing",
    });
    expect(declared.response.json()).toMatchObject({
      mime_type: "application/x-thing",
      kind: "other",
      extension: null,
    });
    const nothing = await upload(Buffer.from("opaque"), "blob", { contentType: "garbage" });
    expect(nothing.response.json().mime_type).toBe("application/octet-stream");
  });

  it("serves media inline, SVG and the rest as attachment, and ?download=1 forces attachment", async () => {
    const image = await upload(PNG, "photo.png");
    const imageUrl = `/vola/files/${TYPE}/${image.instanceId}/${image.response.json().id}`;
    expect((await get(imageUrl)).headers["content-disposition"]).toBe(
      'inline; filename="photo.png"',
    );
    expect((await get(`${imageUrl}?download=1`)).headers["content-disposition"]).toBe(
      'attachment; filename="photo.png"',
    );
    const svg = await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "logo.svg");
    const svgResponse = await get(
      `/vola/files/${TYPE}/${svg.instanceId}/${svg.response.json().id}`,
    );
    expect(svgResponse.headers["content-type"]).toBe("image/svg+xml");
    expect(svgResponse.headers["content-disposition"]).toBe('attachment; filename="logo.svg"');
    const unicode = await upload(Buffer.from("x"), "Račun №7.txt");
    const unicodeResponse = await get(
      `/vola/files/${TYPE}/${unicode.instanceId}/${unicode.response.json().id}`,
    );
    expect(unicodeResponse.headers["content-disposition"]).toBe(
      "attachment; filename=\"Ra_un _7.txt\"; filename*=UTF-8''Ra%C4%8Dun%20%E2%84%967.txt",
    );
  });

  it("deduplicates: the same bytes twice are two files and one blob", async () => {
    const data = randomBytes(5000);
    const before = (await blobsOnDisk()).length;
    const first = await upload(data, "one.bin");
    const second = await upload(data, "two.bin");
    expect(first.response.statusCode).toBe(201);
    expect(second.response.statusCode).toBe(201);
    expect(first.response.json().hash).toBe(second.response.json().hash);
    expect(first.response.json().id).not.toBe(second.response.json().id);
    expect((await blobsOnDisk()).length).toBe(before + 1);
    expect(await readdir(storage.tmpDir)).toEqual([]);
  });

  it("renames collisions within the instance: a.pdf → a (1).pdf → a (2).pdf", async () => {
    const instanceId = randomUUID();
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { response } = await upload(Buffer.from(`content ${i}`), "a.pdf", { instanceId });
      names.push(response.json().filename);
    }
    expect(names).toEqual(["a.pdf", "a (1).pdf", "a (2).pdf"]);
    // Another instance has its own namespace.
    const elsewhere = await upload(Buffer.from("content 9"), "a.pdf");
    expect(elsewhere.response.json().filename).toBe("a.pdf");
    // A name without an extension, and a LIKE special character in the base.
    const instance2 = randomUUID();
    expect(
      (await upload(Buffer.from("r1"), "README", { instanceId: instance2 })).response.json()
        .filename,
    ).toBe("README");
    expect(
      (await upload(Buffer.from("r2"), "README", { instanceId: instance2 })).response.json()
        .filename,
    ).toBe("README (1)");
    expect(
      (await upload(Buffer.from("p1"), "100%.txt", { instanceId: instance2 })).response.json()
        .filename,
    ).toBe("100%.txt");
    expect(
      (await upload(Buffer.from("p2"), "100%.txt", { instanceId: instance2 })).response.json()
        .filename,
    ).toBe("100% (1).txt");
  });

  it("stores the empty file", async () => {
    const { response, instanceId } = await upload(Buffer.alloc(0), "empty.txt");
    expect(response.statusCode).toBe(201);
    expect(response.json().size).toBe(0);
    const download = await get(`/vola/files/${TYPE}/${instanceId}/${response.json().id}`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toHaveLength(0);
    expect(download.headers["content-length"]).toBe("0");
  });

  it("accepts the text fields before or after the file part", async () => {
    const first = await upload(Buffer.from("x"), "f.txt", {
      fields: { metadata: '{"a":1}' },
      fieldsFirst: true,
    });
    expect(first.response.json().metadata).toEqual({ a: 1 });
    const after = await upload(Buffer.from("x"), "f.txt", { fields: { metadata: '{"b":2}' } });
    expect(after.response.json().metadata).toEqual({ b: 2 });
  });

  it("sanitises the filename and falls back to unnamed", async () => {
    const path = await upload(Buffer.from("x"), "C:\\Users\\me\\..\\evil.txt");
    expect(path.response.json().filename).toBe("evil.txt");
    const empty = await upload(Buffer.from("x"), "");
    expect(empty.response.json().filename).toBe("unnamed");
  });
});

describe("upload validation", () => {
  it("refuses an unknown parent_id (404) and a bad folder_path (422) and leaves no blob behind", async () => {
    const data = randomBytes(3000);
    const attempts: [Record<string, string>, number, string][] = [
      [{ parent_id: randomUUID() }, 404, "file_not_found"],
      [{ folder_path: "docs/../q4" }, 422, "validation_error"],
      [{ folder_path: "docs", folder_id: randomUUID() }, 422, "validation_error"],
      [{ folder_id: randomUUID() }, 404, "folder_not_found"],
    ];
    for (const [fields, status, code] of attempts) {
      const { response } = await upload(data, "x.bin", { fields });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error.code).toBe(code);
    }
    expect(await storage.exists(sha256(data))).toBe(false);
    expect(await readdir(storage.tmpDir)).toEqual([]);
  });

  it("needs exactly one `file` part", async () => {
    const none = await app.inject({
      method: "POST",
      url: `/vola/files/${TYPE}/${randomUUID()}`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: multipartBody([{ name: "metadata", value: "{}" }]),
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe("file_required");

    const two = await app.inject({
      method: "POST",
      url: `/vola/files/${TYPE}/${randomUUID()}`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: multipartBody([
        { name: "file", filename: "a.txt", data: Buffer.from("a") },
        { name: "file", filename: "b.txt", data: Buffer.from("b") },
      ]),
    });
    expect(two.statusCode).toBe(400);
    expect(two.json().error.code).toBe("bad_request");

    const wrongField = await app.inject({
      method: "POST",
      url: `/vola/files/${TYPE}/${randomUUID()}`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: multipartBody([{ name: "upload", filename: "a.txt", data: Buffer.from("a") }]),
    });
    expect(wrongField.statusCode).toBe(400);
    expect(await readdir(storage.tmpDir)).toEqual([]);
  });

  it("answers 415 for a body that is not multipart", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/vola/files/${TYPE}/${randomUUID()}`,
      headers: { ...bearer(fx.full.key), "content-type": "application/json" },
      payload: { file: "nope" },
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("unsupported_media_type");
  });

  it("validates instance type, instance id, slug and metadata", async () => {
    const badType = await upload(Buffer.from("x"), "x.txt", { type: "Tickets" });
    expect(badType.response.statusCode).toBe(422);
    expect(badType.response.json().error.message).toMatch(/^instance_type/);
    const badId = await upload(Buffer.from("x"), "x.txt", { instanceId: "not-a-uuid" });
    expect(badId.response.statusCode).toBe(422);
    expect(badId.response.json().error.message).toMatch(/^instance_id/);
    for (const metadata of ["not json", "[1,2]", '"string"', "42"]) {
      const { response } = await upload(Buffer.from("x"), "x.txt", { fields: { metadata } });
      expect(response.statusCode, metadata).toBe(422);
      expect(response.json().error.message).toMatch(/^metadata/);
    }
    const badSlug = await app.inject({
      method: "PUT",
      url: `/vola/files/${TYPE}/${randomUUID()}/slug/Bad_Slug`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: fileUpload("x.txt", Buffer.from("x")),
    });
    expect(badSlug.statusCode).toBe(422);
    expect(badSlug.json().error.message).toMatch(/^slug/);
    expect(await readdir(storage.tmpDir)).toEqual([]);
    expect(parseMetadata(undefined)).toEqual({});
    expect(() => parseMetadata("{")).toThrow(/metadata/);
    expect(parseLimit(undefined)).toBe(50);
    expect(() => parseLimit("0")).toThrow(/limit/);
  });

  it("answers 413 file_too_large beyond VOLA_MAX_UPLOAD_BYTES and keeps nothing", async () => {
    const small = await buildApp({
      config: { ...config, maxUploadBytes: 1024 },
      db: handle.db,
      logger: false,
      storage,
    });
    try {
      const data = randomBytes(2048);
      const response = await small.inject({
        method: "POST",
        url: `/vola/files/${TYPE}/${randomUUID()}`,
        headers: multipartHeaders(bearer(fx.full.key)),
        payload: fileUpload("big.bin", data),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe("file_too_large");
      expect(await storage.exists(sha256(data))).toBe(false);
      expect(await storage.exists(sha256(data.subarray(0, 1024)))).toBe(false);
      expect(await readdir(storage.tmpDir)).toEqual([]);

      const fits = await small.inject({
        method: "POST",
        url: `/vola/files/${TYPE}/${randomUUID()}`,
        headers: multipartHeaders(bearer(fx.full.key)),
        payload: fileUpload("ok.bin", randomBytes(1024)),
      });
      expect(fits.statusCode).toBe(201);
    } finally {
      await small.close();
    }
  });
});

describe("slug upsert", () => {
  it("keeps one live file per slug and soft-deletes the previous one in the same transaction", async () => {
    const instanceId = randomUUID();
    const put = (data: Buffer, name: string) =>
      app.inject({
        method: "PUT",
        url: `/vola/files/${TYPE}/${instanceId}/slug/avatar`,
        headers: multipartHeaders({ ...bearer(fx.full.key), "x-user-id": "igor" }),
        payload: fileUpload(name, data, { contentType: "image/png" }),
      });
    const v1 = await put(PNG, "avatar.png");
    expect(v1.statusCode).toBe(201);
    expect(v1.json()).toMatchObject({ slug: "avatar", filename: "avatar.png" });

    const v2data = Buffer.concat([PNG, Buffer.from("v2")]);
    const v2 = await put(v2data, "avatar.png");
    expect(v2.statusCode).toBe(201);
    // Same name again: the previous one is gone (soft) before the collision check.
    expect(v2.json()).toMatchObject({ slug: "avatar", filename: "avatar.png" });

    const bySlug = await get(`/vola/files/${TYPE}/${instanceId}/slug/avatar`);
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.rawPayload.equals(v2data)).toBe(true);
    expect(bySlug.headers.etag).toBe(`"${v2.json().hash}"`);

    const live = await handle.db
      .select()
      .from(files)
      .where(
        and(eq(files.instanceId, instanceId), eq(files.slug, "avatar"), isNull(files.deletedAt)),
      );
    expect(live.map((row) => row.id)).toEqual([v2.json().id]);
    const [old] = await handle.db.select().from(files).where(eq(files.id, v1.json().id));
    expect(old?.deletedAt).toBeInstanceOf(Date);
    expect(old?.deletedBy).toBe("igor");
    expect((await get(`/vola/files/${TYPE}/${instanceId}/${v1.json().id}`)).statusCode).toBe(404);

    const missing = await get(`/vola/files/${TYPE}/${instanceId}/slug/cover`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("file_not_found");
    const badSlug = await get(`/vola/files/${TYPE}/${instanceId}/slug/Cover`);
    expect(badSlug.statusCode).toBe(422);
  });

  it("names a slug file after the slug when the part has no filename", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/vola/files/${TYPE}/${randomUUID()}/slug/cover`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: fileUpload("", Buffer.from("x")),
    });
    expect(response.json().filename).toBe("cover");
  });
});

describe("Range, HEAD and ETag", () => {
  const data = randomBytes(10_000);
  let url: string;
  let hash: string;

  beforeAll(async () => {
    const { response, instanceId } = await upload(data, "clip.mp4", { contentType: "video/mp4" });
    url = `/vola/files/${TYPE}/${instanceId}/${response.json().id}`;
    hash = response.json().hash;
  });

  it("answers 206 for a range at the start, in the middle, open-ended and as a suffix", async () => {
    const cases: [string, number, number][] = [
      ["bytes=0-999", 0, 999],
      ["bytes=4000-4999", 4000, 4999],
      ["bytes=9000-", 9000, 9999],
      ["bytes=-500", 9500, 9999],
      ["bytes=9990-20000", 9990, 9999],
    ];
    for (const [range, start, end] of cases) {
      const response = await get(url, { range });
      expect(response.statusCode, range).toBe(206);
      expect(response.headers["content-range"]).toBe(`bytes ${start}-${end}/${data.length}`);
      expect(response.headers["content-length"]).toBe(String(end - start + 1));
      expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers.etag).toBe(`"${hash}"`);
      expect(response.headers["content-type"]).toBe("video/mp4");
      expect(response.rawPayload.equals(data.subarray(start, end + 1)), range).toBe(true);
    }
  });

  it("answers 416 with Content-Range: bytes */size for a range outside the file", async () => {
    for (const range of ["bytes=10000-", "bytes=20000-30000", "bytes=-0"]) {
      const response = await get(url, { range });
      expect(response.statusCode, range).toBe(416);
      expect(response.headers["content-range"]).toBe(`bytes */${data.length}`);
      expect(response.json().error.code).toBe("range_not_satisfiable");
    }
    const headResponse = await head(url, { range: "bytes=10000-" });
    expect(headResponse.statusCode).toBe(416);
    expect(headResponse.headers["content-range"]).toBe(`bytes */${data.length}`);
    expect(headResponse.rawPayload).toHaveLength(0);
  });

  it("serves the whole file for a multi-range or malformed Range", async () => {
    for (const range of ["bytes=0-99,200-299", "items=0-10", "bytes=abc", "bytes=10-5"]) {
      const response = await get(url, { range });
      expect(response.statusCode, range).toBe(200);
      expect(response.headers["content-length"]).toBe(String(data.length));
      expect(response.rawPayload.equals(data)).toBe(true);
    }
  });

  it("HEAD carries the headers of the GET and no body", async () => {
    const full = await head(url);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload).toHaveLength(0);
    expect(full.headers).toMatchObject({
      "content-type": "video/mp4",
      "content-length": String(data.length),
      "accept-ranges": "bytes",
      etag: `"${hash}"`,
      "content-disposition": 'inline; filename="clip.mp4"',
      "x-content-type-options": "nosniff",
    });
    const partial = await head(url, { range: "bytes=0-99" });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["content-range"]).toBe(`bytes 0-99/${data.length}`);
    expect(partial.headers["content-length"]).toBe("100");
    expect(partial.rawPayload).toHaveLength(0);
  });

  it("answers 304 to a matching If-None-Match (strong, weak or *)", async () => {
    for (const value of [`"${hash}"`, `W/"${hash}"`, "*", `"other", "${hash}"`]) {
      const response = await get(url, { "if-none-match": value });
      expect(response.statusCode, value).toBe(304);
      expect(response.rawPayload).toHaveLength(0);
      expect(response.headers.etag).toBe(`"${hash}"`);
    }
    const stale = await get(url, { "if-none-match": '"somethingelse"' });
    expect(stale.statusCode).toBe(200);
  });

  it("records last_accessed_at on a GET at most once a minute, never on a HEAD", async () => {
    const fresh = await upload(randomBytes(100), "access.bin", {
      headers: { "x-user-id": "reader" },
    });
    const freshUrl = `/vola/files/${TYPE}/${fresh.instanceId}/${fresh.response.json().id}`;
    const read = async () =>
      (await handle.db.select().from(files).where(eq(files.id, fresh.response.json().id)))[0];
    await head(freshUrl);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await read())?.lastAccessedAt).toBeNull();

    await get(freshUrl, { "x-user-id": "viewer" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const first = await read();
    expect(first?.lastAccessedAt).toBeInstanceOf(Date);
    expect(first?.lastAccessedBy).toBe("viewer");

    await get(freshUrl, { "x-user-id": "someone-else" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await read();
    expect(second?.lastAccessedAt?.getTime()).toBe(first?.lastAccessedAt?.getTime());
    expect(second?.lastAccessedBy).toBe("viewer");
    const info = await get(`${freshUrl}/info`);
    expect(info.json().last_accessed_by).toBe("viewer");
  });
});

describe("info and list", () => {
  it("returns the metadata of a file without fk_ct / meta_ct", async () => {
    const { response, instanceId } = await upload(Buffer.from("info"), "i.txt");
    const info = await get(`/vola/files/${TYPE}/${instanceId}/${response.json().id}/info`);
    expect(info.statusCode).toBe(200);
    expect(FileInfoSchema.parse(info.json())).toEqual(response.json());
    expect(Object.keys(info.json())).not.toContain("fk_ct");
    expect(Object.keys(info.json())).not.toContain("meta_ct");
  });

  it("lists an instance newest first with cursor pagination and include_deleted", async () => {
    const instanceId = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { response } = await upload(Buffer.from(`list ${i}`), `f${i}.txt`, { instanceId });
      ids.push(response.json().id);
    }
    const page1 = await get(`/vola/files/${TYPE}/${instanceId}?limit=2`);
    expect(page1.statusCode).toBe(200);
    const list1 = FileListSchema.parse(page1.json());
    expect(list1.files.map((f) => f.id)).toEqual([ids[4], ids[3]]);
    expect(list1.next_cursor).toBeTruthy();
    const page2 = await get(
      `/vola/files/${TYPE}/${instanceId}?limit=2&cursor=${list1.next_cursor}`,
    );
    const list2 = FileListSchema.parse(page2.json());
    expect(list2.files.map((f) => f.id)).toEqual([ids[2], ids[1]]);
    const page3 = await get(
      `/vola/files/${TYPE}/${instanceId}?limit=2&cursor=${list2.next_cursor}`,
    );
    const list3 = FileListSchema.parse(page3.json());
    expect(list3.files.map((f) => f.id)).toEqual([ids[0]]);
    expect(list3.next_cursor).toBeNull();

    const all = FileListSchema.parse((await get(`/vola/files/${TYPE}/${instanceId}`)).json());
    expect(all.files).toHaveLength(5);
    expect(all.next_cursor).toBeNull();

    await del(`/vola/files/${TYPE}/${instanceId}/${ids[2]}`);
    const live = FileListSchema.parse((await get(`/vola/files/${TYPE}/${instanceId}`)).json());
    expect(live.files.map((f) => f.id)).toEqual([ids[4], ids[3], ids[1], ids[0]]);
    const withDeleted = FileListSchema.parse(
      (await get(`/vola/files/${TYPE}/${instanceId}?include_deleted=1`)).json(),
    );
    expect(withDeleted.files).toHaveLength(5);
    expect(withDeleted.files.find((f) => f.id === ids[2])?.deleted_at).toBeTruthy();

    const empty = FileListSchema.parse((await get(`/vola/files/${TYPE}/${randomUUID()}`)).json());
    expect(empty).toEqual({ files: [], next_cursor: null });
  });

  it("validates limit and cursor", async () => {
    const instanceId = randomUUID();
    for (const query of ["limit=0", "limit=201", "limit=abc", "cursor=nonsense", "cursor=YWJj"]) {
      const response = await get(`/vola/files/${TYPE}/${instanceId}?${query}`);
      expect(response.statusCode, query).toBe(422);
      expect(response.json().error.code).toBe("validation_error");
    }
  });
});

describe("soft delete and purge", () => {
  it("soft delete hides the file (404) but keeps row and bytes; it is idempotent", async () => {
    const data = randomBytes(2000);
    const { response, instanceId } = await upload(data, "gone.bin", {
      headers: { "x-user-id": "igor" },
    });
    const id = response.json().id;
    const url = `/vola/files/${TYPE}/${instanceId}/${id}`;
    const deleted = await app.inject({
      method: "DELETE",
      url,
      headers: { ...bearer(fx.full.key), "x-user-id": "igor" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ id, deleted_by: "igor" });
    expect(deleted.json().deleted_at).toBeTruthy();

    expect((await get(url)).statusCode).toBe(404);
    expect((await get(url)).json().error.code).toBe("file_not_found");
    expect((await head(url)).statusCode).toBe(404);
    expect((await get(`${url}/info`)).statusCode).toBe(404);
    const info = await get(`${url}/info?include_deleted=1`);
    expect(info.statusCode).toBe(200);
    expect(info.json().deleted_at).toBe(deleted.json().deleted_at);
    expect(await storage.exists(sha256(data))).toBe(true);

    const again = await del(url);
    expect(again.statusCode).toBe(200);
    expect(again.json().deleted_at).toBe(deleted.json().deleted_at);
    expect((await del(`/vola/files/${TYPE}/${instanceId}/${randomUUID()}`)).statusCode).toBe(404);
    expect((await del(`/vola/files/${TYPE}/${instanceId}/not-a-uuid`)).statusCode).toBe(404);
  });

  it("purge removes the row, and the blob only when no row of any tenant references it", async () => {
    const data = randomBytes(4000);
    const hash = sha256(data);
    const mine = await upload(data, "shared.bin");
    const theirs = await upload(data, "shared.bin", { key: other.key });
    expect(theirs.response.statusCode).toBe(201);
    expect(await storage.exists(hash)).toBe(true);

    const purged = await del(
      `/vola/files/${TYPE}/${mine.instanceId}/${mine.response.json().id}/purge`,
    );
    expect(purged.statusCode).toBe(200);
    expect(PurgeResultSchema.parse(purged.json())).toEqual({ files: 1, blobs: 0 });
    expect(await storage.exists(hash)).toBe(true); // the other tenant still references it
    expect(
      await handle.db.select().from(files).where(eq(files.id, mine.response.json().id)),
    ).toEqual([]);
    expect(
      (
        await get(
          `/vola/files/${TYPE}/${mine.instanceId}/${mine.response.json().id}/info?include_deleted=1`,
        )
      ).statusCode,
    ).toBe(404);

    const purgedTheirs = await del(
      `/vola/files/${TYPE}/${theirs.instanceId}/${theirs.response.json().id}/purge`,
      other.key,
    );
    expect(purgedTheirs.json()).toEqual({ files: 1, blobs: 1 });
    expect(await storage.exists(hash)).toBe(false);
  });

  it("keeps the blob while a soft-deleted row references it, and purges a soft-deleted file", async () => {
    const data = randomBytes(4000);
    const hash = sha256(data);
    const a = await upload(data, "a.bin");
    const b = await upload(data, "b.bin");
    const urlA = `/vola/files/${TYPE}/${a.instanceId}/${a.response.json().id}`;
    const urlB = `/vola/files/${TYPE}/${b.instanceId}/${b.response.json().id}`;
    expect((await del(urlA)).statusCode).toBe(200); // soft
    expect((await del(`${urlB}/purge`)).json()).toEqual({ files: 1, blobs: 0 });
    expect(await storage.exists(hash)).toBe(true); // the soft-deleted a still references it
    expect((await del(`${urlA}/purge`)).json()).toEqual({ files: 1, blobs: 1 });
    expect(await storage.exists(hash)).toBe(false);
    expect((await del(`${urlA}/purge`)).statusCode).toBe(404);
  });

  it("removes derived files with the blob", async () => {
    const data = randomBytes(300);
    const { response, instanceId } = await upload(data, "with-thumb.png");
    await storage.putDerived(response.json().hash, "thumb.64.center.webp", Buffer.from("thumb"));
    expect(await storage.statDerived(response.json().hash, "thumb.64.center.webp")).not.toBeNull();
    await del(`/vola/files/${TYPE}/${instanceId}/${response.json().id}/purge`);
    expect(await storage.statDerived(response.json().hash, "thumb.64.center.webp")).toBeNull();
  });

  it("still answers when the disk removal fails (logged, blobs: 0)", async () => {
    const { response, instanceId } = await upload(randomBytes(300), "stubborn.bin");
    const spy = vi.spyOn(storage, "remove").mockRejectedValueOnce(new Error("EIO"));
    try {
      const purged = await del(`/vola/files/${TYPE}/${instanceId}/${response.json().id}/purge`);
      expect(purged.statusCode).toBe(200);
      expect(purged.json()).toEqual({ files: 1, blobs: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(await handle.db.select().from(files).where(eq(files.id, response.json().id))).toEqual(
      [],
    );
  });
});

describe("tenant isolation and scopes", () => {
  it("answers 404 (never 403) for another tenant's file on every route", async () => {
    const { response, instanceId } = await upload(Buffer.from("mine"), "mine.txt");
    const id = response.json().id;
    const base = `/vola/files/${TYPE}/${instanceId}`;
    for (const [method, url] of [
      ["GET", `${base}/${id}`],
      ["HEAD", `${base}/${id}`],
      ["GET", `${base}/${id}/info`],
      ["DELETE", `${base}/${id}`],
      ["DELETE", `${base}/${id}/purge`],
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(other.key) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      if (method !== "HEAD") expect(res.json().error.code).toBe("file_not_found");
    }
    const list = await get(base, {}, other.key);
    expect(list.json()).toEqual({ files: [], next_cursor: null });
    // Still there for its owner.
    expect((await get(`${base}/${id}`)).statusCode).toBe(200);
    // A slug of mine is not theirs either.
    await app.inject({
      method: "PUT",
      url: `${base}/slug/avatar`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: fileUpload("a.png", PNG),
    });
    expect((await get(`${base}/slug/avatar`, {}, other.key)).statusCode).toBe(404);
    expect((await get(`${base}/slug/avatar`)).statusCode).toBe(200);
  });

  it("enforces files:write for uploads and deletes, files:read for downloads", async () => {
    const { response, instanceId } = await upload(Buffer.from("scoped"), "s.txt");
    const id = response.json().id;
    const url = `/vola/files/${TYPE}/${instanceId}/${id}`;
    const readOnlyUpload = await upload(Buffer.from("x"), "x.txt", { key: fx.readOnly.key });
    expect(readOnlyUpload.response.statusCode).toBe(403);
    expect(readOnlyUpload.response.json().error.required).toEqual(["files:write"]);
    expect((await del(url, fx.readOnly.key)).statusCode).toBe(403);
    expect((await del(`${url}/purge`, fx.readOnly.key)).statusCode).toBe(403);
    expect((await get(url, {}, fx.readOnly.key)).statusCode).toBe(200);

    const writeOnly = await mintKey(handle, fx.tenant.id, "write-only", "live", ["files:write"]);
    expect((await get(url, {}, writeOnly.key)).statusCode).toBe(403);
    expect((await get(`${url}/info`, {}, writeOnly.key)).statusCode).toBe(403);
    expect((await get(`/vola/files/${TYPE}/${instanceId}`, {}, writeOnly.key)).statusCode).toBe(
      403,
    );

    const admin = await app.inject({
      method: "GET",
      url,
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "acme" },
    });
    expect(admin.statusCode).toBe(200);
    const noTenant = await app.inject({ method: "GET", url, headers: bearer(fx.admin.key) });
    expect(noTenant.statusCode).toBe(400);
    expect(noTenant.json().error.code).toBe("tenant_required");
    expect((await get(url, {}, `vola_live_${"A".repeat(32)}`)).statusCode).toBe(401);
  });

  it("answers 404 for unknown and malformed file ids", async () => {
    const instanceId = randomUUID();
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const response = await get(`/vola/files/${TYPE}/${instanceId}/${id}`);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("file_not_found");
    }
  });
});
