import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "@jsudc/core";
import {
  encodeTusMetadata,
  FileInfoSchema,
  FileListSchema,
  FileVersionsSchema,
  INTEGRITY_ERROR_MESSAGE,
  TransferResultSchema,
} from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuditLog } from "../src/audit/log.js";
import type { AuditEvent } from "../src/audit/memento.js";
import { runWithTenant } from "../src/context.js";
import {
  ciphertextLengthFor,
  DEFAULT_SEGMENT_BYTES,
  generateKeyLine,
  HEADER_BYTES,
  keyId,
  TAG_BYTES,
  TENANT_FK_CT_BYTES,
} from "../src/crypto/index.js";
import { files } from "../src/db/schema.js";
import { LocalFileEventBus } from "../src/events/bus.js";
import { createTenant, setTenantDefaultEncryption } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { ENCRYPTED_FILENAME, FilesCollectionSource } from "../src/udc/files-source.js";
import { pngFixture } from "./fixtures.js";
import {
  bearer,
  config,
  type Fixture,
  mintKey,
  setupFixture,
  testDatabase,
  truncate,
} from "./helpers.js";
import { httpClient } from "./http.js";
import { fileUpload, multipartHeaders } from "./multipart.js";

const handle = testDatabase(6);
let fx: Fixture;
let app: FastifyInstance;
/** The same database and storage, but no key file: everything encrypted is 503 here. */
let keyless: FastifyInstance;
let root: string;
let keyFile: string;
let storage: FilesystemBackend;
let events: LocalFileEventBus;
let http: ReturnType<typeof httpClient>;
let audited: AuditEvent[];
let beta: { id: string; slug: string; key: string };

const TYPE = "tickets";
const S = DEFAULT_SEGMENT_BYTES;
const MAX_UPLOAD = 8 * 1024 * 1024;
const TUS = { "tus-resumable": "1.0.0" };
const PATCH_TYPE = "application/offset+octet-stream";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** 64 bytes that must never appear in a blob on disk. */
const MARKER = randomBytes(64);
const SECRET = Buffer.concat([Buffer.from("top secret: "), MARKER, Buffer.from("\nend\n")]);
const line0 = generateKeyLine();

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-encryption-"));
  keyFile = join(root, "vola.key");
  await writeFile(keyFile, `${line0}\n`, { mode: 0o600 });
  storage = new FilesystemBackend(join(root, "storage"));
  events = new LocalFileEventBus();
  audited = [];
  const audit = new AuditLog({
    sink: {
      async send(event) {
        audited.push(event);
      },
    },
  });
  const cfg = {
    ...config,
    keyFile,
    storagePath: join(root, "storage"),
    maxUploadBytes: MAX_UPLOAD,
  };
  fx = await setupFixture(handle, {
    storage,
    events,
    audit,
    config: cfg,
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.ready();
  keyless = await buildApp({
    config: { ...cfg, keyFile: join(root, "absent.key") },
    db: handle.db,
    logger: false,
    storage,
    events: false,
    uploadSweepIntervalMs: 0,
  });
  await keyless.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "beta", name: "Beta" });
  const key = await mintKey(handle, tenant.id, "beta-full", "live", ["files:read", "files:write"]);
  beta = { id: tenant.id, slug: tenant.slug, key: key.key };
});
afterAll(async () => {
  await app.close();
  await keyless.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  audited.length = 0;
  events.published.length = 0;
});

// --- helpers -----------------------------------------------------------------------------

const ENC = { fields: { encryption: "tenant" }, fieldsFirst: true };

async function uploadEncrypted(
  data: Buffer,
  filename: string,
  options: {
    instanceId?: string;
    contentType?: string;
    key?: string;
    fields?: Record<string, string>;
  } = {},
) {
  const { response, instanceId } = await http.upload(data, filename, {
    ...ENC,
    ...options,
    fields: { ...ENC.fields, ...(options.fields ?? {}) },
  });
  expect(response.statusCode, response.body).toBe(201);
  return { info: FileInfoSchema.parse(response.json()), instanceId };
}

const url = (instanceId: string, fileId: string, suffix = "") =>
  `/vola/files/${TYPE}/${instanceId}/${fileId}${suffix}`;

async function row(id: string) {
  const [found] = await handle.db.select().from(files).where(eq(files.id, id));
  return found as typeof files.$inferSelect;
}

const blobOf = async (hash: string) => readFile(storage.blobPath(hash));

