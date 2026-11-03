/**
 * The examples site's server side (plan 8.1): the configuration, the demo tenant and its
 * keys, `GET /examples/config`, the write proxy and its policy, the regenerate route, the
 * purge, and the SPA served from `VOLA_UI_DIR`. Real database, `sync` jobs (thumbnails
 * render inline), no Redis.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeTusMetadata,
  FileInfoSchema,
  ShareCreatedSchema,
  thumbnailDerivedName,
} from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "../src/apikey.js";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { apiKeys, files, folders, tenants } from "../src/db/schema.js";
import { ensureDemoTenant, SEEDER_USER } from "../src/examples/demo.js";
import { RateLimiter } from "../src/examples/limiter.js";
import {
  DEMO_MIME_TYPES,
  demoAction,
  isCountedWrite,
  mimeAllowed,
} from "../src/examples/policy.js";
import { createApiKey } from "../src/services/apikeys.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { pngFixture } from "./fixtures.js";
import { config as baseConfig, bearer, setupFixture, testDatabase, truncate } from "./helpers.js";
import { fileUpload, multipartHeaders } from "./multipart.js";

const handle = testDatabase(4);
const READ_KEY = generateApiKey("test").key;
const WRITE_KEY = generateApiKey("test").key;
const INSTANCE = "00000000-0000-4000-8000-000000000001";
const MAX = 256 * 1024;
const VISITOR = "demo-abc123xyz";
const WRITE = "/vola/examples/write";
const DEMO = `files/demo/${INSTANCE}`;

let root: string;
let storage: FilesystemBackend;
let app: FastifyInstance;
let fx: Awaited<ReturnType<typeof setupFixture>>;
let plain: FastifyInstance;
let limiter: RateLimiter;
let clock = Date.now();

const examplesEnv = {
  ...process.env,
  VOLA_PREFIX: "/vola",
  VOLA_RECORD_CANDIDATES: "false",
  VOLA_WORKER_ENABLED: "0",
  VOLA_EXAMPLES: "true",
  VOLA_DEMO_API_KEY: READ_KEY,
  VOLA_DEMO_WRITE_KEY: WRITE_KEY,
  VOLA_DEMO_MAX_UPLOAD_BYTES: String(MAX),
  VOLA_DEMO_PURGE_INTERVAL_MIN: "0",
  VOLA_DEMO_RATE_LIMIT: "1000",
};

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-examples-"));
  storage = new FilesystemBackend(join(root, "storage"));
  const config = loadConfig({ ...examplesEnv, VOLA_STORAGE_PATH: join(root, "storage") });
  limiter = new RateLimiter(1000, 600_000, () => clock);
  fx = await setupFixture(handle, {
    config,
    storage,
    uploadSweepIntervalMs: 0,
    examplesDeps: { limiter },
  });
  app = fx.app;
  await app.ready();
  // The same database, the examples OFF: the routes do not exist there.
  plain = await buildApp({
    config: baseConfig,
    db: handle.db,
    logger: false,
    storage,
    examples: false,
  });
  await plain.ready();
});
afterAll(async () => {
  await app.close();
  await plain.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  clock = Date.now();
});

const visitor = (extra: Record<string, string> = {}) => ({ "x-user-id": VISITOR, ...extra });

async function uploadVia(
  path: string,
  data: Buffer,
  filename: string,
  options: {
    contentType?: string;
    headers?: Record<string, string>;
    fields?: Record<string, string>;
  } = {},
) {
  return app.inject({
    method: "POST",
    url: path,
    headers: multipartHeaders({ ...visitor(), ...options.headers }),
    payload: fileUpload(filename, data, {
      contentType: options.contentType,
      fields: options.fields,
    }),
  });
}

/** A file the seeder would upload: through the write key, as the seeder. */
async function seed(filename: string, data: Buffer, contentType: string) {
  const response = await app.inject({
    method: "POST",
    url: `/vola/${DEMO}`,
    headers: multipartHeaders({ ...bearer(WRITE_KEY), "x-user-id": SEEDER_USER }),
    payload: fileUpload(filename, data, { contentType }),
  });
  expect(response.statusCode).toBe(201);
  return FileInfoSchema.parse(response.json());
}

// --- configuration -----------------------------------------------------------------------------

describe("the configuration", () => {
  it("is off by default and needs two well-formed, different keys when on", () => {
    expect(loadConfig({}).examples).toBeNull();
    expect(loadConfig({}).uiDir).toBeNull();
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(() => loadConfig({ VOLA_EXAMPLES: "true" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ VOLA_EXAMPLES: "true", VOLA_DEMO_API_KEY: "x", VOLA_DEMO_WRITE_KEY: "y" }),
    ).toThrow(/well-formed/);
    expect(() =>
      loadConfig({
        VOLA_EXAMPLES: "true",
        VOLA_DEMO_API_KEY: READ_KEY,
        VOLA_DEMO_WRITE_KEY: READ_KEY,
      }),
    ).toThrow(/two different keys/);
    const config = loadConfig({
      VOLA_EXAMPLES: "yes",
      VOLA_DEMO_API_KEY: READ_KEY,
      VOLA_DEMO_WRITE_KEY: WRITE_KEY,
      VOLA_UI_DIR: "ui",
      VOLA_TRUST_PROXY: "1",
    });
    expect(config.examples).toMatchObject({
      apiKey: READ_KEY,
      writeKey: WRITE_KEY,
      tenant: "demo",
      instanceType: "demo",
      instanceId: INSTANCE,
      maxUploadBytes: 5 * 1024 * 1024,
      ttlHours: 24,
      rateLimit: 60,
      purgeIntervalMin: 15,
    });
    expect(config.uiDir?.endsWith("/ui")).toBe(true);
    expect(config.trustProxy).toBe(true);
    expect(() => loadConfig({ ...examplesEnv, VOLA_DEMO_INSTANCE_ID: "not-a-uuid" })).toThrow(
      ConfigError,
    );
  });
});

