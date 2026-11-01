import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeTusMetadata,
  FileInfoSchema,
  INTEGRITY_ERROR_MESSAGE,
  ShareCreatedSchema,
  THUMBNAIL_SIZES,
} from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  aeadSeal,
  ciphertextLengthFor,
  decryptBuffer,
  encryptBuffer,
  encryptedThumbnailName,
  generateKeyLine,
  HEADER_BYTES,
  KeyFile,
  MIN_SEGMENT_BYTES,
  newFileKey,
  openThumbnail,
} from "../src/crypto/index.js";
import { fileMetadata, files, shareLinks, uploads } from "../src/db/schema.js";
import { LocalFileEventBus } from "../src/events/bus.js";
import { ProcessingQueue } from "../src/jobs/queue.js";
import { ProcessingWorker } from "../src/jobs/worker.js";
import { createEncryptionService } from "../src/services/encryption.js";
import { probeTesseract } from "../src/services/ocr.js";
import { listProcessingJobs } from "../src/services/processing.js";
import { UnlockStore } from "../src/services/unlock.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { decode, isBlue, isRed, pdfFixture, pngFixture, waitFor } from "./fixtures.js";
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

/**
 * Phase 6.3 end to end (`docs/CRYPTO.md` § 9–13): the `caller` provider, the resumable
 * upload sealed segment by segment under every mode, `client` blobs, encrypted derivatives
 * (inline under the key, and through a real worker for `tenant` files) and the share grant.
 * Needs the test Redis (the keyring provider) — like `keyrings.test.ts`.
 */
const handle = testDatabase(8);
let fx: Fixture;
let app: FastifyInstance;
/** The same database and storage, `async` mode: a private queue and a real worker (tenant derivatives). */
let asyncApp: FastifyInstance;
/** The same again, with every log line captured: what the key must never reach. */
let logged: FastifyInstance;
let logLines: string[];
let redis: Redis;
let queue: ProcessingQueue;
let worker: ProcessingWorker;
let root: string;
let keyFile: string;
let storage: FilesystemBackend;
let events: LocalFileEventBus;
let http: ReturnType<typeof httpClient>;
let port: number;
/** A key with `encryption:caller` (and files + shares). */
let callerKey: string;
/** A key with files scopes only: no `encryption:caller`. */
let plainKey: string;

const TYPE = "tickets";
const S = MIN_SEGMENT_BYTES; // 64 KiB segments keep the suite fast; the arithmetic is the same at 1 MiB
const TTL_S = 20;
const FAST = { m: 1024, t: 1, p: 1 };
const PIN = "135790";
const TUS = { "tus-resumable": "1.0.0" };
const PATCH_TYPE = "application/offset+octet-stream";
const MARKER = randomBytes(48);
const SECRET = Buffer.concat([Buffer.from("caller secret: "), MARKER, Buffer.from("\nend\n")]);
const line0 = generateKeyLine();
const pepper0 = generateKeyLine();
const tesseract = await probeTesseract().catch(() => null);

/** A plaintext of `n` bytes with the marker planted every 10 000 bytes (so any segment leaks it). */
function planted(n: number): Buffer {
  const out = randomBytes(n);
  for (let at = 0; at + MARKER.length <= n; at += 10_000) MARKER.copy(out, at);
  return out;
}

