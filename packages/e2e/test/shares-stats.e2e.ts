import { randomBytes, randomUUID } from "node:crypto";
import {
  FileInfoSchema,
  ShareCreatedSchema,
  SharedFolderListingSchema,
  StorageStatsSchema,
  TenantStatsSchema,
} from "@vol-a/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vol-a/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

/**
 * Share links and statistics over HTTP against the built server: a share is created with a
 * key and followed without one (password in the header, `Range` continuation not counted),
 * a folder share lists and serves by path, the stats endpoints answer with a snapshot.
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("share links and stats (built server)", () => {
  let handle: DatabaseHandle;
  let key: string;
  const slug = `e2e-shares-${Date.now().toString(36)}`;
  const instanceId = randomUUID();
  const filesBase = () => `${server}/files/tickets/${instanceId}`;
  const auth = () => ({ authorization: `Bearer ${key}` });
  const json = () => ({ ...auth(), "content-type": "application/json" });

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E shares" });
    key = (
      await createApiKey(handle.db, {
        tenantId: tenant.id,
        env: "test",
        name: "e2e-shares",
        scopes: ["files:read", "files:write", "folders:read", "folders:write", "shares:write"],
      })
    ).key;
  });
  afterAll(async () => {
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
    await handle.close();
  });

  const upload = async (name: string, data: Buffer, fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("file", new Blob([data]), name);
    for (const [field, value] of Object.entries(fields)) form.append(field, value);
    const response = await fetch(filesBase(), { method: "POST", headers: auth(), body: form });
    expect(response.status, await response.clone().text()).toBe(201);
    return FileInfoSchema.parse(await response.json());
  };

  it("shares a file with a password and a download limit; the url points back at this server", async () => {
    const data = randomBytes(4096);
    const info = await upload("report.bin", data);
    const created = await fetch(`${server}/shares`, {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ file_id: info.id, password: "pw", max_downloads: 1 }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const share = ShareCreatedSchema.parse(await created.json());
    expect(share.url).toBe(`${server}/s/${share.token}`);
    expect(share.has_password).toBe(true);

    expect((await fetch(share.url)).status).toBe(401);
    const head = await fetch(share.url, { method: "HEAD", headers: { "x-share-password": "pw" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("4096");
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    const first = await fetch(share.url, {
      headers: { "x-share-password": "pw", range: "bytes=0-1023" },
    });
    expect(first.status).toBe(206);
    expect(Buffer.from(await first.arrayBuffer()).equals(data.subarray(0, 1024))).toBe(true);
    const rest = await fetch(share.url, {
      headers: { "x-share-password": "pw", range: "bytes=1024-" },
    });
    expect(rest.status).toBe(206); // the continuation did not count
    expect(Buffer.from(await rest.arrayBuffer()).equals(data.subarray(1024))).toBe(true);
    const spent = await fetch(share.url, { headers: { "x-share-password": "pw" } });
    expect(spent.status).toBe(410);
    expect(((await spent.json()) as { error: { code: string } }).error.code).toBe("share_gone");
  });

  it("shares a folder: listing without a key, files by relative path, revoke ends it", async () => {
    await upload("a.txt", Buffer.from("alpha"), { folder_path: "pub/2026" });
    await upload("b.txt", Buffer.from("beta"), { folder_path: "pub" });
    const created = await fetch(`${server}/shares`, {
      method: "POST",
      headers: json(),
      body: JSON.stringify({
        folder: { instance_type: "tickets", instance_id: instanceId, path: "pub" },
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const share = ShareCreatedSchema.parse(await created.json());

    const listing = SharedFolderListingSchema.parse(await (await fetch(share.url)).json());
    expect(listing.folder).toEqual({ name: "pub", path: "" });
    expect(listing.subfolders).toEqual([{ name: "2026", path: "2026" }]);
    expect(listing.files.map((f) => f.path)).toEqual(["b.txt"]);
    const nested = await fetch(`${share.url}/path/2026/a.txt`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe("alpha");
    expect((await fetch(`${share.url}/path/2026/missing.txt`)).status).toBe(404);

    const revoked = await fetch(`${server}/shares/${share.id}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(revoked.status).toBe(200);
    expect((await fetch(share.url)).status).toBe(410);
    expect((await fetch(`${share.url}/path/2026/a.txt`)).status).toBe(410);
  });

  it("answers tenant, instance and storage statistics", async () => {
    const tenant = await fetch(`${server}/stats/tenant?recompute=1`, { headers: auth() });
    expect(tenant.status).toBe(200);
    const stats = TenantStatsSchema.parse(await tenant.json());
    expect(stats.scope).toBe("tenant");
    expect(stats.total_files).toBeGreaterThanOrEqual(3);
    expect(stats.by_kind.text).toBeGreaterThanOrEqual(2);

    const instance = await fetch(`${server}/stats/instance/tickets/${instanceId}`, {
      headers: auth(),
    });
    expect(instance.status).toBe(200);
    expect(TenantStatsSchema.parse(await instance.json())).toMatchObject({
      scope: "instance",
      instance_id: instanceId,
      total_files: stats.total_files,
    });

    const storage = await fetch(`${server}/stats/storage`, { headers: auth() });
    expect(storage.status).toBe(200);
    const usage = StorageStatsSchema.parse(await storage.json());
    expect(usage.scope).toBe("tenant");
    expect(usage.physical).toBeNull();
    expect(usage.logical_bytes).toBe(stats.total_bytes);
    expect(usage.unique_blobs).toBeLessThanOrEqual(usage.files);

    expect((await fetch(`${server}/stats/tenant`)).status).toBe(401);
  });
});