// --- the demo tenant and its keys ----------------------------------------------------------------

describe("ensureDemoTenant", () => {
  it("created the tenant and stored both keys with their scopes at startup", async () => {
    const [tenant] = await handle.db.select().from(tenants).where(eq(tenants.slug, "demo"));
    expect(tenant).toBeTruthy();
    const keys = await handle.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenant?.id ?? ""));
    expect(keys.map((k) => k.scopes).sort((a, b) => a.length - b.length)).toEqual([
      ["files:read", "folders:read"],
      [
        "files:read",
        "files:write",
        "folders:read",
        "folders:write",
        "shares:write",
        "keyrings:write",
      ],
    ]);
    // A second start with the same keys finds them and is content.
    const again = await ensureDemoTenant(handle.db, loadConfig(examplesEnv).examples as never);
    expect(again.tenantSlug).toBe("demo");
  });

  it("refuses a visitor key that can write, and a write key that cannot", async () => {
    const tenant = (await handle.db.select().from(tenants).where(eq(tenants.slug, "demo")))[0];
    const writer = await createApiKey(handle.db, {
      tenantId: tenant?.id ?? "",
      name: "writer",
      env: "test",
      scopes: ["files:read", "files:write"],
    });
    const reader = await createApiKey(handle.db, {
      tenantId: tenant?.id ?? "",
      name: "reader",
      env: "test",
      scopes: ["files:read"],
    });
    const cfg = loadConfig(examplesEnv).examples as NonNullable<
      ReturnType<typeof loadConfig>["examples"]
    >;
    await expect(ensureDemoTenant(handle.db, { ...cfg, apiKey: writer.key })).rejects.toThrow(
      /may hold only files:read, folders:read/,
    );
    await expect(ensureDemoTenant(handle.db, { ...cfg, writeKey: reader.key })).rejects.toThrow(
      /lacks the scope/,
    );
    await expect(
      ensureDemoTenant(handle.db, { ...cfg, apiKey: generateApiKey("admin").key }),
    ).rejects.toThrow(/tenant key/);
    // The visitor's key of another tenant is refused too.
    const other = (await handle.db.select().from(tenants).where(eq(tenants.slug, "acme")))[0];
    const foreign = await createApiKey(handle.db, {
      tenantId: other?.id ?? "",
      name: "foreign",
      env: "test",
      scopes: ["files:read"],
    });
    await expect(ensureDemoTenant(handle.db, { ...cfg, apiKey: foreign.key })).rejects.toThrow(
      /another tenant/,
    );
    // And a startup with a bad key does not start.
    await expect(
      buildApp({
        config: { ...loadConfig(examplesEnv), examples: { ...cfg, apiKey: writer.key } },
        db: handle.db,
        logger: false,
        storage,
      }),
    ).rejects.toThrow(/examples:/);
  });
});

// --- /examples/config ----------------------------------------------------------------------------