async function udc(action: string, payload: unknown, instance: FastifyInstance = app) {
  const response = await instance.inject({
    method: "POST",
    url: `/vola/udc/${action}`,
    headers: { ...bearer(fx.full.key), "x-udc-message-id": "m1" },
    payload: payload as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { kind: string; payload: Record<string, unknown> };
  expect(body.kind, JSON.stringify(body)).toBe(`udc.${action}.ok`);
  return body.payload;
}

// --- upload ------------------------------------------------------------------------------

describe("encrypted upload (encryption=tenant)", () => {
  it("stores a JSV blob that is not the plaintext and a row that reveals nothing", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "Plan Ž.txt", {
      fields: { metadata: JSON.stringify({ project: "x" }) },
    });
    // The 201 shows the real values (the server holds the key).
    expect(info).toMatchObject({
      filename: "Plan Ž.txt",
      extension: "txt",
      mime_type: "text/plain",
      kind: "text",
      metadata: { project: "x" },
      encryption: "tenant",
      enc_format: 1,
      size: SECRET.length,
      processing_status: null,
    });
    expect(info.hash).not.toBe(sha256(SECRET));

    const stored = await row(info.id);
    expect(stored.filename).toBe(`${info.id}.bin`);
    expect(stored.mimeType).toBe("application/octet-stream");
    expect(stored.extension).toBeNull();
    expect(stored.kind).toBe("other");
    expect(stored.metadata).toEqual({});
    expect(Number(stored.size)).toBe(SECRET.length);
    expect(stored.encFormat).toBe(1);
    expect(stored.fkCt?.length).toBe(TENANT_FK_CT_BYTES);
    expect(stored.fkCt?.subarray(0, 4)).toEqual(keyId(Buffer.from(line0, "base64")));
    expect(stored.metaCt).toBeInstanceOf(Buffer);
    const asText = JSON.stringify({ ...stored, fkCt: null, metaCt: null });
    expect(asText).not.toContain("Plan");
    expect(asText).not.toContain("text/plain");

    const blob = await blobOf(info.hash);
    expect(sha256(blob)).toBe(info.hash);
    expect(blob.subarray(0, 3).toString()).toBe("JSV");
    expect(blob.length).toBe(ciphertextLengthFor(SECRET.length, S));
    expect(blob.includes(MARKER)).toBe(false);
    expect(blob.includes(Buffer.from("top secret"))).toBe(false);
    expect(blob.equals(SECRET)).toBe(false);

    // The event carried only ids; the list shows the real name.
    expect(events.published.at(-1)).toMatchObject({ fileId: info.id, kind: "created" });
    const list = FileListSchema.parse((await http.get(`/vola/files/${TYPE}/${instanceId}`)).json());
    expect(list.files[0]).toMatchObject({
      id: info.id,
      filename: "Plan Ž.txt",
      mime_type: "text/plain",
    });
  });

  it("takes the mode from X-Vola-Encryption too, and from a field after the file when it agrees", async () => {
    const header = await http.upload(SECRET, "h.txt", {
      headers: { "x-vola-encryption": "tenant" },
    });
    expect(header.response.statusCode, header.response.body).toBe(201);
    expect(header.response.json()).toMatchObject({ encryption: "tenant", filename: "h.txt" });
    const after = await http.upload(SECRET, "a.txt", {
      headers: { "x-vola-encryption": "tenant" },
      fields: { encryption: "tenant" },
    });
    expect(after.response.statusCode, after.response.body).toBe(201);
    // Plain by default.
    const plain = await http.upload(SECRET, "p.txt");
    expect(plain.response.json()).toMatchObject({ encryption: "none", hash: sha256(SECRET) });
  });

  it("refuses an encryption field that arrives after the file part and disagrees (422), unknown modes (422), keyring without Redis (503), client outside /uploads (422) and caller without its key (423)", async () => {
    const late = await http.upload(SECRET, "late.txt", { fields: { encryption: "tenant" } });
    expect(late.response.statusCode, late.response.body).toBe(422);
    expect(late.response.json().error.message).toContain("before the file part");
    const bogus = await http.upload(SECRET, "b.txt", {
      fields: { encryption: "rot13" },
      fieldsFirst: true,
    });
    expect(bogus.response.statusCode).toBe(422);
    const keyring = await http.upload(SECRET, "k.txt", {
      fields: { encryption: "keyring" },
      fieldsFirst: true,
    });
    // This app has no Redis: the keyring provider does not exist here (test/keyrings.test.ts has it).
    expect(keyring.response.statusCode).toBe(503);
    expect(keyring.response.json().error.code).toBe("encryption_unavailable");
    const client = await http.upload(SECRET, "cl.txt", {
      headers: { "x-vola-encryption": "client" },
    });
    expect(client.response.statusCode).toBe(422);
    expect(client.response.json().error.message).toContain("POST /uploads");
    // The fixture's key lacks `encryption:caller`: forbidden (test/encryption3.test.ts has the mode).
    const caller = await http.upload(SECRET, "c.txt", {
      headers: { "x-vola-encryption": "caller" },
    });
    expect(caller.response.statusCode).toBe(403);
    expect(caller.response.json().error.code).toBe("forbidden");
    // Nothing of the refused ones was left behind in the temporary area.
    expect(await readdir(storage.tmpDir)).toEqual([]);
  });

  it("gives two uploads of the same bytes two different blobs (no deduplication of ciphertext)", async () => {
    const a = await uploadEncrypted(SECRET, "same.txt");
    const b = await uploadEncrypted(SECRET, "same.txt", { instanceId: a.instanceId });
    expect(a.info.hash).not.toBe(b.info.hash);
    expect(await stat(storage.blobPath(a.info.hash))).toBeTruthy();
    expect(await stat(storage.blobPath(b.info.hash))).toBeTruthy();
    // Same name twice in one folder: no "(1)" rename — the real names are sealed, ids tell them apart.
    expect(b.info.filename).toBe("same.txt");
  });

  it("measures the upload limit on the plaintext (413) and encrypts an empty file", async () => {
    const big = await http.upload(Buffer.alloc(MAX_UPLOAD + 1, 7), "big.bin", ENC);
    expect(big.response.statusCode, big.response.body).toBe(413);
    expect(await readdir(storage.tmpDir)).toEqual([]);
    const empty = await uploadEncrypted(Buffer.alloc(0), "empty.txt");
    expect(empty.info.size).toBe(0);
    expect((await blobOf(empty.info.hash)).length).toBe(HEADER_BYTES + TAG_BYTES);
    const get = await http.get(url(empty.instanceId, empty.info.id));
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.length).toBe(0);
    expect(get.headers["content-length"]).toBe("0");
  });

  it("uses the tenant's default_encryption when the upload names none", async () => {
    await setTenantDefaultEncryption(handle.db, fx.tenant.slug, "tenant");
    try {
      const implicit = await http.upload(SECRET, "implicit.txt");
      expect(implicit.response.statusCode, implicit.response.body).toBe(201);
      expect(implicit.response.json()).toMatchObject({
        encryption: "tenant",
        filename: "implicit.txt",
      });
      const explicit = await http.upload(SECRET, "plain.txt", {
        fields: { encryption: "none" },
        fieldsFirst: true,
      });
      expect(explicit.response.json()).toMatchObject({ encryption: "none" });
    } finally {
      await setTenantDefaultEncryption(handle.db, fx.tenant.slug, "none");
    }
    await expect(
      setTenantDefaultEncryption(handle.db, fx.tenant.slug, "client"),
    ).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(setTenantDefaultEncryption(handle.db, "nobody", "tenant")).rejects.toMatchObject({
      code: "tenant_not_found",
    });
  });

  it("upserts an encrypted named file (PUT …/slug/:slug)", async () => {
    const instanceId = randomUUID();
    const put = (data: Buffer) =>
      app.inject({
        method: "PUT",
        url: `/vola/files/${TYPE}/${instanceId}/slug/avatar`,
        headers: multipartHeaders({ ...bearer(fx.full.key), "x-vola-encryption": "tenant" }),
        payload: fileUpload("me.png", data),
      });
    const first = await put(await pngFixture());
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({
      slug: "avatar",
      encryption: "tenant",
      mime_type: "image/png",
    });
    const second = await put(SECRET);
    expect(second.statusCode).toBe(201);
    const bySlug = await http.get(`/vola/files/${TYPE}/${instanceId}/slug/avatar`);
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.rawPayload.equals(SECRET)).toBe(true);
    expect((await row(first.json().id)).deletedAt).not.toBeNull();
  });
});

