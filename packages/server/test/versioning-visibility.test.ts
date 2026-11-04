import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInfoSchema, FileVersionsSchema, PurgeResultSchema } from "@vol-a/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "../src/db/schema.js";
import { LastUsedThrottle } from "../src/services/apikeys.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let http: ReturnType<typeof httpClient>;
let other: { tenantId: string; key: string };

const TYPE = "tickets";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const U = (instanceId: string, fileId: string, suffix = "") =>
  `/vola/files/${TYPE}/${instanceId}/${fileId}${suffix}`;

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-versions-"));
  storage = new FilesystemBackend(root);
  fx = await setupFixture(handle, { storage, accessThrottle: new LastUsedThrottle(0) });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other-full", "live", [
    "files:read",
    "files:write",
    "folders:read",
    "folders:write",
  ]);
  other = { tenantId: tenant.id, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("versions", () => {
  it("chains uploads with parent_id, inheriting filename and folder, and lists them newest first", async () => {
    const instanceId = randomUUID();
    const v1 = await http.upload(Buffer.from("v1"), "x.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });
    const v1Info = FileInfoSchema.parse(v1.response.json());
    expect(v1Info.parent_id).toBeNull();

    // The browser sends the same name: no `(1)` rename against the previous version.
    const v2 = await http.upload(Buffer.from("v2"), "x.txt", {
      instanceId,
      fields: { parent_id: v1Info.id },
    });
    expect(v2.response.statusCode, v2.response.body).toBe(201);
    const v2Info = FileInfoSchema.parse(v2.response.json());
    expect(v2Info).toMatchObject({
      parent_id: v1Info.id,
      filename: "x.txt",
      folder_id: v1Info.folder_id,
    });

    // No name at all: inherited too. A different name or folder: taken as given.
    const v3 = await http.upload(Buffer.from("v3"), "", {
      instanceId,
      fields: { parent_id: v2Info.id },
    });
    const v3Info = FileInfoSchema.parse(v3.response.json());
    expect(v3Info).toMatchObject({
      parent_id: v2Info.id,
      filename: "x.txt",
      folder_id: v1Info.folder_id,
    });
    const v4 = await http.upload(Buffer.from("v4"), "renamed.txt", {
      instanceId,
      fields: { parent_id: v3Info.id, folder_path: "" },
    });
    const v4Info = FileInfoSchema.parse(v4.response.json());
    expect(v4Info).toMatchObject({
      parent_id: v3Info.id,
      filename: "renamed.txt",
      folder_id: null,
    });

    // Every version stays live; the path answers the newest one with that name.
    for (const info of [v1Info, v2Info, v3Info]) {
      expect((await http.get(U(instanceId, info.id))).statusCode).toBe(200);
    }
    const byPath = await http.get(`/vola/files/${TYPE}/${instanceId}/path/docs/x.txt`);
    expect(byPath.body).toBe("v3");

    const chain = await http.get(U(instanceId, v2Info.id, "/versions"));
    expect(chain.statusCode).toBe(200);
    const versions = FileVersionsSchema.parse(chain.json()).versions;
    expect(versions.map((v) => v.id)).toEqual([v4Info.id, v3Info.id, v2Info.id, v1Info.id]);
    const fromRoot = await http.get(U(instanceId, v1Info.id, "/versions"));
    expect(fromRoot.json().versions.map((v: { id: string }) => v.id)).toEqual(
      versions.map((v) => v.id),
    );
    // A soft-deleted version drops out of the chain unless asked for.
    await http.del(U(instanceId, v2Info.id));
    expect((await http.get(U(instanceId, v3Info.id, "/versions"))).json().versions).toHaveLength(3);
    expect(
      (await http.get(U(instanceId, v3Info.id, "/versions?include_deleted=1"))).json().versions,
    ).toHaveLength(4);
    expect((await http.get(U(instanceId, v2Info.id, "/versions"))).statusCode).toBe(200);
    // A file without versions is a chain of one.
    const lone = await http.upload(Buffer.from("l"), "lone.txt", { instanceId });
    expect(
      (await http.get(U(instanceId, lone.response.json().id, "/versions"))).json().versions,
    ).toHaveLength(1);
    expect((await http.get(U(instanceId, randomUUID(), "/versions"))).statusCode).toBe(404);
    expect((await http.get(U(instanceId, v1Info.id, "/versions"), {}, other.key)).statusCode).toBe(
      404,
    );
  });

  it("refuses a parent of another instance, tenant, or a soft-deleted one", async () => {
    const instanceId = randomUUID();
    const base = await http.upload(Buffer.from("b"), "b.txt", { instanceId });
    const id = base.response.json().id as string;
    const elsewhere = await http.upload(Buffer.from("e"), "e.txt", { fields: { parent_id: id } });
    expect(elsewhere.response.statusCode).toBe(404);
    const theirs = await http.upload(Buffer.from("t"), "t.txt", {
      instanceId,
      fields: { parent_id: id },
      key: other.key,
    });
    expect(theirs.response.statusCode).toBe(404);
    await http.del(U(instanceId, id));
    const dead = await http.upload(Buffer.from("d"), "d.txt", {
      instanceId,
      fields: { parent_id: id },
    });
    expect(dead.response.statusCode).toBe(404);
    expect(
      (await http.upload(Buffer.from("n"), "n.txt", { instanceId, fields: { parent_id: "nope" } }))
        .response.statusCode,
    ).toBe(404);
  });

  it("purges the whole chain from any member, removing the blobs nothing else references", async () => {
    const instanceId = randomUUID();
    const d1 = randomBytes(100);
    const d2 = randomBytes(100);
    const v1 = await http.upload(d1, "p.bin", { instanceId });
    const v2 = await http.upload(d2, "p.bin", {
      instanceId,
      fields: { parent_id: v1.response.json().id },
    });
    const v3 = await http.upload(d2, "p.bin", {
      instanceId,
      fields: { parent_id: v2.response.json().id },
    });
    // Another tenant holds the first blob, so it survives.
    await http.upload(d1, "keep.bin", { key: other.key });
    const purged = await http.del(U(instanceId, v2.response.json().id, "/purge"));
    expect(purged.statusCode).toBe(200);
    expect(PurgeResultSchema.parse(purged.json())).toEqual({ files: 3, blobs: 1 });
    for (const r of [v1, v2, v3]) {
      expect(
        (await http.get(U(instanceId, r.response.json().id, "/info?include_deleted=1"))).statusCode,
      ).toBe(404);
    }
    expect(await storage.exists(sha256(d1))).toBe(true);
    expect(await storage.exists(sha256(d2))).toBe(false);
  });
});

describe("is_public between tenants", () => {
  it("lets any authenticated tenant read a public file by id, and nothing else", async () => {
    const instanceId = randomUUID();
    const { response: up } = await http.upload(Buffer.from("shared"), "shared.txt", {
      instanceId,
      fields: { folder_path: "pub" },
    });
    const id = up.json().id as string;
    expect(up.json()).toMatchObject({ is_public: false, is_global_public: false });
    const o = other.key;
    expect((await http.get(U(instanceId, id), {}, o)).statusCode).toBe(404);
    expect((await http.get(U(instanceId, id, "/info"), {}, o)).statusCode).toBe(404);

    const patched = await http.patch(U(instanceId, id), { is_public: true });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ is_public: true, is_global_public: false });

    const read = await http.get(U(instanceId, id), { "x-user-id": "guest" }, o);
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe("shared");
    expect(read.headers["cache-control"]).toBe("private, no-cache");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await handle.db.select().from(files).where(eq(files.id, id));
    expect(row?.lastAccessedBy).toBe("guest");
    expect((await http.head(U(instanceId, id), {}, o)).statusCode).toBe(200);
    expect((await http.get(U(instanceId, id), { range: "bytes=0-2" }, o)).statusCode).toBe(206);
    expect((await http.get(U(instanceId, id, "/info"), {}, o)).json().tenant_id).toBe(fx.tenant.id);

    // Reading is all: the other tenant cannot change, delete, version, list or path-resolve it.
    expect((await http.patch(U(instanceId, id), { is_public: false }, {}, o)).statusCode).toBe(404);
    expect((await http.del(U(instanceId, id), {}, o)).statusCode).toBe(404);
    expect((await http.del(U(instanceId, id, "/purge"), {}, o)).statusCode).toBe(404);
    expect((await http.get(U(instanceId, id, "/versions"), {}, o)).statusCode).toBe(404);
    expect((await http.get(U(instanceId, id, "/info?include_deleted=1"), {}, o)).statusCode).toBe(
      404,
    );
    expect((await http.get(`/vola/files/${TYPE}/${instanceId}`, {}, o)).json().files).toEqual([]);
    expect(
      (await http.get(`/vola/files/${TYPE}/${instanceId}/path/pub/shared.txt`, {}, o)).statusCode,
    ).toBe(404);
    // The wrong instance, a soft-deleted file, or is_public switched off: 404 again.
    expect((await http.get(U(randomUUID(), id), {}, o)).statusCode).toBe(404);
    await http.patch(U(instanceId, id), { is_public: false });
    expect((await http.get(U(instanceId, id), {}, o)).statusCode).toBe(404);
    await http.patch(U(instanceId, id), { is_public: true });
    await http.del(U(instanceId, id));
    expect((await http.get(U(instanceId, id), {}, o)).statusCode).toBe(404);
    // A slug is tenant-local even when public.
    const slug = await app.inject({
      method: "PUT",
      url: `/vola/files/${TYPE}/${instanceId}/slug/avatar`,
      headers: {
        ...(await import("./helpers.js")).bearer(fx.full.key),
        "content-type": "multipart/form-data; boundary=x",
      },
      payload: `--x\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\npng\r\n--x--\r\n`,
    });
    expect(slug.statusCode).toBe(201);
    await http.patch(U(instanceId, slug.json().id), { is_public: true });
    expect(
      (await http.get(`/vola/files/${TYPE}/${instanceId}/slug/avatar`, {}, o)).statusCode,
    ).toBe(404);
    expect((await http.get(U(instanceId, slug.json().id), {}, o)).statusCode).toBe(200);
  });
});

