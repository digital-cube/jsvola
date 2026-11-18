import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeTusMetadata, FileInfoSchema } from "@vol-a/core";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "../src/db/schema.js";
import { volaPlugin } from "../src/plugin.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { bearer, config, type Fixture, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

/**
 * What vola already guarantees about content addressing (1.2, part 4 of TCKXRCP96M) — locked
 * by tests, no code changed: a reader reaches a ROW, never a blob; an upload says nothing
 * about whether its bytes were there before; removing one row leaves its siblings readable.
 */
const handle = testDatabase(4);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let http: ReturnType<typeof httpClient>;
/** Every route of the plugin as Fastify registered it. */
let routes: Array<{ method: string; url: string }>;
/** The plugin alone, with an `onRoute` hook installed before it. */
let inventory: FastifyInstance;

const T = "tickets";

/** Every blob file on disk (a 64-hex name under `blobs/`). */
async function blobsOnDisk(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/^[a-f0-9]{64}$/.test(entry.name)) found.push(entry.name);
    }
  };
  await walk(join(root, "storage", "blobs"));
  return found;
}

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-content-"));
  storage = new FilesystemBackend(join(root, "storage"));
  const cfg = { ...config, storagePath: join(root, "storage") };
  fx = await setupFixture(handle, {
    storage,
    events: false,
    config: cfg,
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, T);

  routes = [];
  inventory = Fastify({ logger: false });
  inventory.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, url: route.url });
  });
  await inventory.register(volaPlugin, {
    config: cfg,
    db: handle.db,
    storage,
    events: false,
    uploadSweepIntervalMs: 0,
    prefix: "/vola",
  });
  await inventory.ready();
});