// --- download ----------------------------------------------------------------------------

describe("encrypted download", () => {
  it("answers the identical bytes with the encrypted-file headers", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "Račun.txt");
    const get = await http.get(url(instanceId, info.id));
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
    expect(get.headers.etag).toBe(`"${info.id}"`);
    expect(get.headers["cache-control"]).toBe("no-store");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.headers["accept-ranges"]).toBe("bytes");
    expect(get.headers["content-type"]).toMatch(/^text\/plain/);
    expect(get.headers["content-length"]).toBe(String(SECRET.length));
    expect(get.headers["content-disposition"]).toBe(
      `attachment; filename="Ra_un.txt"; filename*=UTF-8''Ra%C4%8Dun.txt`,
    );
    const head = await http.head(url(instanceId, info.id));
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    expect(head.headers["content-length"]).toBe(String(SECRET.length));
    expect(head.headers.etag).toBe(`"${info.id}"`);
    const cached = await http.get(url(instanceId, info.id), { "if-none-match": `"${info.id}"` });
    expect(cached.statusCode).toBe(304);
    // The ETag of the plaintext is the id, never the blob hash.
    const byHash = await http.get(url(instanceId, info.id), { "if-none-match": `"${info.hash}"` });
    expect(byHash.statusCode).toBe(200);
    expect((await row(info.id)).lastAccessedAt).not.toBeNull();
  });

  it("renders inline only a raster image the bytes identified", async () => {
    const png = await pngFixture();
    const image = await uploadEncrypted(png, "photo.png");
    const get = await http.get(url(image.instanceId, image.info.id));
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["content-disposition"]).toBe('inline; filename="photo.png"');
    expect(get.rawPayload.equals(png)).toBe(true);
    const forced = await http.get(`${url(image.instanceId, image.info.id)}?download=1`);
    expect(forced.headers["content-disposition"]).toBe('attachment; filename="photo.png"');
    // Claimed by name only: an attachment, whatever the extension says.
    const claimed = await uploadEncrypted(Buffer.from("<svg onload=alert(1)/>"), "x.png", {
      contentType: "image/png",
    });
    const svg = await http.get(url(claimed.instanceId, claimed.info.id));
    expect(svg.headers["content-disposition"]).toBe('attachment; filename="x.png"');
    const pdf = await uploadEncrypted(Buffer.from("%PDF-1.4 fake"), "doc.pdf");
    const doc = await http.get(url(pdf.instanceId, pdf.info.id));
    expect(doc.headers["content-disposition"]).toBe('attachment; filename="doc.pdf"');
  });

  it("serves a Range in plaintext coordinates and reads only the segments it needs", async () => {
    const size = 5 * S + 4321;
    const data = randomBytes(size);
    const { info, instanceId } = await uploadEncrypted(data, "video.bin");
    expect(info.size).toBe(size);
    const open = vi.spyOn(storage, "open");
    try {
      // Inside the third segment.
      const start = 2 * S + 100;
      const end = 2 * S + 100 + 65535;
      const part = await http.get(url(instanceId, info.id), { range: `bytes=${start}-${end}` });
      expect(part.statusCode).toBe(206);
      expect(part.headers["content-range"]).toBe(`bytes ${start}-${end}/${size}`);
      expect(part.headers["content-length"]).toBe(String(end - start + 1));
      expect(part.rawPayload.equals(data.subarray(start, end + 1))).toBe(true);
      const ranges = open.mock.calls.map((call) => call[1]);
      expect(ranges).toEqual([
        { start: 0, end: HEADER_BYTES - 1 },
        { start: HEADER_BYTES + 2 * (S + TAG_BYTES), end: HEADER_BYTES + 3 * (S + TAG_BYTES) - 1 },
      ]);
      open.mockClear();

      // Across a boundary: two segments, nothing else.
      const across = await http.get(url(instanceId, info.id), { range: `bytes=${S - 1}-${S}` });
      expect(across.statusCode).toBe(206);
      expect(across.rawPayload.equals(data.subarray(S - 1, S + 1))).toBe(true);
      expect(open.mock.calls.map((c) => c[1])).toEqual([
        { start: 0, end: HEADER_BYTES - 1 },
        { start: HEADER_BYTES, end: HEADER_BYTES + 2 * (S + TAG_BYTES) - 1 },
      ]);
      open.mockClear();

      // The tail: the last (short) segment, clamped to the blob.
      const suffix = await http.get(url(instanceId, info.id), { range: "bytes=-10" });
      expect(suffix.statusCode).toBe(206);
      expect(suffix.headers["content-range"]).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
      expect(suffix.rawPayload.equals(data.subarray(size - 10))).toBe(true);
      const blobSize = ciphertextLengthFor(size, S);
      expect(open.mock.calls.map((c) => c[1])).toEqual([
        { start: 0, end: HEADER_BYTES - 1 },
        { start: HEADER_BYTES + 5 * (S + TAG_BYTES), end: blobSize - 1 },
      ]);
      open.mockClear();

      const whole = await http.get(url(instanceId, info.id));
      expect(whole.statusCode).toBe(200);
      expect(whole.rawPayload.equals(data)).toBe(true);
      const outside = await http.get(url(instanceId, info.id), { range: `bytes=${size}-` });
      expect(outside.statusCode).toBe(416);
      expect(outside.headers["content-range"]).toBe(`bytes */${size}`);
      const headRange = await http.head(url(instanceId, info.id), { range: "bytes=0-9" });
      expect(headRange.statusCode).toBe(206);
      expect(headRange.headers["content-length"]).toBe("10");
    } finally {
      open.mockRestore();
    }
  });

  it("answers 409 vola_integrity with the fixed sentence for a damaged blob or a damaged wrapped key", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "fragile.txt");
    const path = storage.blobPath(info.hash);
    const blob = await readFile(path);
    const damaged = Buffer.from(blob);
    damaged[HEADER_BYTES + 5] = (damaged[HEADER_BYTES + 5] as number) ^ 0xff;
    await writeFile(path, damaged);
    const get = await http.get(url(instanceId, info.id));
    expect(get.statusCode).toBe(409);
    expect(get.json().error).toEqual({ code: "vola_integrity", message: INTEGRITY_ERROR_MESSAGE });
    // The row still describes the file; only the bytes are refused.
    expect((await http.get(url(instanceId, info.id, "/info"))).statusCode).toBe(200);
    await writeFile(path, blob);
    expect((await http.get(url(instanceId, info.id))).statusCode).toBe(200);

    // A transplanted blob: another encrypted file's bytes under this row.
    const other = await uploadEncrypted(SECRET, "other.txt", { instanceId });
    await handle.db.update(files).set({ hash: other.info.hash }).where(eq(files.id, info.id));
    const transplanted = await http.get(url(instanceId, info.id));
    expect(transplanted.statusCode).toBe(409);
    await handle.db.update(files).set({ hash: info.hash }).where(eq(files.id, info.id));

    const stored = await row(info.id);
    const badKey = Buffer.from(stored.fkCt as Buffer);
    badKey[30] = (badKey[30] as number) ^ 1;
    await handle.db.update(files).set({ fkCt: badKey }).where(eq(files.id, info.id));
    const refused = await http.get(url(instanceId, info.id));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(INTEGRITY_ERROR_MESSAGE);
    const infoRefused = await http.get(url(instanceId, info.id, "/info"));
    expect(infoRefused.statusCode).toBe(409);
    // Lists do not fail because of one file: the row keeps its mask.
    const list = FileListSchema.parse((await http.get(`/vola/files/${TYPE}/${instanceId}`)).json());
    expect(list.files.find((f) => f.id === info.id)?.filename).toBe(`${info.id}.bin`);
    await handle.db.update(files).set({ fkCt: stored.fkCt }).where(eq(files.id, info.id));
  });
});