beforeAll(async () => {
  expect(config.redisUrl, "VOLA_REDIS_URL is needed for this suite").toBeTruthy();
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-enc3-"));
  keyFile = join(root, "vola.key");
  const pepperFile = join(root, "vola.pepper");
  await writeFile(keyFile, `${line0}\n`, { mode: 0o600 });
  await writeFile(pepperFile, `${pepper0}\n`, { mode: 0o600 });
  storage = new FilesystemBackend(join(root, "storage"));
  events = new LocalFileEventBus();
  redis = new Redis(config.redisUrl as string, { maxRetriesPerRequest: 1 });
  const cfg = {
    ...config,
    keyFile,
    pepperFile,
    unlockTtlS: TTL_S,
    storagePath: join(root, "storage"),
    maxUploadBytes: 8 * 1024 * 1024,
  };
  const unlocks = new UnlockStore({ redis, keys: new KeyFile(keyFile), ttlS: TTL_S });
  const encryption = () =>
    createEncryptionService({
      db: handle.db,
      keyFile,
      keys: new KeyFile(keyFile),
      unlocks,
      segmentSize: S,
    });
  fx = await setupFixture(handle, {
    storage,
    events,
    redis,
    unlocks,
    keyrings: { kdfCost: FAST },
    encryption: encryption(),
    config: cfg,
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as { port: number }).port;
  http = httpClient(app, fx.full.key, TYPE);
  callerKey = (
    await mintKey(handle, fx.tenant.id, "caller", "live", [
      "files:read",
      "files:write",
      "shares:write",
      "encryption:caller",
    ])
  ).key;
  plainKey = (await mintKey(handle, fx.tenant.id, "plain", "live", ["files:read", "files:write"]))
    .key;

  logLines = [];
  logged = await buildApp({
    config: cfg,
    db: handle.db,
    logger: {
      level: "trace",
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
    storage,
    events: false,
    redis,
    unlocks,
    encryption: encryption(),
    uploadSweepIntervalMs: 0,
  });
  await logged.ready();

  const prefix = `vola-enc3-${randomUUID().slice(0, 8)}`;
  queue = new ProcessingQueue({ redisUrl: config.redisUrl as string, prefix, backoffMs: 20 });
  asyncApp = await buildApp({
    config: cfg,
    db: handle.db,
    logger: false,
    storage,
    events,
    redis,
    unlocks,
    encryption: encryption(),
    jobs: queue,
    uploadSweepIntervalMs: 0,
    statsRefreshIntervalMs: 0,
  });
  await asyncApp.ready();
  worker = new ProcessingWorker({
    redisUrl: config.redisUrl as string,
    prefix,
    concurrency: 2,
    db: handle.db,
    storage,
    events,
    jobTimeoutMs: 20_000,
    crypto: createEncryptionService({ db: handle.db, keyFile, keys: new KeyFile(keyFile) }),
    encDeriveMaxBytes: cfg.encDeriveMaxBytes,
    ocr: tesseract
      ? { enabled: "auto", langs: ["eng"], maxPages: 2, timeoutS: 60 }
      : { enabled: false, langs: ["eng"], maxPages: 2, timeoutS: 60 },
  });
  await worker.ready();
});
afterAll(async () => {
  await worker.close();
  await asyncApp.close();
  await logged.close();
  await app.close();
  await queue.queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await redis.quit();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------------------

type Headers = Record<string, string>;
const url = (instanceId: string, fileId: string, suffix = "") =>
  `/vola/files/${TYPE}/${instanceId}/${fileId}${suffix}`;
const contentKey = (key: Buffer): Headers => ({ "x-vola-content-key": key.toString("base64") });
const user = (id: string, extra: Headers = {}) => ({ "x-user-id": id, ...extra });
const unlockHeader = (token: string) => ({ "x-vola-unlock": token });

async function row(id: string) {
  const [found] = await handle.db.select().from(files).where(eq(files.id, id));
  return found as typeof files.$inferSelect;
}
const blobOf = async (hash: string) => readFile(storage.blobPath(hash));
const partPath = (id: string) => join(root, "storage", "uploads", `${id}.part`);
const partialPath = (id: string) => join(root, "storage", "uploads", `${id}.partial`);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The uploads directory holds the marker nowhere — in no `.part`, no `.partial`, no tmp. */
async function nothingPlainOnDisk(): Promise<void> {
  const dir = join(root, "storage", "uploads");
  for (const name of await readdir(dir)) {
    const bytes = await readFile(join(dir, name));
    expect(bytes.includes(MARKER), `${name} holds plaintext`).toBe(false);
  }
  for (const name of await readdir(storage.tmpDir)) {
    const bytes = await readFile(join(storage.tmpDir, name));
    expect(bytes.includes(MARKER), `tmp/${name} holds plaintext`).toBe(false);
  }
}

/** A keyring owner with a live token. */
async function owner(prefix = "u") {
  const principal = `${prefix}-${randomUUID().slice(0, 8)}`;
  const created = await app.inject({
    method: "POST",
    url: "/vola/keyrings/me",
    headers: { ...bearer(fx.full.key), ...user(principal) },
    payload: { pin: PIN },
  });
  expect(created.statusCode, created.body).toBe(201);
  const unlocked = await app.inject({
    method: "POST",
    url: "/vola/keyrings/me/unlock",
    headers: { ...bearer(fx.full.key), ...user(principal) },
    payload: { pin: PIN },
  });
  expect(unlocked.statusCode, unlocked.body).toBe(200);
  return { principal, token: unlocked.json().token as string };
}

// tus helpers (every call on `app` unless `instance` says otherwise)
async function createUpload(
  length: number,
  meta: Record<string, string | undefined>,
  headers: Headers,
  instance: FastifyInstance = app,
) {
  const instanceId = meta.instance_id ?? randomUUID();
  const response = await instance.inject({
    method: "POST",
    url: "/vola/uploads",
    headers: {
      ...TUS,
      ...headers,
      "upload-length": String(length),
      "upload-metadata": encodeTusMetadata({
        instance_type: TYPE,
        instance_id: instanceId,
        ...meta,
      }),
    },
  });
  const location = response.headers.location as string | undefined;
  return { response, instanceId, id: location?.split("/").pop() ?? "" };
}
const patch = (id: string, offset: number, body: Buffer, headers: Headers, instance = app) =>
  instance.inject({
    method: "PATCH",
    url: `/vola/uploads/${id}`,
    headers: { ...TUS, ...headers, "content-type": PATCH_TYPE, "upload-offset": String(offset) },
    payload: body,
  });
const head = (id: string, headers: Headers) =>
  app.inject({ method: "HEAD", url: `/vola/uploads/${id}`, headers: { ...TUS, ...headers } });

// --- 1. the caller provider --------------------------------------------------------------

describe("caller provider (X-Vola-Content-Key)", () => {
  const key = randomBytes(32);

  it("uploads and downloads under the caller's key; without the key 423, a wrong one 409, from a browser 400, without the scope 403", async () => {
    const { response, instanceId } = await http.upload(SECRET, "Plan.txt", {
      key: callerKey,
      headers: { "x-vola-encryption": "caller", ...contentKey(key) },
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info).toMatchObject({ encryption: "caller", filename: "Plan.txt", size: SECRET.length });
    const stored = await row(info.id);
    expect(stored.fkCt?.length).toBe(60);
    expect(stored.keyringId).toBeNull();
    expect(stored.filename).toBe(`${info.id}.bin`);
    expect((await blobOf(stored.hash)).includes(MARKER)).toBe(false);

    const get = await http.get(url(instanceId, info.id), contentKey(key), callerKey);
    expect(get.statusCode, get.body).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
    expect(get.headers["x-vola-encryption"]).toBe("caller");
    expect(get.headers["cache-control"]).toBe("no-store");
    const range = await http.get(
      url(instanceId, info.id),
      { ...contentKey(key), range: "bytes=15-62" },
      callerKey,
    );
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(MARKER)).toBe(true);

    // No key: locked, like a keyring file without its token.
    const locked = await http.get(url(instanceId, info.id), {}, callerKey);
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe("vola_locked");
    const infoLocked = await http.get(url(instanceId, info.id, "/info"), {}, callerKey);
    expect(infoLocked.statusCode).toBe(423);
    // The wrong key: the one fixed sentence.
    const wrong = await http.get(url(instanceId, info.id), contentKey(randomBytes(32)), callerKey);
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toEqual({
      code: "vola_integrity",
      message: INTEGRITY_ERROR_MESSAGE,
    });
    // A browser (Origin): refused before anything, even with the right key.
    const browser = await http.get(
      url(instanceId, info.id),
      { ...contentKey(key), origin: "https://app.example.com" },
      callerKey,
    );
    expect(browser.statusCode).toBe(400);
    expect(browser.json().error.code).toBe("caller_key_from_browser");
    // A key without the scope.
    const noScope = await http.get(url(instanceId, info.id), contentKey(key), plainKey);
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.required).toEqual(["encryption:caller"]);
    const noScopeUpload = await http.upload(SECRET, "x.txt", {
      key: plainKey,
      headers: { "x-vola-encryption": "caller", ...contentKey(key) },
    });
    expect(noScopeUpload.response.statusCode).toBe(403);
    // A malformed header is a 400, whatever the route.
    const bad = await http.get(
      url(instanceId, info.id),
      { "x-vola-content-key": "nope" },
      callerKey,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("X-Vola-Content-Key");
  });

  it("the key is nowhere: not in the row, not in the blob, not in a log line — and the metadata is masked without it", async () => {
    const key = randomBytes(32);
    const { response, instanceId } = await logged
      .inject({
        method: "POST",
        url: `/vola/files/${TYPE}/${randomUUID()}`,
        headers: {
          ...bearer(callerKey),
          "x-vola-encryption": "caller",
          ...contentKey(key),
          "content-type": "multipart/form-data; boundary=----b",
        },
        payload: Buffer.from(
          `------b\r\nContent-Disposition: form-data; name="file"; filename="Memo.txt"\r\nContent-Type: text/plain\r\n\r\n${SECRET.toString("latin1")}\r\n------b--\r\n`,
          "latin1",
        ),
      })
      .then((r) => ({
        response: r,
        instanceId: (r.json() as { instance_id: string }).instance_id,
      }));
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    // Reads with the right key, the wrong key and no key, all through the logged app.
    for (const headers of [contentKey(key), contentKey(randomBytes(32)), {}]) {
      await logged.inject({
        method: "GET",
        url: url(instanceId, info.id),
        headers: { ...bearer(callerKey), ...headers },
      });
      await logged.inject({
        method: "GET",
        url: url(instanceId, info.id, "/info"),
        headers: { ...bearer(callerKey), ...headers },
      });
    }
    const forms = [key.toString("base64"), key.toString("base64url"), key.toString("hex")];
    expect(logLines.length).toBeGreaterThan(5);
    for (const line of logLines) {
      for (const form of forms) expect(line.includes(form), line).toBe(false);
    }
    const stored = await row(info.id);
    for (const [column, value] of Object.entries(stored)) {
      const text = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
      expect(text.includes(key), column).toBe(false);
      for (const form of forms) expect(text.includes(Buffer.from(form)), column).toBe(false);
    }
    expect((await blobOf(stored.hash)).includes(key)).toBe(false);
    // Masked without the key (info is 423; a list shows the mask), real with it.
    const list = await http.get(`/vola/files/${TYPE}/${instanceId}`, {}, callerKey);
    expect(list.json().files[0]).toMatchObject({
      filename: `${info.id}.bin`,
      mime_type: "application/octet-stream",
    });
    const listWithKey = await http.get(
      `/vola/files/${TYPE}/${instanceId}`,
      contentKey(key),
      callerKey,
    );
    expect(listWithKey.json().files[0]).toMatchObject({
      filename: "Memo.txt",
      mime_type: "text/plain",
    });
  });

  it("a share of a caller file is 409 — unless the caller sends its own fk_share_ct, which the public link then opens with the secret", async () => {
    const key = randomBytes(32);
    const { response } = await http.upload(SECRET, "shared.txt", {
      key: callerKey,
      headers: { "x-vola-encryption": "caller", ...contentKey(key) },
    });
    expect(response.statusCode).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    const refused = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: { ...bearer(callerKey), ...contentKey(key) },
      payload: { file_id: info.id },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("encrypted_share_requires_grant");
    // The caller holds FK: it unwraps it itself and wraps it under a secret of its own.
    const stored = await row(info.id);
    const { aeadOpen } = await import("../src/crypto/index.js");
    const fk = aeadOpen(
      key,
      stored.fkCt as Buffer,
      Buffer.from(`${info.id}:key:caller:${fx.tenant.id}`),
    );
    const secret = randomBytes(32);
    const fkShareCt = aeadSeal(secret, fk, Buffer.from(`${info.id}:key:share:caller`));
    const granted = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(callerKey),
      payload: { file_id: info.id, fk_share_ct: fkShareCt.toString("base64") },
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const share = ShareCreatedSchema.parse(granted.json());
    expect(share.url.includes("#")).toBe(false); // the caller appends its own secret
    expect(share.encrypted).toBe(true);
    const pub = await app.inject({
      method: "GET",
      url: `/vola/s/${share.token}`,
      headers: { "x-share-secret": secret.toString("base64url") },
    });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.rawPayload.equals(SECRET)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/vola/s/${share.token}` })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/vola/s/${share.token}`,
          headers: { "x-share-secret": randomBytes(32).toString("base64url") },
        })
      ).statusCode,
    ).toBe(409);
    // fk_share_ct on a plain or tenant file is a mistake worth naming.
    const plain = await http.upload(Buffer.from("plain"), "p.txt");
    const misuse = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { file_id: plain.response.json().id, fk_share_ct: fkShareCt.toString("base64") },
    });
    expect(misuse.statusCode).toBe(422);
  });

  it("a transfer of an instance with a caller file is refused (409)", async () => {
    const key = randomBytes(32);
    const { response, instanceId } = await http.upload(SECRET, "t.txt", {
      key: callerKey,
      headers: { "x-vola-encryption": "caller", ...contentKey(key) },
    });
    expect(response.statusCode).toBe(201);
    const { createTenant } = await import("../src/services/tenants.js");
    const dest = await createTenant(handle.db, { slug: `dest-${randomUUID().slice(0, 6)}` });
    const transfer = await app.inject({
      method: "POST",
      url: "/vola/admin/transfer",
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": fx.tenant.slug },
      payload: {
        from_tenant: fx.tenant.slug,
        to_tenant: dest.slug,
        instances: [{ instance_type: TYPE, instance_id: instanceId }],
      },
    });
    expect(transfer.statusCode, transfer.body).toBe(409);
    expect(transfer.json().error.code).toBe("encrypted_transfer_unsupported");
  });
});