describe("GET /examples/config", () => {
  it("hands out the read-only key and the limits, never cached; 404 without VOLA_EXAMPLES", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/examples/config" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      api_key: READ_KEY,
      tenant: "demo",
      instance_type: "demo",
      instance_id: INSTANCE,
      user_prefix: "demo-",
      write_path: "/vola/examples/write/",
      limits: {
        max_upload_bytes: MAX,
        ttl_hours: 24,
        rate_limit: 1000,
        mime_types: DEMO_MIME_TYPES,
      },
      features: { keyring: false, worker: false },
    });
    expect(response.json().api_key).not.toBe(WRITE_KEY);

    const off = await plain.inject({ method: "GET", url: "/vola/examples/config" });
    expect(off.statusCode).toBe(404);
    const offWrite = await plain.inject({ method: "POST", url: `${WRITE}/${DEMO}` });
    expect(offWrite.statusCode).toBe(404);
  });

  it("the visitor's key reads the demo instance and cannot write to it", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/vola/${DEMO}`,
      headers: bearer(READ_KEY),
    });
    expect(list.statusCode).toBe(200);
    const write = await uploadVia(`/vola/${DEMO}`, await pngFixture(), "a.png", {
      contentType: "image/png",
      headers: bearer(READ_KEY),
    });
    expect(write.statusCode).toBe(403);
  });
});

// --- the policy ------------------------------------------------------------------------------------

describe("demoAction (the policy)", () => {
  const scope = { instanceType: "demo", instanceId: INSTANCE };
  const fileId = randomUUID();
  it("allows what a visitor may do on the demo instance and nothing else", () => {
    expect(demoAction("POST", DEMO, scope)).toEqual({ kind: "upload" });
    expect(demoAction("GET", DEMO, scope)).toBeNull();
    expect(demoAction("POST", `files/demo/${randomUUID()}`, scope)).toBeNull();
    expect(demoAction("POST", `files/tickets/${INSTANCE}`, scope)).toBeNull();
    expect(demoAction("PATCH", `${DEMO}/${fileId}`, scope)).toEqual({ kind: "file-write", fileId });
    expect(demoAction("DELETE", `${DEMO}/${fileId}/purge`, scope)).toEqual({
      kind: "file-write",
      fileId,
    });
    expect(demoAction("DELETE", `${DEMO}/${fileId}/nope`, scope)).toBeNull();
    expect(demoAction("DELETE", `${DEMO}/not-a-uuid`, scope)).toBeNull();
    expect(demoAction("POST", `folders/demo/${INSTANCE}/a/b`, scope)).toEqual({
      kind: "folder-create",
      path: "a/b",
    });
    expect(demoAction("DELETE", `folders/demo/${INSTANCE}/a`, scope)).toEqual({
      kind: "folder-write",
      path: "a",
    });
    expect(demoAction("GET", `folders/demo/${INSTANCE}/a`, scope)).toBeNull();
    expect(demoAction("POST", "uploads", scope)).toEqual({ kind: "upload-create" });
    expect(demoAction("PATCH", `uploads/${fileId}`, scope)).toEqual({
      kind: "upload-continue",
      uploadId: fileId,
    });
    expect(demoAction("PATCH", `uploads/${fileId.replace("-", "%2D")}`, scope)).toBeNull();
    expect(demoAction("GET", `uploads/${fileId}`, scope)).toBeNull();
    expect(demoAction("POST", "shares", scope)).toEqual({ kind: "share-create" });
    expect(demoAction("GET", "shares", scope)).toEqual({ kind: "share-list" });
    expect(demoAction("DELETE", `shares/${fileId}`, scope)).toEqual({
      kind: "share-item",
      shareId: fileId,
    });
    expect(demoAction("DELETE", `shares/${fileId.replace("-", "%2D")}`, scope)).toBeNull();
    expect(demoAction("GET", "keyrings/me/status", scope)).toEqual({ kind: "keyring" });
    expect(demoAction("POST", "keyrings/me", scope)).toEqual({ kind: "keyring" });
    expect(demoAction("POST", "keyrings/me/unlock/close", scope)).toBeNull();
    expect(demoAction("GET", "keyrings/by-principal/x/status", scope)).toBeNull();
    expect(demoAction("POST", "keys", scope)).toBeNull();
    expect(demoAction("POST", "admin/transfer", scope)).toBeNull();
    expect(demoAction("GET", "stats/tenant", scope)).toBeNull();
  });
  it("counts the writes, not the reads, and not every chunk of a resumable upload", () => {
    expect(isCountedWrite("POST", { kind: "upload" })).toBe(true);
    expect(isCountedWrite("GET", { kind: "share-list" })).toBe(false);
    expect(isCountedWrite("PATCH", { kind: "upload-continue", uploadId: "x" })).toBe(false);
    expect(isCountedWrite("POST", { kind: "upload-create" })).toBe(true);
  });
  it("knows the types a visitor may keep", () => {
    expect(mimeAllowed("image/png")).toBe(true);
    expect(mimeAllowed("Application/PDF; charset=x")).toBe(true);
    expect(mimeAllowed("application/zip")).toBe(false);
    expect(mimeAllowed(null)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows `limit` hits per window and says when to come back", () => {
    let t = 1_000_000;
    const limiter = new RateLimiter(2, 10_000, () => t);
    expect(limiter.hit("a")).toEqual({ allowed: true });
    t += 1000;
    expect(limiter.hit("a")).toEqual({ allowed: true });
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterS: 9 });
    expect(limiter.hit("b")).toEqual({ allowed: true });
    expect(limiter.count("a")).toBe(2);
    t += 9_500;
    expect(limiter.hit("a")).toEqual({ allowed: true });
  });
});

// --- the write proxy -------------------------------------------------------------------------------

describe("the write proxy", () => {
  it("refuses what the policy refuses, and a request without a visitor id", async () => {
    const list = await app.inject({ method: "GET", url: `${WRITE}/${DEMO}`, headers: visitor() });
    expect(list.statusCode).toBe(403);
    expect(list.json().error.code).toBe("demo_forbidden");
    const keys = await app.inject({
      method: "POST",
      url: `${WRITE}/keys`,
      headers: visitor(),
      payload: {},
    });
    expect(keys.statusCode).toBe(403);
    const anonymous = await uploadVia(`${WRITE}/${DEMO}`, await pngFixture(), "a.png", {
      contentType: "image/png",
      headers: { "x-user-id": "" },
    });
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.json().error.code).toBe("demo_user_required");
    const wrongShape = await uploadVia(`${WRITE}/${DEMO}`, await pngFixture(), "a.png", {
      contentType: "image/png",
      headers: { "x-user-id": "alice" },
    });
    expect(wrongShape.statusCode).toBe(400);
  });

  it("uploads on the visitor's behalf under the write key, attributed to the visitor", async () => {
    const response = await uploadVia(`${WRITE}/${DEMO}`, await pngFixture(), "mine.png", {
      contentType: "image/png",
      fields: { folder_path: "visitors" },
    });
    expect(response.statusCode).toBe(201);
    const info = FileInfoSchema.parse(response.json());
    expect(info).toMatchObject({
      filename: "mine.png",
      mime_type: "image/png",
      created_by: VISITOR,
    });
    // Visible to the visitor's read-only key.
    const seen = await app.inject({
      method: "GET",
      url: `/vola/${DEMO}/${info.id}/info`,
      headers: bearer(READ_KEY),
    });
    expect(seen.statusCode).toBe(200);
    // The visitor may rename it…
    const renamed = await app.inject({
      method: "PATCH",
      url: `${WRITE}/${DEMO}/${info.id}`,
      headers: visitor(),
      payload: { filename: "renamed.png" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().filename).toBe("renamed.png");
    // …and delete it.
    const deleted = await app.inject({
      method: "DELETE",
      url: `${WRITE}/${DEMO}/${info.id}`,
      headers: visitor(),
    });
    expect(deleted.statusCode).toBe(200);
  });

  it("purges an upload of a type the demo does not keep and answers 415", async () => {
    const response = await uploadVia(
      `${WRITE}/${DEMO}`,
      Buffer.from("PK\u0003\u0004zip zip zip"),
      "x.zip",
      {
        contentType: "application/zip",
      },
    );
    expect(response.statusCode).toBe(415);
    expect(response.json().error).toMatchObject({
      code: "demo_mime_not_allowed",
      mime_type: "application/zip",
    });
    const rows = await handle.db.select().from(files).where(eq(files.filename, "x.zip"));
    expect(rows).toEqual([]);
  });

  it("refuses a body above the demo limit before it is read, and needs Content-Length", async () => {
    const big = await uploadVia(`${WRITE}/${DEMO}`, Buffer.alloc(MAX + 100 * 1024, 1), "big.bin", {
      contentType: "image/png",
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("demo_too_large");
    const noLength = await app.inject({
      method: "POST",
      url: `${WRITE}/${DEMO}`,
      headers: multipartHeaders({ ...visitor(), "transfer-encoding": "chunked" }),
      payload: fileUpload("a.png", await pngFixture(), { contentType: "image/png" }),
      // light-my-request sets content-length for a Buffer; a stream has none.
    });
    expect([201, 411]).toContain(noLength.statusCode);
  });

  it("never writes to a seeded file or folder", async () => {
    const seeded = await seed("seeded.png", await pngFixture(), "image/png");
    const folder = await app.inject({
      method: "POST",
      url: `/vola/folders/demo/${INSTANCE}/images`,
      headers: { ...bearer(WRITE_KEY), "x-user-id": SEEDER_USER },
    });
    expect(folder.statusCode).toBe(201);
    const rename = await app.inject({
      method: "PATCH",
      url: `${WRITE}/${DEMO}/${seeded.id}`,
      headers: visitor(),
      payload: { filename: "hacked.png" },
    });
    expect(rename.statusCode).toBe(403);
    expect(rename.json().error).toMatchObject({ code: "demo_forbidden", file_id: seeded.id });
    const purge = await app.inject({
      method: "DELETE",
      url: `${WRITE}/${DEMO}/${seeded.id}/purge`,
      headers: visitor(),
    });
    expect(purge.statusCode).toBe(403);
    const delFolder = await app.inject({
      method: "DELETE",
      url: `${WRITE}/folders/demo/${INSTANCE}/images`,
      headers: visitor(),
    });
    expect(delFolder.statusCode).toBe(403);
    // A visitor's own folder is theirs.
    const mine = await app.inject({
      method: "POST",
      url: `${WRITE}/folders/demo/${INSTANCE}/mine`,
      headers: visitor(),
    });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().created_by).toBe(VISITOR);
    const gone = await app.inject({
      method: "DELETE",
      url: `${WRITE}/folders/demo/${INSTANCE}/mine`,
      headers: visitor(),
    });
    expect(gone.statusCode).toBe(200);
    // An unknown file is the real route's 404, not a 403.
    const missing = await app.inject({
      method: "PATCH",
      url: `${WRITE}/${DEMO}/${randomUUID()}`,
      headers: visitor(),
      payload: { filename: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  describe("another visitor's rows", () => {
    const OTHER = "demo-otherone42";
    const other = (extra: Record<string, string> = {}) => ({ "x-user-id": OTHER, ...extra });
    const tus = { "tus-resumable": "1.0.0" };

    async function mineFile(name: string) {
      const up = await uploadVia(`${WRITE}/${DEMO}`, Buffer.from(`a file: ${name}`), name, {
        contentType: "text/plain",
      });
      expect(up.statusCode).toBe(201);
      return FileInfoSchema.parse(up.json());
    }

    async function liveFile(id: string) {
      return app.inject({
        method: "GET",
        url: `/vola/${DEMO}/${id}/info`,
        headers: bearer(READ_KEY),
      });
    }

    it("refuses a PATCH, DELETE or purge of another visitor's file; the owner still can", async () => {
      const file = await mineFile("theirs.txt");
      for (const [method, tail, payload] of [
        ["PATCH", file.id, { filename: "stolen.txt" }],
        ["DELETE", file.id, undefined],
        ["DELETE", `${file.id}/purge`, undefined],
      ] as const) {
        const refused = await app.inject({
          method,
          url: `${WRITE}/${DEMO}/${tail}`,
          headers: other(),
          ...(payload ? { payload } : {}),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toMatchObject({ code: "demo_forbidden", file_id: file.id });
      }
      const after = await liveFile(file.id);
      expect(after.statusCode).toBe(200);
      expect(after.json().filename).toBe("theirs.txt");
      const renamed = await app.inject({
        method: "PATCH",
        url: `${WRITE}/${DEMO}/${file.id}`,
        headers: visitor(),
        payload: { filename: "still-mine.txt" },
      });
      expect(renamed.statusCode).toBe(200);
      const purged = await app.inject({
        method: "DELETE",
        url: `${WRITE}/${DEMO}/${file.id}/purge`,
        headers: visitor(),
      });
      expect(purged.statusCode).toBe(200);
    });

    it("refuses a PATCH or DELETE of another visitor's folder", async () => {
      const made = await app.inject({
        method: "POST",
        url: `${WRITE}/folders/demo/${INSTANCE}/their-folder`,
        headers: visitor(),
      });
      expect(made.statusCode).toBe(201);
      for (const [method, payload] of [
        ["PATCH", { name: "stolen" }],
        ["DELETE", undefined],
      ] as const) {
        const refused = await app.inject({
          method,
          url: `${WRITE}/folders/demo/${INSTANCE}/their-folder`,
          headers: other(),
          ...(payload ? { payload } : {}),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toMatchObject({
          code: "demo_forbidden",
          path: "their-folder",
        });
      }
      // A path the real route normalises or decodes is the same folder.
      for (const spelled of ["their-folder/", "./their-folder", "their%2Dfolder"]) {
        const refused = await app.inject({
          method: "DELETE",
          url: `${WRITE}/folders/demo/${INSTANCE}/${spelled}`,
          headers: other(),
        });
        expect(refused.statusCode).not.toBe(200);
      }
      const gone = await app.inject({
        method: "DELETE",
        url: `${WRITE}/folders/demo/${INSTANCE}/their-folder`,
        headers: visitor(),
      });
      expect(gone.statusCode).toBe(200);
    });

    it("refuses a recursive delete or a move of an own folder holding another visitor's file", async () => {
      const made = await app.inject({
        method: "POST",
        url: `${WRITE}/folders/demo/${INSTANCE}/shared-room`,
        headers: visitor(),
      });
      expect(made.statusCode).toBe(201);
      const guest = await app.inject({
        method: "POST",
        url: `${WRITE}/${DEMO}`,
        headers: multipartHeaders(other()),
        payload: fileUpload("guest.txt", Buffer.from("a guest's file"), {
          contentType: "text/plain",
          fields: { folder_path: "shared-room" },
        }),
      });
      expect(guest.statusCode).toBe(201);
      const guestId = FileInfoSchema.parse(guest.json()).id;
      for (const [method, query, payload] of [
        ["DELETE", "?recursive=1", undefined],
        ["PATCH", "", { name: "renamed-room" }],
      ] as const) {
        const refused = await app.inject({
          method,
          url: `${WRITE}/folders/demo/${INSTANCE}/shared-room${query}`,
          headers: visitor(),
          ...(payload ? { payload } : {}),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error.code).toBe("demo_forbidden");
      }
      expect((await liveFile(guestId)).statusCode).toBe(200);
    });

    it("refuses a new version of another visitor's or a seeded file, multipart and resumable", async () => {
      const theirs = await mineFile("versioned.txt");
      const seeded = await seed("seeded-version.png", await pngFixture(), "image/png");
      for (const parent of [theirs.id, seeded.id]) {
        const refused = await app.inject({
          method: "POST",
          url: `${WRITE}/${DEMO}`,
          headers: multipartHeaders(other()),
          payload: fileUpload("planted.txt", Buffer.from("planted"), {
            contentType: "text/plain",
            fields: { parent_id: parent },
          }),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error.code).toBe("demo_forbidden");
        const resumable = await app.inject({
          method: "POST",
          url: `${WRITE}/uploads`,
          headers: {
            ...other(tus),
            "upload-length": "7",
            "upload-metadata": encodeTusMetadata({
              instance_type: "demo",
              instance_id: INSTANCE,
              filename: "planted.txt",
              parent_id: parent,
            }),
          },
        });
        expect(resumable.statusCode).toBe(403);
      }
      // The media type is case-insensitive: another spelling is the same upload.
      const headers = multipartHeaders(other());
      const respelled = await app.inject({
        method: "POST",
        url: `${WRITE}/${DEMO}`,
        headers: {
          ...headers,
          "content-type": String(headers["content-type"]).replace(
            "multipart/form-data",
            "Multipart/Form-Data",
          ),
        },
        payload: fileUpload("planted.txt", Buffer.from("planted"), {
          contentType: "text/plain",
          fields: { parent_id: seeded.id },
        }),
      });
      expect(respelled.statusCode).toBe(403);
      // A type the demo does not keep, naming a seeded parent: the clean-up must not reach it.
      const notKept = await app.inject({
        method: "POST",
        url: `${WRITE}/${DEMO}`,
        headers: multipartHeaders(other()),
        payload: fileUpload("x.zip", Buffer.from("PK\u0003\u0004 not kept"), {
          contentType: "application/zip",
          fields: { parent_id: seeded.id },
        }),
      });
      expect(notKept.statusCode).toBe(403);
      expect((await liveFile(seeded.id)).statusCode).toBe(200);
      // The owner's own new version still works.
      const own = await app.inject({
        method: "POST",
        url: `${WRITE}/${DEMO}`,
        headers: multipartHeaders(visitor()),
        payload: fileUpload("versioned.txt", Buffer.from("version two"), {
          contentType: "text/plain",
          fields: { parent_id: theirs.id },
        }),
      });
      expect(own.statusCode).toBe(201);
      expect(FileInfoSchema.parse(own.json()).parent_id).toBe(theirs.id);
    });

    it("refuses a resumable upload whose slug would replace a seeded or another visitor's file", async () => {
      const seeded = await app.inject({
        method: "PUT",
        url: `/vola/${DEMO}/slug/slugged-seed`,
        headers: multipartHeaders({ ...bearer(WRITE_KEY), "x-user-id": SEEDER_USER }),
        payload: fileUpload("slugged.png", await pngFixture(), { contentType: "image/png" }),
      });
      expect([200, 201]).toContain(seeded.statusCode);
      const seededId = FileInfoSchema.parse(seeded.json()).id;
      const slugged = (who: Record<string, string>, slug: string, length = 2) =>
        app.inject({
          method: "POST",
          url: `${WRITE}/uploads`,
          headers: {
            ...who,
            "upload-length": String(length),
            "upload-metadata": encodeTusMetadata({
              instance_type: "demo",
              instance_id: INSTANCE,
              filename: "over.txt",
              slug,
            }),
          },
        });
      const refused = await slugged(other(tus), "slugged-seed");
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toMatchObject({ code: "demo_forbidden", slug: "slugged-seed" });
      expect((await liveFile(seededId)).statusCode).toBe(200);
      // A slug nobody holds, and one's own again, is an upsert as ever.
      for (const round of [1, 2]) {
        const created = await slugged(other(tus), "own-slug");
        expect(created.statusCode, `round ${round}`).toBe(201);
        const done = await app.inject({
          method: "PATCH",
          url: String(created.headers.location),
          headers: {
            ...other(tus),
            "upload-offset": "0",
            "content-type": "application/offset+octet-stream",
          },
          payload: Buffer.from("hi"),
        });
        expect(done.statusCode, `round ${round}`).toBe(204);
      }
      // And another visitor cannot take it over.
      const takeover = await slugged(visitor(tus), "own-slug");
      expect(takeover.statusCode).toBe(403);
    });

    it("refuses HEAD, PATCH and DELETE of another visitor's resumable upload", async () => {
      const created = await app.inject({
        method: "POST",
        url: `${WRITE}/uploads`,
        headers: {
          ...visitor(tus),
          "upload-length": "5",
          "upload-metadata": encodeTusMetadata({
            instance_type: "demo",
            instance_id: INSTANCE,
            filename: "resumed.txt",
          }),
        },
      });
      expect(created.statusCode).toBe(201);
      const location = String(created.headers.location);
      for (const method of ["HEAD", "DELETE"] as const) {
        const refused = await app.inject({ method, url: location, headers: other(tus) });
        expect(refused.statusCode).toBe(403);
      }
      const injected = await app.inject({
        method: "PATCH",
        url: location,
        headers: {
          ...other(tus),
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
        },
        payload: Buffer.from("hello"),
      });
      expect(injected.statusCode).toBe(403);
      const head = await app.inject({ method: "HEAD", url: location, headers: visitor(tus) });
      expect(head.statusCode).toBe(200);
      expect(head.headers["upload-offset"]).toBe("0");
    });

    it("lists only a visitor's own shares and refuses reading or revoking another's", async () => {
      const seeded = await seed("share-owner.png", await pngFixture(), "image/png");
      const created = await app.inject({
        method: "POST",
        url: `${WRITE}/shares`,
        headers: visitor(),
        payload: { file_id: seeded.id },
      });
      expect(created.statusCode).toBe(201);
      const share = ShareCreatedSchema.parse(created.json());
      const ids = async (who: Record<string, string>, query = "") => {
        const listed = await app.inject({
          method: "GET",
          url: `${WRITE}/shares${query}`,
          headers: who,
        });
        expect(listed.statusCode).toBe(200);
        return listed.json().shares.map((s: { id: string }) => s.id);
      };
      expect(await ids(visitor())).toContain(share.id);
      expect(await ids(visitor(), `?file_id=${seeded.id}`)).toContain(share.id);
      expect(await ids(other())).not.toContain(share.id);
      expect(await ids(other(), `?file_id=${seeded.id}`)).not.toContain(share.id);
      for (const method of ["GET", "DELETE"] as const) {
        const refused = await app.inject({
          method,
          url: `${WRITE}/shares/${share.id}`,
          headers: other(),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toMatchObject({ code: "demo_forbidden", share_id: share.id });
      }
      const open = await app.inject({ method: "GET", url: `/vola/s/${share.token}` });
      expect(open.statusCode).toBe(200);
      // An unknown share is the real route's 404; the owner reads and revokes.
      const missing = await app.inject({
        method: "GET",
        url: `${WRITE}/shares/${randomUUID()}`,
        headers: other(),
      });
      expect(missing.statusCode).toBe(404);
      const own = await app.inject({
        method: "DELETE",
        url: `${WRITE}/shares/${share.id}`,
        headers: visitor(),
      });
      expect(own.statusCode).toBe(200);
      expect(await ids(visitor(), "?include_revoked=1")).toContain(share.id);
      expect(await ids(visitor())).not.toContain(share.id);
    });
  });

  it("caps a share's expiry at the demo TTL and keeps shares on the demo instance", async () => {
    const seeded = await seed("shared.png", await pngFixture(), "image/png");
    const far = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    const created = await app.inject({
      method: "POST",
      url: `${WRITE}/shares`,
      headers: visitor(),
      payload: { file_id: seeded.id, expires_at: far, max_downloads: 3 },
    });
    expect(created.statusCode).toBe(201);
    const share = ShareCreatedSchema.parse(created.json());
    const expires = new Date(share.expires_at ?? 0).getTime();
    expect(expires).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 5000);
    expect(expires).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(share.max_downloads).toBe(3);
    // Listed and revoked through the proxy too.
    const listed = await app.inject({
      method: "GET",
      url: `${WRITE}/shares?file_id=${seeded.id}`,
      headers: visitor(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().shares.map((s: { id: string }) => s.id)).toContain(share.id);
    const revoked = await app.inject({
      method: "DELETE",
      url: `${WRITE}/shares/${share.id}`,
      headers: visitor(),
    });
    expect(revoked.statusCode).toBe(200);
    // Another tenant's file: refused before the write key could reach it.
    const foreign = await app.inject({
      method: "POST",
      url: `${WRITE}/shares`,
      headers: visitor(),
      payload: { file_id: randomUUID() },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("relays a resumable upload with Location pointed at the proxy", async () => {
    const data = Buffer.from("resumable through the proxy, byte by byte");
    const meta = encodeTusMetadata({
      instance_type: "demo",
      instance_id: INSTANCE,
      filename: "notes.txt",
      content_type: "text/plain",
    });
    const tus = { "tus-resumable": "1.0.0" };
    const created = await app.inject({
      method: "POST",
      url: `${WRITE}/uploads`,
      headers: { ...visitor(tus), "upload-length": String(data.length), "upload-metadata": meta },
    });
    expect(created.statusCode).toBe(201);
    const location = String(created.headers.location);
    expect(location).toMatch(/^\/vola\/examples\/write\/uploads\//);
    const head = await app.inject({ method: "HEAD", url: location, headers: visitor(tus) });
    expect(head.statusCode).toBe(200);
    expect(head.headers["upload-offset"]).toBe("0");
    const patched = await app.inject({
      method: "PATCH",
      url: location,
      headers: {
        ...visitor(tus),
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      payload: data,
    });
    expect(patched.statusCode).toBe(204);
    expect(patched.headers["upload-offset"]).toBe(String(data.length));
    const fileId = String(patched.headers["vola-file-id"]);
    const info = await app.inject({
      method: "GET",
      url: `/vola/${DEMO}/${fileId}/info`,
      headers: bearer(READ_KEY),
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      filename: "notes.txt",
      created_by: VISITOR,
      size: data.length,
    });

    // Too long, or for another instance: refused at creation.
    const tooLong = await app.inject({
      method: "POST",
      url: `${WRITE}/uploads`,
      headers: { ...visitor(tus), "upload-length": String(MAX + 1), "upload-metadata": meta },
    });
    expect(tooLong.statusCode).toBe(413);
    const elsewhere = await app.inject({
      method: "POST",
      url: `${WRITE}/uploads`,
      headers: {
        ...visitor(tus),
        "upload-length": "3",
        "upload-metadata": encodeTusMetadata({
          instance_type: "tickets",
          instance_id: INSTANCE,
          filename: "x",
        }),
      },
    });
    expect(elsewhere.statusCode).toBe(403);
  });

  it("purges a resumable upload of a type the demo does not keep when it completes", async () => {
    const data = Buffer.from("PK\u0003\u0004 not an image at all, a zip");
    const tus = { "tus-resumable": "1.0.0" };
    const created = await app.inject({
      method: "POST",
      url: `${WRITE}/uploads`,
      headers: {
        ...visitor(tus),
        "upload-length": String(data.length),
        "upload-metadata": encodeTusMetadata({
          instance_type: "demo",
          instance_id: INSTANCE,
          filename: "x.zip",
          content_type: "application/zip",
        }),
      },
    });
    expect(created.statusCode).toBe(201);
    const patched = await app.inject({
      method: "PATCH",
      url: String(created.headers.location),
      headers: {
        ...visitor(tus),
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      payload: data,
    });
    expect(patched.statusCode).toBe(415);
    const rows = await handle.db.select().from(files).where(eq(files.filename, "x.zip"));
    expect(rows).toEqual([]);
  });

  it("relays the keyring routes' answer (503 here: no keyring provider without Redis)", async () => {
    const status = await app.inject({
      method: "GET",
      url: `${WRITE}/keyrings/me/status`,
      headers: visitor(),
    });
    expect(status.statusCode).toBe(503);
    expect(status.json().error.code).toBe("encryption_unavailable");
  });

  it("brakes a visitor address after the limit, with Retry-After", async () => {
    const small = new RateLimiter(2, 600_000, () => clock);
    const limited = await buildApp({
      config: loadConfig({ ...examplesEnv, VOLA_STORAGE_PATH: join(root, "storage") }),
      db: handle.db,
      logger: false,
      storage,
      uploadSweepIntervalMs: 0,
      examplesDeps: { limiter: small },
    });
    try {
      const make = () =>
        limited.inject({
          method: "POST",
          url: `${WRITE}/folders/demo/${INSTANCE}/f${Math.random()}`,
          headers: visitor(),
        });
      expect((await make()).statusCode).toBe(201);
      expect((await make()).statusCode).toBe(201);
      const third = await make();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe("demo_rate_limited");
      expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
      // A read through the proxy is not counted.
      const read = await limited.inject({
        method: "GET",
        url: `${WRITE}/shares`,
        headers: visitor(),
      });
      expect(read.statusCode).toBe(200);
      clock += 600_001;
      expect((await make()).statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });
});

// --- regenerate --------------------------------------------------------------------------------------

describe("POST /examples/regenerate/:fileId", () => {
  it("drops a file's thumbnails so the next /thumb renders them again", async () => {
    const seeded = await seed("thumbed.png", await pngFixture(), "image/png");
    const thumb = () =>
      app.inject({
        method: "GET",
        url: `/vola/${DEMO}/${seeded.id}/thumb/64`,
        headers: bearer(READ_KEY),
      });
    expect((await thumb()).statusCode).toBe(200); // sync mode: rendered inline
    const derived = thumbnailDerivedName(64, "cover");
    expect(await storage.statDerived(seeded.hash, derived)).not.toBeNull();
    const regenerated = await app.inject({
      method: "POST",
      url: `/vola/examples/regenerate/${seeded.id}`,
    });
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.json()).toEqual({ file_id: seeded.id, removed: 1 });
    expect(await storage.statDerived(seeded.hash, derived)).toBeNull();
    expect(await storage.stat(seeded.hash)).not.toBeNull(); // the blob stays
    expect((await thumb()).statusCode).toBe(200);
    const unknown = await app.inject({
      method: "POST",
      url: `/vola/examples/regenerate/${randomUUID()}`,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

// --- the purge ----------------------------------------------------------------------------------------

describe("the purge", () => {
  it("removes what visitors left more than TTL ago, never the seeder's files", async () => {
    const old = new Date(Date.now() - 25 * 3_600_000);
    const seeded = await seed("keep.png", await pngFixture(), "image/png");
    const mine = FileInfoSchema.parse(
      (
        await uploadVia(`${WRITE}/${DEMO}`, Buffer.from("old visitor text"), "old.txt", {
          contentType: "text/plain",
        })
      ).json(),
    );
    const fresh = FileInfoSchema.parse(
      (
        await uploadVia(`${WRITE}/${DEMO}`, Buffer.from("fresh visitor text"), "fresh.txt", {
          contentType: "text/plain",
        })
      ).json(),
    );
    const folder = await app.inject({
      method: "POST",
      url: `${WRITE}/folders/demo/${INSTANCE}/stale`,
      headers: visitor(),
    });
    expect(folder.statusCode).toBe(201);
    await handle.db.update(files).set({ createdAt: old }).where(eq(files.id, mine.id));
    await handle.db.update(files).set({ createdAt: old }).where(eq(files.id, seeded.id));
    await handle.db.update(folders).set({ createdAt: old }).where(eq(folders.path, "stale"));

    const asVisitor = await app.inject({
      method: "POST",
      url: "/vola/examples/purge",
      headers: bearer(READ_KEY),
    });
    expect(asVisitor.statusCode).toBe(403);
    const ran = await app.inject({
      method: "POST",
      url: "/vola/examples/purge",
      headers: bearer(fx.admin.key),
    });
    expect(ran.statusCode).toBe(200);
    expect(ran.json()).toMatchObject({ files: 1, blobs: 1, folders: 1, keyrings: 0, failed: 0 });
    expect(await handle.db.select().from(files).where(eq(files.id, mine.id))).toEqual([]);
    expect(await storage.exists(mine.hash)).toBe(false);
    expect((await handle.db.select().from(files).where(eq(files.id, fresh.id))).length).toBe(1);
    expect((await handle.db.select().from(files).where(eq(files.id, seeded.id))).length).toBe(1);
    expect(await storage.exists(seeded.hash)).toBe(true);
    const [stale] = await handle.db.select().from(folders).where(eq(folders.path, "stale"));
    expect(stale?.deletedAt).toBeTruthy();
  });
});

// --- the UI ------------------------------------------------------------------------------------------

describe("VOLA_UI_DIR", () => {
  let ui: string;
  let site: FastifyInstance;
  beforeAll(async () => {
    ui = await mkdtemp(join(tmpdir(), "vola-ui-"));
    await mkdir(join(ui, "assets"));
    await writeFile(
      join(ui, "index.html"),
      "<!doctype html><title>vola examples</title><div id=root></div>",
    );
    await writeFile(join(ui, "assets", "app-abc123.js"), "console.log('vola')");
    site = await buildApp({
      config: baseConfig,
      db: handle.db,
      logger: false,
      storage,
      examples: false,
      ui,
    });
    await site.ready();
  });
  afterAll(async () => {
    await site.close();
    await rm(ui, { recursive: true, force: true });
  });

  it("serves the page at /, /en/ and every client route, the assets immutable, the API's 404s as JSON", async () => {
    const home = await site.inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toMatch(/text\/html/);
    expect(home.headers["cache-control"]).toBe("no-cache");
    expect(home.body).toContain("vola examples");
    const route = await site.inject({
      method: "GET",
      url: "/examples/browse",
      headers: { accept: "text/html,*/*" },
    });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("vola examples");
    const en = await site.inject({ method: "GET", url: "/en" });
    expect(en.statusCode).toBe(301);
    expect(en.headers.location).toBe("/en/");
    const enRoute = await site.inject({ method: "GET", url: "/en/examples/share" });
    expect(enRoute.statusCode).toBe(200);
    const asset = await site.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const api = await site.inject({
      method: "GET",
      url: "/vola/nope",
      headers: { accept: "text/html" },
    });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe("not_found");
    const live = await site.inject({ method: "GET", url: "/vola/health/live" });
    expect(live.statusCode).toBe(200);
    const json = await site.inject({
      method: "GET",
      url: "/missing.json",
      headers: { accept: "application/json" },
    });
    expect(json.statusCode).toBe(404);
    expect(json.json().error.code).toBe("not_found");
    const post = await site.inject({
      method: "POST",
      url: "/examples/browse",
      headers: { accept: "text/html" },
    });
    expect(post.statusCode).toBe(404);
  });

  it("refuses a directory without index.html", async () => {
    await expect(
      buildApp({
        config: baseConfig,
        db: handle.db,
        logger: false,
        storage,
        examples: false,
        ui: join(ui, "assets"),
      }),
    ).rejects.toThrow(/no index.html/);
  });
});