// --- info, lists, UDC, subscribe -----------------------------------------------------------

describe("encrypted metadata in info, lists and UDC", () => {
  it("info, the list and the versions show the real name, type and metadata", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "Quarterly report.txt", {
      fields: { metadata: JSON.stringify({ q: 4 }) },
    });
    const detail = await http.get(url(instanceId, info.id, "/info"));
    expect(detail.statusCode).toBe(200);
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(detail.json()).toMatchObject({
      filename: "Quarterly report.txt",
      mime_type: "text/plain",
      extension: "txt",
      kind: "text",
      metadata: { q: 4 },
      encryption: "tenant",
      ocr: { status: null },
    });
    expect(JSON.stringify(detail.json())).not.toMatch(/fk_ct|meta_ct|fkCt|metaCt/);

    const version = await http.upload(SECRET, "", {
      ...ENC,
      instanceId,
      fields: { encryption: "tenant", parent_id: info.id },
    });
    expect(version.response.statusCode, version.response.body).toBe(201);
    // A new version of an encrypted file inherits its decrypted name.
    expect(version.response.json()).toMatchObject({
      filename: "Quarterly report.txt",
      parent_id: info.id,
    });
    const versions = FileVersionsSchema.parse(
      (await http.get(url(instanceId, info.id, "/versions"))).json(),
    );
    expect(versions.versions.map((v) => v.filename)).toEqual([
      "Quarterly report.txt",
      "Quarterly report.txt",
    ]);
  });

  it("UDC list and read show the real name; filters and the row's download_url still work; the thumbnail is rendered under the key", async () => {
    const instanceId = randomUUID();
    const { info } = await uploadEncrypted(await pngFixture(), "cover.png", { instanceId });
    await http.upload(Buffer.from("plain"), "plain.txt", { instanceId });
    const list = (await udc("list", {
      collection: "files",
      filter: {
        and: [
          { field: "instance_type", op: "eq", value: TYPE },
          { field: "instance_id", op: "eq", value: instanceId },
          { field: "encryption", op: "eq", value: "tenant" },
        ],
      },
    })) as { rows: Row[]; total: number };
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({
      id: info.id,
      filename: "cover.png",
      mime_type: "image/png",
      extension: "png",
      kind: "image",
      encryption: "tenant",
      thumb_url: null,
      download_url: url(instanceId, info.id),
    });
    const read = (await udc("read", { collection: "files", id: info.id })) as { row: Row };
    expect(read.row).toMatchObject({ filename: "cover.png", kind: "image" });
    // The name is decrypted per row, never searched: a filter on it sees the mask.
    const byName = (await udc("list", {
      collection: "files",
      filter: {
        and: [
          { field: "instance_type", op: "eq", value: TYPE },
          { field: "instance_id", op: "eq", value: instanceId },
          { field: "filename", op: "eq", value: ENCRYPTED_FILENAME },
        ],
      },
    })) as { rows: Row[] };
    expect(byName.rows.map((r) => r.id)).toEqual([info.id]);
    // 6.3: the server holds the key, so the thumbnail exists — sealed on disk, decrypted here, never cached.
    const thumb = await http.get(url(instanceId, info.id, "/thumb/256"));
    expect(thumb.statusCode, thumb.body).toBe(200);
    expect(thumb.headers["cache-control"]).toBe("no-store");
    expect(thumb.headers["x-thumbnail-status"]).toBe("ready");
    expect(
      (
        await keyless.inject({
          method: "GET",
          url: url(instanceId, info.id, "/thumb/256"),
          headers: bearer(fx.full.key),
        })
      ).statusCode,
    ).toBe(503);
  });

  it("a subscription gets the decrypted row of an encrypted upload", async () => {
    const instanceId = randomUUID();
    const source = new FilesCollectionSource({
      db: handle.db,
      prefix: "/vola",
      events,
      crypto: (await import("../src/services/encryption.js")).createEncryptionService({
        db: handle.db,
        keyFile,
      }),
    });
    const upserts: Row[] = [];
    const tenant = {
      tenantId: fx.tenant.id,
      tenantSlug: fx.tenant.slug,
      apiKeyId: fx.full.apiKey.id,
      apiKeyLabel: "vola_live…test",
      scopes: ["files:read"] as const,
      isAdmin: false,
      userId: null,
      unlockToken: null,
      contentKey: null,
      browserOrigin: null,
    };
    const subscription = await runWithTenant(tenant, () =>
      source.subscribe(
        {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "instance_id", op: "eq", value: instanceId },
          ],
        },
        { upsert: (row) => upserts.push(row), remove: () => undefined },
      ),
    );
    try {
      const { info } = await uploadEncrypted(SECRET, "live.txt", { instanceId });
      await source.idle();
      expect(upserts.map((r) => [r.id, r.filename, r.mime_type])).toEqual([
        [info.id, "live.txt", "text/plain"],
      ]);
    } finally {
      await subscription.close();
    }
  });

  it("keeps the real name out of logs' reach: audit payloads and the database row", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "payroll.xlsx");
    const del = await http.del(url(instanceId, info.id));
    expect(del.statusCode).toBe(200);
    const event = audited.find((e) => e.event_type === "VOLA_FILE_DELETED");
    expect(event?.payload).toMatchObject({
      file_id: info.id,
      encryption: "tenant",
      mime_type: "application/octet-stream",
    });
    expect(event?.payload).not.toHaveProperty("filename");
    expect(JSON.stringify(audited)).not.toContain("payroll");
  });

  it("renames an encrypted file by re-sealing its metadata; the row still says <id>.bin", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "draft.txt");
    const renamed = await http.patch(url(instanceId, info.id), { filename: "final.txt" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ filename: "final.txt", extension: "txt" });
    expect((await row(info.id)).filename).toBe(`${info.id}.bin`);
    const get = await http.get(url(instanceId, info.id));
    expect(get.headers["content-disposition"]).toBe('attachment; filename="final.txt"');
    expect(get.rawPayload.equals(SECRET)).toBe(true);
  });
});