// --- 2. the encrypted resumable upload --------------------------------------------------

describe("encrypted resumable upload (segment by segment)", () => {
  const SIZE = 3 * S + 12_345; // three full segments and a short last one

  async function checkUpload(
    data: Buffer,
    meta: Record<string, string | undefined>,
    headers: Headers,
    expected: { encryption: string; mimeType?: string },
  ) {
    const cuts = [S - 1, S + 7, 2 * S + 100, 3 * S];
    const created = await createUpload(data.length, meta, headers);
    expect(created.response.statusCode, created.response.body).toBe(201);
    const futureId = created.response.headers["vola-file-id"] as string;
    expect(futureId).toMatch(/^[0-9a-f-]{36}$/);
    // The part file is the blob header from byte 0: `JSV`, version 1, our segment size, the length.
    const header = await readFile(partPath(created.id));
    expect(header.length).toBe(HEADER_BYTES);
    expect(header.subarray(0, 3).toString()).toBe("JSV");
    expect(header.readUInt32BE(4)).toBe(S);
    expect(Number(header.readBigUInt64BE(16))).toBe(data.length);
    let offset = 0;
    let fileId = "";
    for (const cut of [...cuts, data.length]) {
      const response = await patch(created.id, offset, data.subarray(offset, cut), headers);
      expect(response.statusCode, response.body).toBe(204);
      expect(Number(response.headers["upload-offset"])).toBe(cut);
      offset = cut;
      // HEAD: the PLAINTEXT offset; the part holds whole sealed segments only, the tail is sealed apart.
      const probe = await head(created.id, headers);
      expect(Number(probe.headers["upload-offset"])).toBe(cut);
      expect(probe.headers["vola-file-id"]).toBe(futureId);
      if (cut < data.length) {
        const wholeSegments = Math.floor(cut / S);
        expect((await stat(partPath(created.id))).size).toBe(
          HEADER_BYTES + wholeSegments * (S + 16),
        );
        expect(await exists(partialPath(created.id))).toBe(cut % S !== 0);
        const [u] = await handle.db.select().from(uploads).where(eq(uploads.id, created.id));
        expect(u?.encState).toMatchObject({
          next_index: wholeSegments,
          partial_bytes: cut % S,
          file_id: futureId,
        });
        expect((u?.encState as { fk_ct: string } | undefined)?.fk_ct.length ?? 0).toBeGreaterThan(
          40,
        );
      }
      await nothingPlainOnDisk();
      if (response.headers["vola-file-id"] && cut === data.length) {
        fileId = response.headers["vola-file-id"] as string;
      }
    }
    expect(fileId).toBe(futureId);
    expect(await exists(partPath(created.id))).toBe(false);
    expect(await exists(partialPath(created.id))).toBe(false);
    const stored = await row(fileId);
    expect(stored.encryption).toBe(expected.encryption);
    expect(Number(stored.size)).toBe(data.length);
    const blob = await blobOf(stored.hash);
    expect(blob.length).toBe(ciphertextLengthFor(data.length, S));
    expect(blob.includes(MARKER)).toBe(false);
    const get = await http.get(
      url(created.instanceId, fileId),
      headers,
      (headers as { key?: string }).key,
    );
    return { fileId, instanceId: created.instanceId, stored, blob, get };
  }

  it("tenant: byte-identical result, Range in plaintext coordinates, the hash is the blob's", async () => {
    const data = planted(SIZE);
    const { fileId, instanceId, stored, get } = await checkUpload(
      data,
      { filename: "big.bin", encryption: "tenant" },
      bearer(fx.full.key),
      { encryption: "tenant" },
    );
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(data)).toBe(true);
    expect(get.headers["x-vola-encryption"]).toBe("tenant");
    const { createHash } = await import("node:crypto");
    expect(stored.hash).toBe(
      createHash("sha256")
        .update(await blobOf(stored.hash))
        .digest("hex"),
    );
    // Ranges across segment boundaries, in plaintext coordinates.
    for (const [from, to] of [
      [0, 10],
      [S - 5, S + 5],
      [2 * S, 3 * S + 100],
      [data.length - 20, data.length - 1],
    ] as const) {
      const range = await http.get(url(instanceId, fileId), { range: `bytes=${from}-${to}` });
      expect(range.statusCode, `${from}-${to}`).toBe(206);
      expect(range.headers["content-range"]).toBe(`bytes ${from}-${to}/${data.length}`);
      expect(range.rawPayload.equals(data.subarray(from, to + 1))).toBe(true);
    }
    const info = await http.get(url(instanceId, fileId, "/info"));
    expect(info.json()).toMatchObject({
      filename: "big.bin",
      size: data.length,
      encryption: "tenant",
    });
  });

  it("keyring: every PATCH needs the owner's token (423 without), the file lands under the keyring", async () => {
    const { principal, token } = await owner("tus");
    const data = planted(SIZE);
    const headers = { ...bearer(fx.full.key), ...user(principal, unlockHeader(token)) };
    const created = await createUpload(
      data.length,
      { filename: "k.bin", encryption: "keyring" },
      headers,
    );
    expect(created.response.statusCode, created.response.body).toBe(201);
    const noToken = await patch(created.id, 0, data.subarray(0, 100), {
      ...bearer(fx.full.key),
      ...user(principal),
    });
    expect(noToken.statusCode).toBe(423);
    expect(Number((await head(created.id, headers)).headers["upload-offset"])).toBe(0);
    const { fileId, instanceId, get, stored } = await checkUpload(
      data,
      { filename: "k2.bin", encryption: "keyring" },
      headers,
      { encryption: "keyring" },
    );
    expect(stored.keyringId).not.toBeNull();
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(data)).toBe(true);
    expect((await http.get(url(instanceId, fileId), user(principal))).statusCode).toBe(423);
  });

  it("caller: the key on every PATCH (423 without, 409 wrong), the result opens only under it", async () => {
    const key = randomBytes(32);
    const data = planted(SIZE);
    const headers = { ...bearer(callerKey), ...contentKey(key), key: callerKey } as Headers;
    const created = await createUpload(
      data.length,
      { filename: "c.bin", encryption: "caller" },
      headers,
    );
    expect(created.response.statusCode, created.response.body).toBe(201);
    expect((await patch(created.id, 0, data.subarray(0, 100), bearer(callerKey))).statusCode).toBe(
      423,
    );
    const wrong = await patch(created.id, 0, data.subarray(0, 100), {
      ...bearer(callerKey),
      ...contentKey(randomBytes(32)),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.message).toBe(INTEGRITY_ERROR_MESSAGE);
    // Nothing of the refused PATCHes counted.
    expect(Number((await head(created.id, headers)).headers["upload-offset"])).toBe(0);
    const { fileId, instanceId, get } = await checkUpload(
      data,
      { filename: "c2.bin", encryption: "caller" },
      headers,
      { encryption: "caller" },
    );
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(data)).toBe(true);
    expect((await http.get(url(instanceId, fileId), {}, callerKey)).statusCode).toBe(423);
    // Creation without the key: nothing is created at all.
    const locked = await createUpload(
      10,
      { filename: "x", encryption: "caller" },
      bearer(callerKey),
    );
    expect(locked.response.statusCode).toBe(423);
  });

  it("an interrupted PATCH in the middle of a segment: what arrived is sealed, HEAD is exact, the upload resumes byte-identical", async () => {
    const data = planted(SIZE);
    const headers = bearer(fx.full.key);
    const created = await createUpload(
      data.length,
      { filename: "cut.bin", encryption: "tenant" },
      headers,
    );
    expect(created.response.statusCode).toBe(201);
    const sent = S + 30_000; // one whole segment and part of the next
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        method: "PATCH",
        path: `/vola/uploads/${created.id}`,
        headers: {
          ...headers,
          ...TUS,
          "content-type": PATCH_TYPE,
          "upload-offset": "0",
          "content-length": String(data.length),
        },
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(data.subarray(0, sent), () => setTimeout(() => req.destroy(), 100));
    });
    let offset = -1;
    for (let attempt = 0; attempt < 60 && offset < 0; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const probe = await head(created.id, headers);
      const value = Number(probe.headers["upload-offset"]);
      if (value > 0) offset = value;
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(sent);
    // On disk: whole sealed segments in the part, the rest sealed apart, no plaintext anywhere.
    expect((await stat(partPath(created.id))).size).toBe(
      HEADER_BYTES + Math.floor(offset / S) * (S + 16),
    );
    expect(await exists(partialPath(created.id))).toBe(offset % S !== 0);
    await nothingPlainOnDisk();
    const rest = await patch(created.id, offset, data.subarray(offset), headers);
    expect(rest.statusCode, rest.body).toBe(204);
    const fileId = rest.headers["vola-file-id"] as string;
    const get = await http.get(url(created.instanceId, fileId));
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(data)).toBe(true);
  });

  it("a zero-length encrypted upload, a wrong offset, an overflow, and a delete that takes the sealed tail with it", async () => {
    const empty = await createUpload(
      0,
      { filename: "empty.bin", encryption: "tenant" },
      bearer(fx.full.key),
    );
    expect(empty.response.statusCode, empty.response.body).toBe(201);
    const emptyId = empty.response.headers["vola-file-id"] as string;
    expect(empty.response.json()).toMatchObject({ id: emptyId, size: 0, encryption: "tenant" });
    const get = await http.get(url(empty.instanceId, emptyId));
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.length).toBe(0);
    expect((await blobOf((await row(emptyId)).hash)).length).toBe(HEADER_BYTES + 16);

    const data = planted(S + 1000);
    const created = await createUpload(
      data.length,
      { filename: "o.bin", encryption: "tenant" },
      bearer(fx.full.key),
    );
    expect(
      (await patch(created.id, 0, data.subarray(0, 500), bearer(fx.full.key))).statusCode,
    ).toBe(204);
    expect(await exists(partialPath(created.id))).toBe(true);
    const mismatch = await patch(created.id, 7, data.subarray(7, 100), bearer(fx.full.key));
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("upload_offset_mismatch");
    const overflow = await patch(
      created.id,
      500,
      Buffer.concat([data.subarray(500), Buffer.from("x")]),
      bearer(fx.full.key),
    );
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json().error.code).toBe("upload_overflow");
    expect(Number((await head(created.id, bearer(fx.full.key))).headers["upload-offset"])).toBe(
      500,
    );
    const deleted = await app.inject({
      method: "DELETE",
      url: `/vola/uploads/${created.id}`,
      headers: { ...TUS, ...bearer(fx.full.key) },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await exists(partPath(created.id))).toBe(false);
    expect(await exists(partialPath(created.id))).toBe(false);
  });
});

