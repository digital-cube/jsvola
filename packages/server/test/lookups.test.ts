import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceTypesResponseSchema, LOOKUP_SECTIONS, LookupsResponseSchema } from "@vola/core";
import { CANDIDATES_CSV } from "@vola/lookups";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  DEFAULT_LOOKUPS_PATH,
  emptyLookups,
  initLookups,
  lookupsResponse,
  parseLocale,
  unknownFileLookups,
} from "../src/lookups.js";
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
import { httpClient } from "./http.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let http: ReturnType<typeof httpClient>;
let other: { key: string };

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  randomBytes(32),
]);

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-lookups-"));
  fx = await setupFixture(handle, { storage: new FilesystemBackend(root) });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other", "live", ["files:read", "files:write"]);
  other = { key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

const SECTIONS = Object.values(LOOKUP_SECTIONS);

describe("GET /vola/lookups", () => {
  it("serves the whole vocabulary in English without an API key", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/lookups" });
    expect(response.statusCode).toBe(200);
    const body = LookupsResponseSchema.parse(response.json());
    expect(body.locale).toBe("en");
    expect(body.locales).toEqual(["en", "sr"]);
    expect(Object.keys(body.lookups)).toEqual(SECTIONS);
    expect(body.lookups).not.toHaveProperty("InstanceTypes");
    expect(body.lookups.FileKinds?.[0]).toEqual({ term: "IMAGE", value: "image", label: "Image" });
    expect(body.lookups.EncryptionModes?.map((e) => e.value)).toEqual([
      "none",
      "tenant",
      "keyring",
      "caller",
    ]);
    expect(body.lookups.ProcessingKinds?.map((e) => e.term)).toEqual(["THUMBNAIL", "OCR"]);
    expect(body.lookups.OcrLanguages?.map((e) => e.label)).toEqual([
      "English",
      "Serbian",
      "German",
    ]);
  });

  it("labels in Serbian with ?locale=sr (case-insensitive) and falls back to en otherwise", async () => {
    const sr = LookupsResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/vola/lookups?locale=sr" })).json(),
    );
    expect(sr.locale).toBe("sr");
    expect(sr.lookups.FileKinds?.[0]?.label).toBe("Slika");
    expect(sr.lookups.ProcessingStatuses?.find((e) => e.term === "PENDING")?.label).toBe(
      "Na čekanju",
    );
    const upper = (await app.inject({ method: "GET", url: "/vola/lookups?locale=SR" })).json();
    expect(upper.locale).toBe("sr");
    for (const locale of ["de", "", "xx-YY"]) {
      const body = (
        await app.inject({ method: "GET", url: `/vola/lookups?locale=${locale}` })
      ).json();
      expect(body.locale, locale).toBe("en");
      expect(body.lookups.FileKinds[0].label).toBe("Image");
    }
  });

  it("answers empty sections when the server has no lookups.yaml", async () => {
    const bare = await buildApp({
      config: { ...config, lookups: { ...config.lookups, path: join(root, "missing.yaml") } },
      db: handle.db,
      logger: false,
      udc: false,
    });
    const response = await bare.inject({ method: "GET", url: "/vola/lookups?locale=sr" });
    expect(response.json()).toEqual({ locale: "sr", locales: [], lookups: {} });
    await bare.close();
  });

  it("falls back to the English label of a term the locale does not translate", () => {
    const lookups = emptyLookups();
    expect(lookupsResponse(lookups, "sr")).toEqual({ locale: "sr", locales: [], lookups: {} });
    expect(parseLocale(undefined)).toBe("en");
    expect(parseLocale(["sr", "en"])).toBe("sr");
    expect(parseLocale(42)).toBe("en");
  });
});