// --- visibility, shares ----------------------------------------------------------------

describe("what an encrypted file can never be", () => {
  it("globally public (409 encrypted_not_public; /public answers 404); a share is a grant with #secret (6.3), 503 without the key file", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "nope.txt");
    const patched = await http.patch(url(instanceId, info.id), { is_global_public: true });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().error.code).toBe("encrypted_not_public");
    await handle.db.update(files).set({ isGlobalPublic: true }).where(eq(files.id, info.id));
    const anonymous = await app.inject({ method: "GET", url: `/vola/public/${info.id}` });
    expect(anonymous.statusCode).toBe(404);
    const share = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { file_id: info.id },
    });
    expect(share.statusCode, share.body).toBe(201);
    expect(share.json().url).toMatch(/#[A-Za-z0-9_-]{43}$/);
    expect(share.json().encrypted).toBe(true);
    const withoutKey = await keyless.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { file_id: info.id },
    });
    expect(withoutKey.statusCode).toBe(503);
  });
});

// --- resumable ---------------------------------------------------------------------------

describe("resumable upload with encryption=tenant", () => {
  const auth = (key = fx.full.key) => ({ ...bearer(key), ...TUS });

  it("records the mode at creation, encrypts at finalize and removes the plaintext part file", async () => {
    const instanceId = randomUUID();
    const data = randomBytes(S + 777);
    const created = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: {
        ...auth(),
        "upload-length": String(data.length),
        "upload-metadata": encodeTusMetadata({
          instance_type: TYPE,
          instance_id: instanceId,
          filename: "resumed.bin",
          encryption: "tenant",
        }),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.headers.location as string).split("/").pop() as string;
    const probe = await app.inject({ method: "HEAD", url: `/vola/uploads/${id}`, headers: auth() });
    expect(probe.headers["upload-metadata"]).toContain(
      `encryption ${Buffer.from("tenant").toString("base64")}`,
    );

    const half = Math.floor(data.length / 2);
    for (const [offset, body] of [
      [0, data.subarray(0, half)],
      [half, data.subarray(half)],
    ] as const) {
      const patch = await app.inject({
        method: "PATCH",
        url: `/vola/uploads/${id}`,
        headers: { ...auth(), "content-type": PATCH_TYPE, "upload-offset": String(offset) },
        payload: body,
      });
      expect(patch.statusCode, patch.body).toBe(204);
    }
    const done = await app.inject({ method: "HEAD", url: `/vola/uploads/${id}`, headers: auth() });
    const fileId = done.headers["vola-file-id"] as string;
    expect(fileId).toBeTruthy();
    const stored = await row(fileId);
    expect(stored.encryption).toBe("tenant");
    expect(stored.filename).toBe(`${fileId}.bin`);
    expect(Number(stored.size)).toBe(data.length);
    const blob = await blobOf(stored.hash);
    // The length was known: it is in the header, and the blob is the ciphertext.
    expect(Number(blob.readBigUInt64BE(16))).toBe(data.length);
    expect(blob.length).toBe(ciphertextLengthFor(data.length, S));
    expect(
      (await readdir(join(root, "storage", "uploads"))).filter((f) => f.endsWith(".part")),
    ).toEqual([]);
    const get = await http.get(url(instanceId, fileId));
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(data)).toBe(true);
    expect(get.headers["content-disposition"]).toBe('attachment; filename="resumed.bin"');
    const info = FileInfoSchema.parse((await http.get(url(instanceId, fileId, "/info"))).json());
    expect(info).toMatchObject({ filename: "resumed.bin", encryption: "tenant", enc_format: 1 });
  });

  it("takes X-Vola-Encryption at creation and refuses what it cannot serve before a byte is sent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: {
        ...auth(),
        "x-vola-encryption": "tenant",
        "upload-length": "0",
        "upload-metadata": encodeTusMetadata({
          instance_type: TYPE,
          instance_id: randomUUID(),
          filename: "empty.bin",
        }),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ encryption: "tenant", size: 0, filename: "empty.bin" });
    const later = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: {
        ...auth(),
        "upload-length": "10",
        "upload-metadata": encodeTusMetadata({
          instance_type: TYPE,
          instance_id: randomUUID(),
          filename: "x.bin",
          encryption: "client",
        }),
      },
    });
    // `client` without its `fk_ct` pair: nothing to store the key as.
    expect(later.statusCode).toBe(422);
    expect(later.json().error.message).toContain("fk_ct");
    const keylessCreate = await keyless.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: {
        ...auth(),
        "upload-length": "10",
        "upload-metadata": encodeTusMetadata({
          instance_type: TYPE,
          instance_id: randomUUID(),
          filename: "x.bin",
          encryption: "tenant",
        }),
      },
    });
    expect(keylessCreate.statusCode).toBe(503);
    expect(keylessCreate.json().error.code).toBe("encryption_unavailable");
  });
});