// --- 3. client mode -----------------------------------------------------------------------

describe("client mode (encryption=client): opaque JSV blobs", () => {
  it("round-trips a blob the client sealed under its own key: stored as given, served as given, opened by nobody else", async () => {
    const plain = planted(2 * S + 777);
    const fk = newFileKey();
    const clientKek = randomBytes(32);
    const fkCt = aeadSeal(clientKek, fk, Buffer.from("my-app:fk"));
    const headers = bearer(fx.full.key);
    // The file id is in every AAD: the client learns it at creation, then seals.
    const length = ciphertextLengthFor(plain.length, S);
    const created = await createUpload(
      length,
      { filename: "e2e.bin", encryption: "client", fk_ct: fkCt.toString("base64") },
      headers,
    );
    expect(created.response.statusCode, created.response.body).toBe(201);
    const fileId = created.response.headers["vola-file-id"] as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    const blob = await encryptBuffer(fk, fileId, plain, {
      segmentSize: S,
      plaintextLength: plain.length,
    });
    expect(blob.length).toBe(length);
    const cut = S + 100;
    expect((await patch(created.id, 0, blob.subarray(0, cut), headers)).statusCode).toBe(204);
    const done = await patch(created.id, cut, blob.subarray(cut), headers);
    expect(done.statusCode, done.body).toBe(204);
    expect(done.headers["vola-file-id"]).toBe(fileId);
    const stored = await row(fileId);
    expect(stored).toMatchObject({
      encryption: "client",
      encFormat: 1,
      size: plain.length, // the plaintext length, derived from the blob's arithmetic
      filename: `${fileId}.bin`,
      mimeType: "application/octet-stream",
      keyringId: null,
    });
    expect(stored.fkCt?.equals(fkCt)).toBe(true);
    expect(stored.metaCt).toBeNull();
    expect((await blobOf(stored.hash)).equals(blob)).toBe(true);

    // Download: the ciphertext, byte for byte, in CIPHERTEXT coordinates.
    const get = await http.get(url(created.instanceId, fileId));
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("application/octet-stream");
    expect(get.headers["x-vola-encryption"]).toBe("client");
    expect(get.headers["cache-control"]).toBe("no-store");
    expect(get.headers["content-disposition"]).toBe(`attachment; filename="${fileId}.jsv"`);
    expect(get.headers["content-length"]).toBe(String(blob.length));
    expect(get.rawPayload.equals(blob)).toBe(true);
    expect((await decryptBuffer(fk, fileId, get.rawPayload)).equals(plain)).toBe(true);
    const range = await http.get(url(created.instanceId, fileId), { range: "bytes=0-23" });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(blob.subarray(0, 24))).toBe(true);
    // Nothing of it opens here: info masked, no thumbnail, no share, no rename, UDC masked.
    const info = await http.get(url(created.instanceId, fileId, "/info"));
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      filename: `${fileId}.bin`,
      encryption: "client",
      size: plain.length,
    });
    expect(info.headers["cache-control"]).toBe("no-store");
    expect((await http.get(url(created.instanceId, fileId, "/thumb/128"))).statusCode).toBe(404);
    const share = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers,
      payload: { file_id: fileId },
    });
    expect(share.statusCode).toBe(409);
    const rename = await http.patch(url(created.instanceId, fileId), { filename: "new.bin" });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error.code).toBe("client_opaque");
    const list = await http.get(`/vola/files/${TYPE}/${created.instanceId}`);
    expect(list.json().files[0].filename).toBe(`${fileId}.bin`);
  });

  it("refuses what is not a JSV blob (422 client_blob_invalid), a missing fk_ct, fk_ct outside client mode, and client through multipart", async () => {
    const headers = bearer(fx.full.key);
    const garbage = randomBytes(500);
    const created = await createUpload(
      garbage.length,
      { filename: "g.bin", encryption: "client", fk_ct: randomBytes(60).toString("base64") },
      headers,
    );
    expect(created.response.statusCode).toBe(201);
    const bad = await patch(created.id, 0, garbage, headers);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("client_blob_invalid");
    // A blob whose header promises more than the bytes hold (a cut) is refused the same way —
    // the one structural check the server can make without the key.
    const fk = newFileKey();
    const created2 = await createUpload(
      100,
      { filename: "g2.bin", encryption: "client", fk_ct: randomBytes(60).toString("base64") },
      headers,
    );
    const fileId2 = created2.response.headers["vola-file-id"] as string;
    const blob = await encryptBuffer(fk, fileId2, randomBytes(200), {
      segmentSize: S,
      plaintextLength: 200,
    });
    const truncated = await patch(created2.id, 0, blob.subarray(0, 100), headers);
    expect(truncated.statusCode).toBe(422);
    expect(truncated.json().error.code).toBe("client_blob_invalid");
    const noKey = await createUpload(100, { filename: "n.bin", encryption: "client" }, headers);
    expect(noKey.response.statusCode).toBe(422);
    expect(noKey.response.json().error.message).toContain("fk_ct");
    const misuse = await createUpload(
      100,
      { filename: "m.bin", encryption: "tenant", fk_ct: "AAAA" },
      headers,
    );
    expect(misuse.response.statusCode).toBe(422);
    const multipart = await http.upload(SECRET, "x.txt", {
      headers: { "x-vola-encryption": "client" },
    });
    expect(multipart.response.statusCode).toBe(422);
  });
});