afterAll(async () => {
  await app.close();
  await inventory.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

async function upload(data: Buffer, instanceId = randomUUID()) {
  const { response } = await http.upload(data, "same.bin", { instanceId });
  expect(response.statusCode, response.body).toBe(201);
  return { response, info: FileInfoSchema.parse(response.json()) };
}

describe("no route serves content by hash or by storage path", () => {
  it("has no route with a path segment or parameter that names a hash or a blob", () => {
    expect(routes.length).toBeGreaterThan(30);
    for (const { method, url } of routes) {
      // jsudc's preview route of FILESYSTEM collections (`?collection=&path=`): vola registers
      // none, so it reaches nothing — locked by the next test.
      if (url === "/vola/udc/files/blob") continue;
      for (const segment of url.split("/")) {
        const name = segment.replace(/^:/, "");
        expect(name, `${method} ${url}`).not.toMatch(
          /^(hash|sha\d*|blobs?|digest|derived|content)$/i,
        );
      }
    }
  });

  it("answers no GET with a stored file's bytes when every parameter is its hash or storage path", async () => {
    const data = Buffer.from(`probe ${randomBytes(16).toString("hex")}`);
    const { info } = await upload(data);
    const { hash } = info;
    const storagePath = `blobs/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4, 6)}/${hash}`;
    const reads = routes.filter((r) => r.method === "GET" || r.method === "HEAD");
    expect(reads.length).toBeGreaterThan(10);
    let probes = 0;
    for (const { method, url } of reads) {
      for (const value of [hash, storagePath, encodeURIComponent(storagePath)]) {
        const concrete = url
          .replace(/:type\b/g, T)
          .replace(/:id\b/g, info.instance_id)
          .replace(/:[A-Za-z_]+/g, value)
          .replace(/\*$/, value);
        for (const key of [fx.full.key, fx.admin.key]) {
          const response: LightMyRequestResponse = await inventory.inject({
            method: method as "GET",
            url: `${concrete}?hash=${hash}&path=${encodeURIComponent(storagePath)}`,
            headers: { ...bearer(key), "x-tenant-slug": fx.tenant.slug },
          });
          probes++;
          expect(response.rawPayload.includes(data), `${method} ${concrete}`).toBe(false);
        }
      }
    }
    expect(probes).toBeGreaterThan(60);
    // jsudc's filesystem preview route, asked for the blob of every collection vola has.
    for (const collection of ["files", "folders", "menu", "vola_file", "storage"]) {
      const preview = await inventory.inject({
        method: "GET",
        url: `/vola/udc/files/blob?collection=${collection}&path=${encodeURIComponent(storagePath)}`,
        headers: bearer(fx.full.key),
      });
      expect(preview.statusCode, collection).toBe(404);
    }
    // The row itself still reads, by its id.
    const byId = await http.get(`/vola/files/${T}/${info.instance_id}/${info.id}`);
    expect(byId.rawPayload.equals(data)).toBe(true);
  });
});

describe("uploading content that is already stored answers like new content", () => {
  /** The answer minus what is unique to a row: ids, instance, timestamps; header VALUES that carry them. */
  const shape = (response: LightMyRequestResponse) => {
    const body = response.json();
    const { id, instance_id, created_at, updated_at, ...rest } = body;
    for (const value of [id, instance_id, created_at, updated_at]) expect(value).toBeTruthy();
    const headers = Object.keys(response.headers)
      .filter((name) => !["date", "x-request-id", "content-length"].includes(name))
      .sort();
    return { status: response.statusCode, keys: Object.keys(body).sort(), rest, headers };
  };

  it("POST /files", async () => {
    const data = randomBytes(2048);
    const first = await upload(data);
    const second = await upload(data);
    expect(second.info.hash).toBe(first.info.hash);
    expect(second.info.id).not.toBe(first.info.id);
    expect(shape(second.response)).toEqual(shape(first.response));
    expect(second.response.headers["content-length"]).toBe(
      first.response.headers["content-length"],
    );
  });

  it("tus (POST /uploads + PATCH)", async () => {
    const tus = async (data: Buffer) => {
      const created = await app.inject({
        method: "POST",
        url: "/vola/uploads",
        headers: {
          ...bearer(fx.full.key),
          "tus-resumable": "1.0.0",
          "upload-length": String(data.length),
          "upload-metadata": encodeTusMetadata({
            instance_type: T,
            instance_id: randomUUID(),
            filename: "same.bin",
            filetype: "application/octet-stream",
          }),
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const location = created.headers.location as string;
      const patched = await app.inject({
        method: "PATCH",
        url: location.replace(/^https?:\/\/[^/]+/, ""),
        headers: {
          ...bearer(fx.full.key),
          "tus-resumable": "1.0.0",
          "content-type": "application/offset+octet-stream",
          "upload-offset": "0",
        },
        payload: data,
      });
      expect(patched.statusCode, patched.body).toBe(204);
      return { created, patched };
    };
    const data = randomBytes(4096);
    const first = await tus(data);
    const second = await tus(data);
    const names = (r: LightMyRequestResponse) =>
      Object.keys(r.headers)
        .filter((n) => !["date", "x-request-id"].includes(n))
        .sort();
    for (const step of ["created", "patched"] as const) {
      expect(second[step].statusCode).toBe(first[step].statusCode);
      expect(names(second[step])).toEqual(names(first[step]));
      expect(second[step].rawPayload.length).toBe(first[step].rawPayload.length);
    }
    expect(second.patched.headers["upload-offset"]).toBe(first.patched.headers["upload-offset"]);
    const ids = [first, second].map((r) => r.patched.headers["vola-file-id"] as string);
    expect(new Set(ids).size).toBe(2);
    const rows = await handle.db
      .select({ hash: files.hash })
      .from(files)
      .where(eq(files.id, ids[0] as string));
    const [twin] = await handle.db
      .select({ hash: files.hash })
      .from(files)
      .where(eq(files.id, ids[1] as string));
    expect(twin?.hash).toBe(rows[0]?.hash);
  });
});

describe("removing one row of a shared blob", () => {
  it("leaves the other rows readable; purging the last row removes the blob", async () => {
    const data = randomBytes(3000);
    const a = (await upload(data)).info;
    const b = (await upload(data)).info;
    const c = (await upload(data)).info;
    const url = (f: typeof a) => `/vola/files/${T}/${f.instance_id}/${f.id}`;
    const readable = async (f: typeof a) => {
      const response = await http.get(url(f));
      return response.statusCode === 200 && response.rawPayload.equals(data);
    };
    expect((await blobsOnDisk()).filter((h) => h === a.hash)).toHaveLength(1);

    expect((await http.del(url(a))).statusCode).toBe(200);
    expect(await readable(b)).toBe(true);
    expect(await readable(c)).toBe(true);

    expect((await http.del(`${url(a)}/purge`)).statusCode).toBe(200);
    expect(await readable(b)).toBe(true);
    expect(await storage.stat(a.hash)).not.toBeNull();

    const purgedB = await http.del(`${url(b)}/purge`);
    expect(purgedB.json()).toMatchObject({ blobs: 0 });
    expect(await readable(c)).toBe(true);

    const purgedC = await http.del(`${url(c)}/purge`);
    expect(purgedC.json()).toMatchObject({ blobs: 1 });
    expect(await storage.stat(a.hash)).toBeNull();
    expect((await blobsOnDisk()).filter((h) => h === a.hash)).toHaveLength(0);
  });
});