// --- transfer ----------------------------------------------------------------------------

describe("transfer of tenant-encrypted files", () => {
  const transfer = (body: Record<string, unknown>, instance: FastifyInstance = app) =>
    instance.inject({
      method: "POST",
      url: "/vola/admin/transfer",
      headers: bearer(fx.admin.key),
      payload: body,
    });

  it("re-wraps the file key for the destination tenant inside the transaction", async () => {
    const instanceId = randomUUID();
    const { info } = await uploadEncrypted(SECRET, "moving.txt", { instanceId });
    const before = (await row(info.id)).fkCt as Buffer;
    const request = {
      from_tenant: fx.tenant.slug,
      to_tenant: beta.slug,
      instances: [{ instance_type: TYPE, instance_id: instanceId }],
    };
    const dry = await transfer({ ...request, dry_run: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(TransferResultSchema.parse(dry.json())).toMatchObject({ files: 1, dry_run: true });
    expect((await row(info.id)).fkCt).toEqual(before);

    const moved = await transfer(request);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(TransferResultSchema.parse(moved.json())).toMatchObject({ files: 1, dry_run: false });
    const after = await row(info.id);
    expect(after.tenantId).toBe(beta.id);
    expect(after.fkCt).not.toEqual(before);
    expect(after.fkCt?.length).toBe(TENANT_FK_CT_BYTES);
    // The destination reads it, the source does not have it any more.
    const get = await http.get(url(instanceId, info.id), {}, beta.key);
    expect(get.statusCode, get.body).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
    expect(get.headers["content-disposition"]).toBe('attachment; filename="moving.txt"');
    expect((await http.get(url(instanceId, info.id))).statusCode).toBe(404);
    expect(audited.find((e) => e.event_type === "VOLA_INSTANCES_TRANSFERRED")).toBeTruthy();
  });

  it("refuses the whole transfer without the key file (503) and with a key that does not open (409)", async () => {
    const instanceId = randomUUID();
    const { info } = await uploadEncrypted(SECRET, "stuck.txt", { instanceId });
    await http.upload(Buffer.from("p"), "p.txt", { instanceId });
    const request = {
      from_tenant: fx.tenant.slug,
      to_tenant: beta.slug,
      instances: [{ instance_type: TYPE, instance_id: instanceId }],
    };
    const unavailable = await transfer(request, keyless);
    expect(unavailable.statusCode, unavailable.body).toBe(503);
    expect(unavailable.json().error.code).toBe("encryption_unavailable");
    const stored = await row(info.id);
    const broken = Buffer.from(stored.fkCt as Buffer);
    broken[40] = (broken[40] as number) ^ 1;
    await handle.db.update(files).set({ fkCt: broken }).where(eq(files.id, info.id));
    const refused = await transfer(request);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toEqual({
      code: "vola_integrity",
      message: INTEGRITY_ERROR_MESSAGE,
    });
    // Nothing moved: the plain file is still the source tenant's.
    const list = FileListSchema.parse((await http.get(`/vola/files/${TYPE}/${instanceId}`)).json());
    expect(list.files).toHaveLength(2);
    await handle.db.update(files).set({ fkCt: stored.fkCt }).where(eq(files.id, info.id));
  });
});

// --- key file ----------------------------------------------------------------------------

describe("key file", () => {
  it("without it: 503 encryption_unavailable on an encrypted upload, download and info; lists stay masked; plain files work", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "locked.txt");
    const keylessHttp = httpClient(keyless, fx.full.key, TYPE);
    const upload = await keylessHttp.upload(SECRET, "x.txt", ENC);
    expect(upload.response.statusCode, upload.response.body).toBe(503);
    expect(upload.response.json().error.code).toBe("encryption_unavailable");
    expect(await readdir(storage.tmpDir)).toEqual([]);
    const get = await keylessHttp.get(url(instanceId, info.id));
    expect(get.statusCode).toBe(503);
    expect(get.json().error.code).toBe("encryption_unavailable");
    expect((await keylessHttp.head(url(instanceId, info.id))).statusCode).toBe(503);
    const detail = await keylessHttp.get(url(instanceId, info.id, "/info"));
    expect(detail.statusCode).toBe(503);
    const list = FileListSchema.parse(
      (await keylessHttp.get(`/vola/files/${TYPE}/${instanceId}`)).json(),
    );
    expect(list.files[0]).toMatchObject({
      id: info.id,
      filename: `${info.id}.bin`,
      mime_type: "application/octet-stream",
    });
    const rows = (await udc(
      "list",
      {
        collection: "files",
        filter: {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "instance_id", op: "eq", value: instanceId },
          ],
        },
      },
      keyless,
    )) as { rows: Row[] };
    expect(rows.rows[0]).toMatchObject({ filename: ENCRYPTED_FILENAME, mime_type: null });
    const plain = await keylessHttp.upload(Buffer.from("fine"), "fine.txt");
    expect(plain.response.statusCode).toBe(201);
    expect((await keylessHttp.get(`/vola/health/live`)).statusCode).toBe(200);
  });

  it("rotates lazily: a new first line, the old one still opens, and the next read re-wraps", async () => {
    const { info, instanceId } = await uploadEncrypted(SECRET, "rotate.txt");
    const line1 = generateKeyLine();
    await writeFile(keyFile, `${line1}\n${line0}\n`, { mode: 0o600 });
    await utimes(keyFile, new Date(), new Date(Date.now() + 5000));
    try {
      const get = await http.get(url(instanceId, info.id));
      expect(get.statusCode, get.body).toBe(200);
      expect(get.rawPayload.equals(SECRET)).toBe(true);
      const rewrapped = (await row(info.id)).fkCt as Buffer;
      expect(rewrapped.subarray(0, 4)).toEqual(keyId(Buffer.from(line1, "base64")));
      // New uploads use the new line; the file re-wrapped above no longer needs the old one.
      const fresh = await uploadEncrypted(SECRET, "fresh.txt", { instanceId });
      expect((await row(fresh.info.id)).fkCt?.subarray(0, 4)).toEqual(
        keyId(Buffer.from(line1, "base64")),
      );
      await writeFile(keyFile, `${line1}\n`, { mode: 0o600 });
      await utimes(keyFile, new Date(), new Date(Date.now() + 10_000));
      expect((await http.get(url(instanceId, info.id))).statusCode).toBe(200);
      expect((await http.get(url(instanceId, fresh.info.id))).statusCode).toBe(200);
      // A file still wrapped under the removed line is lost: the thing keys-status warns about.
      const orphan = await uploadEncrypted(SECRET, "orphan.txt", { instanceId });
      await writeFile(keyFile, `${generateKeyLine()}\n`, { mode: 0o600 });
      await utimes(keyFile, new Date(), new Date(Date.now() + 15_000));
      const lost = await http.get(url(instanceId, orphan.info.id));
      expect(lost.statusCode).toBe(409);
      expect(lost.json().error.message).toBe(INTEGRITY_ERROR_MESSAGE);
    } finally {
      await writeFile(keyFile, `${line0}\n`, { mode: 0o600 });
      await utimes(keyFile, new Date(), new Date(Date.now() + 20_000));
    }
  });
});