// --- 4. derivatives ---------------------------------------------------------------------

describe("encrypted derivatives", () => {
  const WEBP_MAGIC = Buffer.from("WEBP");

  it("tenant (sync mode): the thumbnail is rendered inline under the key file, stored sealed, served no-store; purge takes it away", async () => {
    const { response, instanceId } = await http.upload(await pngFixture(), "cover.png", {
      headers: { "x-vola-encryption": "tenant" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info.processing_status).toBeNull(); // sync mode: nothing queued
    const thumb = await http.get(url(instanceId, info.id, "/thumb/128"));
    expect(thumb.statusCode, thumb.body).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(thumb.headers["x-thumbnail-status"]).toBe("ready");
    expect(thumb.headers["cache-control"]).toBe("no-store");
    expect(thumb.headers.etag).toBe(`"${info.id}.thumb-128-cover.webp"`);
    const image = await decode(thumb.rawPayload);
    expect(image.width).toBe(128);
    expect(isRed(image.pixel(10, 64))).toBe(true);
    expect(isBlue(image.pixel(118, 64))).toBe(true);
    // The sibling on disk is sealed: no WebP magic in the clear; it opens under FK only.
    const stored = await row(info.id);
    const sibling = await readFile(
      `${storage.blobPath(stored.hash)}.${encryptedThumbnailName(info.id, 128, "cover")}`,
    );
    expect(sibling.includes(WEBP_MAGIC)).toBe(false);
    expect(sibling.includes(Buffer.from("RIFF"))).toBe(false);
    expect(() => openThumbnail(newFileKey(), info.id, 128, "cover", sibling)).toThrow();
    const plainSiblings = (await readdir(join(storage.blobPath(stored.hash), ".."))).filter(
      (n) => n.startsWith(stored.hash) && n.includes("thumb-") && !n.includes("enc-"),
    );
    expect(plainSiblings).toEqual([]);
    // Cached by the client? 304 on the etag; HEAD works.
    expect(
      (
        await http.get(url(instanceId, info.id, "/thumb/128"), {
          "if-none-match": thumb.headers.etag as string,
        })
      ).statusCode,
    ).toBe(304);
    expect((await http.head(url(instanceId, info.id, "/thumb/128"))).statusCode).toBe(200);
    // Purge removes the blob and every sealed sibling.
    expect((await http.del(url(instanceId, info.id, "/purge"))).statusCode).toBe(200);
    expect(await exists(storage.blobPath(stored.hash))).toBe(false);
    expect(
      await exists(
        `${storage.blobPath(stored.hash)}.${encryptedThumbnailName(info.id, 128, "cover")}`,
      ),
    ).toBe(false);
  });

  it("keyring: inline with the token, 423 without; caller: with the key, 423 without; a PDF too", async () => {
    const { principal, token } = await owner("thumb");
    const { response, instanceId } = await http.upload(await pngFixture(), "pin.png", {
      headers: { "x-vola-encryption": "keyring", ...user(principal, unlockHeader(token)) },
      fieldsFirst: true,
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info.processing_status).toBeNull();
    const locked = await http.get(url(instanceId, info.id, "/thumb/64"), user(principal));
    expect(locked.statusCode).toBe(423);
    const thumb = await http.get(
      url(instanceId, info.id, "/thumb/64"),
      user(principal, unlockHeader(token)),
    );
    expect(thumb.statusCode, thumb.body).toBe(200);
    expect(thumb.headers["x-thumbnail-status"]).toBe("ready");
    expect(thumb.headers["cache-control"]).toBe("no-store");
    expect((await decode(thumb.rawPayload)).width).toBe(64);
    // The second request opens the sealed sibling instead of rendering again: same bytes.
    const again = await http.get(
      url(instanceId, info.id, "/thumb/64"),
      user(principal, unlockHeader(token)),
    );
    expect(again.rawPayload.equals(thumb.rawPayload)).toBe(true);

    const key = randomBytes(32);
    const pdf = await http.upload(pdfFixture(), "doc.pdf", {
      key: callerKey,
      headers: { "x-vola-encryption": "caller", ...contentKey(key) },
    });
    expect(pdf.response.statusCode, pdf.response.body).toBe(201);
    const pdfInfo = FileInfoSchema.parse(pdf.response.json());
    expect(pdfInfo.mime_type).toBe("application/pdf");
    expect(
      (await http.get(url(pdf.instanceId, pdfInfo.id, "/thumb/256"), {}, callerKey)).statusCode,
    ).toBe(423);
    const pdfThumb = await http.get(
      url(pdf.instanceId, pdfInfo.id, "/thumb/256"),
      contentKey(key),
      callerKey,
    );
    expect(pdfThumb.statusCode, pdfThumb.body).toBe(200);
    expect((await decode(pdfThumb.rawPayload)).width).toBe(256);
    // A text file has none, whatever the key.
    const text = await http.upload(SECRET, "t.txt", {
      key: callerKey,
      headers: { "x-vola-encryption": "caller", ...contentKey(key) },
    });
    const none = await http.get(
      url(text.instanceId, text.response.json().id, "/thumb/64"),
      contentKey(key),
      callerKey,
    );
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("no_thumbnail");
    await nothingPlainOnDisk();
  });

  it("tenant (async mode): the worker renders the four sizes sealed and the OCR lands in ocr_ct, never in ocr_text", async () => {
    const asyncHttp = httpClient(asyncApp, fx.full.key, TYPE);
    const { response, instanceId } = await asyncHttp.upload(await pngFixture(), "w.png", {
      headers: { "x-vola-encryption": "tenant" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info.processing_status).toBe("PENDING");
    const jobs = await waitFor(
      async () => {
        const all = await listProcessingJobs(handle.db, info.id);
        return all.length > 0 && all.every((j) => j.status !== "PENDING" && j.status !== "RUNNING")
          ? all
          : null;
      },
      { label: `jobs of ${info.id}`, timeoutMs: 40_000 },
    );
    const thumbs = jobs.filter((j) => j.kind === "THUMBNAIL");
    expect(thumbs.map((j) => j.status)).toEqual(["DONE", "DONE", "DONE", "DONE"]);
    const stored = await row(info.id);
    for (const size of THUMBNAIL_SIZES) {
      const sealed = await storage.statDerived(
        stored.hash,
        encryptedThumbnailName(info.id, size, "cover"),
      );
      expect(sealed, `size ${size}`).not.toBeNull();
      expect((await readFile((sealed as { path: string }).path)).includes(WEBP_MAGIC)).toBe(false);
    }
    // The route serves what the worker made (no 202 any more), decrypted here.
    const thumb = await asyncHttp.get(url(instanceId, info.id, "/thumb/512"));
    expect(thumb.statusCode, thumb.body).toBe(200);
    expect(thumb.headers["x-thumbnail-status"]).toBe("ready");
    expect((await decode(thumb.rawPayload)).width).toBe(512);
    const ocr = jobs.find((j) => j.kind === "OCR");
    expect(ocr).toBeDefined();
    const [meta] = await handle.db
      .select()
      .from(fileMetadata)
      .where(eq(fileMetadata.fileId, info.id));
    if (tesseract) {
      expect(ocr?.status).toBe("DONE");
      expect(meta?.ocrCt).not.toBeNull();
      expect(meta?.ocrText).toBeNull();
      expect(meta?.ocrLang).toBeNull();
      const detail = await asyncHttp.get(url(instanceId, info.id, "/info?ocr=full"));
      expect(detail.json().ocr).toMatchObject({ status: "DONE", lang: "eng", pages: 1 });
      expect(typeof detail.json().ocr.text).toBe("string");
      // Not in the full-text search: the UDC `ocr` flag says "no text" for an encrypted file.
      const udc = await asyncApp.inject({
        method: "POST",
        url: "/vola/udc/list",
        headers: { ...bearer(fx.full.key), "x-udc-message-id": "m1" },
        payload: {
          collection: "files",
          filter: {
            and: [
              { field: "instance_id", op: "eq", value: instanceId },
              { field: "ocr", op: "eq", value: true },
            ],
          },
        },
      });
      expect(udc.json().payload.rows).toEqual([]);
    } else {
      expect(ocr?.status).toBe("SKIPPED");
    }
  });

  it("a keyring or caller file gets no job in async mode; a file above the limit gets no inline thumbnail (404)", async () => {
    const { principal, token } = await owner("nojob");
    const asyncHttp = httpClient(asyncApp, fx.full.key, TYPE);
    const { response } = await asyncHttp.upload(await pngFixture(), "nj.png", {
      headers: { "x-vola-encryption": "keyring", ...user(principal, unlockHeader(token)) },
      fieldsFirst: true,
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info.processing_status).toBeNull();
    expect(await listProcessingJobs(handle.db, info.id)).toEqual([]);

    const tiny = await buildApp({
      config: { ...config, keyFile, storagePath: join(root, "storage"), encDeriveMaxBytes: 100 },
      db: handle.db,
      logger: false,
      storage,
      events: false,
      uploadSweepIntervalMs: 0,
    });
    await tiny.ready();
    try {
      const tinyHttp = httpClient(tiny, fx.full.key, TYPE);
      const big = await tinyHttp.upload(await pngFixture(), "big.png", {
        headers: { "x-vola-encryption": "tenant" },
      });
      expect(big.response.statusCode, big.response.body).toBe(201);
      const refused = await tinyHttp.get(url(big.instanceId, big.response.json().id, "/thumb/64"));
      expect(refused.statusCode).toBe(404);
      expect(refused.json().error.message).toContain("limit");
    } finally {
      await tiny.close();
    }
  });
});

// --- 5. the share grant -----------------------------------------------------------------

describe("share grant", () => {
  async function grant(headers: Headers = {}, body: Record<string, unknown> = {}) {
    const { response, instanceId } = await http.upload(SECRET, "grant.txt", {
      headers: { "x-vola-encryption": "tenant", ...headers },
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    const created = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: { ...bearer(fx.full.key), ...headers },
      payload: { file_id: info.id, ...body },
    });
    return { info, instanceId, created };
  }

  it("tenant: the URL carries #secret, the secret is nowhere, the public link needs it (401 / 409 / 200), Range works, max_downloads holds", async () => {
    const { info, created } = await grant({}, { max_downloads: 2 });
    expect(created.statusCode, created.body).toBe(201);
    const share = ShareCreatedSchema.parse(created.json());
    expect(share.encrypted).toBe(true);
    const fragment = share.url.split("#")[1] as string;
    expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await handle.db.select().from(shareLinks).where(eq(shareLinks.id, share.id));
    expect(stored?.fkShareCt?.length).toBe(60);
    for (const [column, value] of Object.entries(stored ?? {})) {
      const text = Buffer.isBuffer(value) ? value.toString("latin1") : String(value ?? "");
      expect(text.includes(fragment), column).toBe(false);
      expect(text.includes(Buffer.from(fragment, "base64url").toString("latin1")), column).toBe(
        false,
      );
    }
    const link = `/vola/s/${share.token}`;
    const missing = await app.inject({ method: "GET", url: link });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("share_secret_required");
    const wrong = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-secret": randomBytes(32).toString("base64url") },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.message).toBe(INTEGRITY_ERROR_MESSAGE);
    const garbled = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-secret": "short" },
    });
    expect(garbled.statusCode).toBe(409);
    // Neither the missing nor the wrong secret counted as a download.
    expect(
      (await handle.db.select().from(shareLinks).where(eq(shareLinks.id, share.id)))[0]
        ?.downloadCount,
    ).toBe(0);
    const right = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-secret": fragment },
    });
    expect(right.statusCode, right.body).toBe(200);
    expect(right.rawPayload.equals(SECRET)).toBe(true);
    expect(right.headers["cache-control"]).toBe("no-store"); // decrypted bytes: never cached, whoever asks
    expect(right.headers["content-disposition"]).toContain("grant.txt");
    const range = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-secret": fragment, range: "bytes=15-62" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(MARKER)).toBe(true); // a continuation: not counted
    const second = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-secret": fragment },
    });
    expect(second.statusCode).toBe(200);
    const third = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-secret": fragment },
    });
    expect(third.statusCode).toBe(410);
    expect(third.json().error.code).toBe("share_gone");
    // The owner's own key is untouched: the file still opens through the API.
    expect((await http.get(url(info.instance_id, info.id))).statusCode).toBe(200);
  });

  it("revoke drops the grant (fk_share_ct NULL): the link is 410 and nothing is left to open", async () => {
    const { created } = await grant();
    const share = ShareCreatedSchema.parse(created.json());
    const fragment = share.url.split("#")[1] as string;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/vola/shares/${share.id}`,
      headers: bearer(fx.full.key),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().encrypted).toBe(false);
    const [stored] = await handle.db.select().from(shareLinks).where(eq(shareLinks.id, share.id));
    expect(stored?.fkShareCt).toBeNull();
    expect(stored?.revokedAt).not.toBeNull();
    const gone = await app.inject({
      method: "GET",
      url: `/vola/s/${share.token}`,
      headers: { "x-share-secret": fragment },
    });
    expect(gone.statusCode).toBe(410);
  });

  it("keyring: the grant needs the owner's token (423 without); password and secret together; the recipient needs no token", async () => {
    const { principal, token } = await owner("share");
    const { response, instanceId } = await http.upload(SECRET, "pin.txt", {
      headers: { "x-vola-encryption": "keyring", ...user(principal, unlockHeader(token)) },
      fieldsFirst: true,
    });
    expect(response.statusCode, response.body).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    const locked = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: { ...bearer(fx.full.key), ...user(principal) },
      payload: { file_id: info.id },
    });
    expect(locked.statusCode).toBe(423);
    const created = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: { ...bearer(fx.full.key), ...user(principal, unlockHeader(token)) },
      payload: { file_id: info.id, password: "hunter2" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const share = ShareCreatedSchema.parse(created.json());
    const fragment = share.url.split("#")[1] as string;
    const link = `/vola/s/${share.token}`;
    // The password comes first (5.1), then the secret.
    expect(
      (await app.inject({ method: "GET", url: link, headers: { "x-share-secret": fragment } }))
        .statusCode,
    ).toBe(401);
    const noSecret = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-password": "hunter2" },
    });
    expect(noSecret.statusCode).toBe(401);
    expect(noSecret.json().error.code).toBe("share_secret_required");
    const both = await app.inject({
      method: "GET",
      url: link,
      headers: { "x-share-password": "hunter2", "x-share-secret": fragment },
    });
    expect(both.statusCode, both.body).toBe(200);
    expect(both.rawPayload.equals(SECRET)).toBe(true);
    // The listing of the owner shows the grant; the secret is not in it.
    const listed = await http.get(`/vola/shares?file_id=${info.id}`);
    expect(listed.json().shares[0]).toMatchObject({ id: share.id, encrypted: true });
    expect(JSON.stringify(listed.json()).includes(fragment)).toBe(false);
    expect(instanceId).toBeTruthy();
  });

  it("a folder share still hides encrypted files (no grant per file in a folder)", async () => {
    const instanceId = randomUUID();
    expect((await http.post(`/vola/folders/${TYPE}/${instanceId}/docs`)).statusCode).toBe(201);
    const enc = await http.upload(SECRET, "enc.txt", {
      instanceId,
      headers: { "x-vola-encryption": "tenant" },
      fields: { folder_path: "docs" },
      fieldsFirst: true,
    });
    expect(enc.response.statusCode, enc.response.body).toBe(201);
    const plain = await http.upload(Buffer.from("hello"), "plain.txt", {
      instanceId,
      fields: { folder_path: "docs" },
      fieldsFirst: true,
    });
    expect(plain.response.statusCode).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { folder: { instance_type: TYPE, instance_id: instanceId, path: "docs" } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const share = ShareCreatedSchema.parse(created.json());
    expect(share.encrypted).toBe(false);
    expect(share.url.includes("#")).toBe(false);
    const listing = await app.inject({ method: "GET", url: `/vola/s/${share.token}` });
    expect(listing.json().files.map((f: { filename: string }) => f.filename)).toEqual([
      "plain.txt",
    ]);
    expect(
      (await app.inject({ method: "GET", url: `/vola/s/${share.token}/path/enc.txt` })).statusCode,
    ).toBe(404);
  });
});