describe("GET|HEAD /public/:fileId", () => {
  it("serves only is_global_public files, anonymously, with a public Cache-Control", async () => {
    const instanceId = randomUUID();
    const data = randomBytes(3000);
    const { response: up } = await http.upload(data, "world.png", {
      instanceId,
      contentType: "image/png",
    });
    const id = up.json().id as string;
    const anon = (
      url: string,
      headers: Record<string, string> = {},
      method: "GET" | "HEAD" = "GET",
    ) => app.inject({ method, url, headers });

    expect((await anon(`/vola/public/${id}`)).statusCode).toBe(404);
    await http.patch(U(instanceId, id), { is_public: true });
    expect((await anon(`/vola/public/${id}`)).statusCode).toBe(404);

    const made = await http.patch(U(instanceId, id), { is_global_public: true });
    expect(made.json()).toMatchObject({ is_public: true, is_global_public: true });
    const read = await anon(`/vola/public/${id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.rawPayload.equals(data)).toBe(true);
    expect(read.headers["cache-control"]).toBe("public, max-age=300");
    expect(read.headers["content-type"]).toBe("image/png");
    expect(read.headers["x-content-type-options"]).toBe("nosniff");
    expect(read.headers["content-disposition"]).toBe('inline; filename="world.png"');
    expect(read.headers.etag).toBe(`"${sha256(data)}"`);
    const head = await anon(`/vola/public/${id}`, {}, "HEAD");
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("3000");
    expect(head.body).toBe("");
    const range = await anon(`/vola/public/${id}`, { range: "bytes=-100" });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(data.subarray(2900))).toBe(true);
    expect(
      (await anon(`/vola/public/${id}`, { "if-none-match": `"${sha256(data)}"` })).statusCode,
    ).toBe(304);
    expect((await anon(`/vola/public/${id}?download=1`)).headers["content-disposition"]).toContain(
      "attachment",
    );
    // A bad key on a public route is ignored: the route needs none.
    expect(
      (await anon(`/vola/public/${id}`, { authorization: "Bearer vola_live_nope" })).statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await handle.db.select().from(files).where(eq(files.id, id));
    expect(row?.lastAccessedAt).not.toBeNull();
    expect(row?.lastAccessedBy).toBeNull();

    // Off again, unknown, malformed, soft-deleted: 404.
    await http.patch(U(instanceId, id), { is_global_public: false });
    expect((await anon(`/vola/public/${id}`)).statusCode).toBe(404);
    expect((await anon(`/vola/public/${randomUUID()}`)).statusCode).toBe(404);
    expect((await anon("/vola/public/not-a-uuid")).statusCode).toBe(404);
    await http.patch(U(instanceId, id), { is_global_public: true });
    await http.del(U(instanceId, id));
    expect((await anon(`/vola/public/${id}`)).statusCode).toBe(404);
  });

  it("never makes an encrypted file globally public (409 encrypted_not_public, 404 anonymously)", async () => {
    const instanceId = randomUUID();
    const { response: up } = await http.upload(Buffer.from("secret"), "s.txt", { instanceId });
    const id = up.json().id as string;
    // Phase 6 will write this column; until then only the database can.
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, id));
    const refused = await http.patch(U(instanceId, id), { is_global_public: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("encrypted_not_public");
    expect((await http.patch(U(instanceId, id), { is_public: true })).statusCode).toBe(200);
    expect((await http.patch(U(instanceId, id), { is_global_public: false })).statusCode).toBe(200);
    // Even a flag set behind the API's back does not open the anonymous route.
    await handle.db.update(files).set({ isGlobalPublic: true }).where(eq(files.id, id));
    expect((await app.inject({ method: "GET", url: `/vola/public/${id}` })).statusCode).toBe(404);
  });
});