describe("GET /vola/instance-types", () => {
  it("needs files:read and lists the tenant's types with live-file counts", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/vola/instance-types" });
    expect(anonymous.statusCode).toBe(401);
    const noScope = await mintKey(handle, fx.tenant.id, "folders", "live", ["folders:read"]);
    const refused = await http.get("/vola/instance-types", {}, noScope.key);
    expect(refused.statusCode).toBe(403);

    const empty = await http.get("/vola/instance-types", {}, fx.readOnly.key);
    expect(InstanceTypesResponseSchema.parse(empty.json())).toEqual({ instance_types: [] });

    const ticket = randomUUID();
    const a = await http.upload(PNG, "a.png", { instanceId: ticket });
    await http.upload(Buffer.from("hello"), "b.txt", { instanceId: ticket });
    await http.upload(Buffer.from("hello"), "c.txt", { instanceId: randomUUID() });
    await http.upload(Buffer.from("avatar"), "me.txt", { type: "users" });
    const deleted = await http.upload(Buffer.from("gone"), "gone.txt", { instanceId: ticket });
    expect(a.response.statusCode).toBe(201);
    await http.del(`/vola/files/tickets/${ticket}/${deleted.response.json().id}`);
    // Another tenant's files never count.
    await http.upload(Buffer.from("x"), "x.txt", { key: other.key, type: "tickets" });
    await http.upload(Buffer.from("x"), "y.txt", { key: other.key, type: "invoices" });

    const listed = await http.get("/vola/instance-types", {}, fx.readOnly.key);
    expect(listed.statusCode).toBe(200);
    expect(InstanceTypesResponseSchema.parse(listed.json())).toEqual({
      instance_types: [
        { instance_type: "tickets", files: 3 },
        { instance_type: "users", files: 1 },
      ],
    });
    const theirs = await http.get("/vola/instance-types", {}, other.key);
    expect(theirs.json().instance_types).toEqual([
      { instance_type: "invoices", files: 1 },
      { instance_type: "tickets", files: 1 },
    ]);
  });

  it("works for an admin key with X-Tenant-Slug and refuses one without", async () => {
    const admin = await http.get(
      "/vola/instance-types",
      { "x-tenant-slug": fx.tenant.slug },
      fx.admin.key,
    );
    expect(admin.statusCode).toBe(200);
    expect(
      admin.json().instance_types.map((t: { instance_type: string }) => t.instance_type),
    ).toEqual(["tickets", "users"]);
    const noTenant = await http.get("/vola/instance-types", {}, fx.admin.key);
    expect(noTenant.statusCode).toBe(400);
    expect(noTenant.json().error.code).toBe("tenant_required");
  });
});

describe("candidate recording", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vola-candidates-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("records a kind the vocabulary does not know, once per term, best effort", async () => {
    await writeFile(join(dir, "lookups.yaml"), "FileKinds: [OTHER]\nEncryptionModes: [NONE]\n");
    const lookups = await initLookups({
      path: join(dir, "lookups.yaml"),
      candidatesDir: join(dir, "candidates"),
    });
    expect(lookups.locales).toEqual([]);
    expect(unknownFileLookups(lookups, { kind: "image", encryption: "none" })).toEqual({
      FileKinds: "image",
    });
    expect(unknownFileLookups(lookups, { kind: "other", encryption: "none" })).toEqual({});

    const recording = await buildApp({
      config,
      db: handle.db,
      logger: false,
      lookups,
      storage: new FilesystemBackend(root),
      udc: false,
    });
    const client = httpClient(recording, fx.full.key);
    expect((await client.upload(PNG, "one.png")).response.statusCode).toBe(201);
    expect((await client.upload(PNG, "two.png")).response.statusCode).toBe(201);
    expect((await client.upload(Buffer.from("plain"), "note.txt")).response.statusCode).toBe(201);
    await recording.close();

    const recorder = lookups.recorder as NonNullable<typeof lookups.recorder>;
    expect(await recorder.list("FileKinds")).toMatchObject([
      { value: "IMAGE", count: 2 },
      { value: "TEXT", count: 1 },
    ]);
    expect(await recorder.list("EncryptionModes")).toEqual([]);
    const csv = await readFile(join(dir, "candidates", CANDIDATES_CSV), "utf8");
    expect(csv).toBe("section,term,en,sr\nFileKinds,IMAGE,IMAGE,IMAGE\nFileKinds,TEXT,TEXT,TEXT\n");
  });

  it("loads the repository vocabulary with its translations", async () => {
    const lookups = await initLookups({ path: DEFAULT_LOOKUPS_PATH, candidatesDir: null });
    expect(lookups.recorder).toBeNull();
    expect(lookups.warnings).toEqual([]);
    expect(lookups.locales).toEqual(["en", "sr"]);
    expect(lookups.registry.sectionNames()).toEqual(SECTIONS);
    expect(lookups.registry.has("FileKinds", "image")).toBe(true);
    expect(lookups.registry.label("EncryptionModes", "keyring", ["sr"])).toBe("Privezak (PIN)");
  });
});

describe("plugin auth around the new routes", () => {
  it("keeps /lookups open and the rest behind a key", async () => {
    const open = await app.inject({ method: "GET", url: "/vola/lookups", headers: bearer("nope") });
    expect(open.statusCode).toBe(200);
  });
});
