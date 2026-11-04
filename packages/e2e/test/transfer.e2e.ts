import { randomUUID } from "node:crypto";
import { FileInfoSchema, FileListSchema, TransferResultSchema } from "@vol-a/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vol-a/server";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

/**
 * The admin transfer over HTTP against the built server: files of one instance move from one
 * tenant to another, the share link keeps working, the source sees nothing, a tenant key is
 * refused, a dry run writes nothing.
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("admin transfer (built server)", () => {
  let handle: DatabaseHandle;
  let adminKey: string;
  let srcKey: string;
  let dstKey: string;
  const stamp = Date.now().toString(36);
  const src = `e2e-src-${stamp}`;
  const dst = `e2e-dst-${stamp}`;
  const instanceId = randomUUID();
  const filesBase = () => `${server}/files/tickets/${instanceId}`;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const json = (key: string) => ({ ...auth(key), "content-type": "application/json" });

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const scopes = ["files:read", "files:write", "folders:read", "folders:write", "shares:write"];
    const a = await createTenant(handle.db, { slug: src, name: "E2E source" });
    const b = await createTenant(handle.db, { slug: dst, name: "E2E destination" });
    srcKey = (await createApiKey(handle.db, { tenantId: a.id, env: "test", name: "src", scopes }))
      .key;
    dstKey = (await createApiKey(handle.db, { tenantId: b.id, env: "test", name: "dst", scopes }))
      .key;
    adminKey = (
      await createApiKey(handle.db, {
        tenantId: null,
        env: "admin",
        name: "e2e-admin",
        scopes: ["admin"],
      })
    ).key;
  });
  afterAll(async () => {
    await handle.db.delete(schema.apiKeys).where(inArray(schema.apiKeys.name, ["e2e-admin"]));
    await handle.db.delete(schema.tenants).where(inArray(schema.tenants.slug, [src, dst]));
    await handle.close();
  });

  const upload = async (name: string, data: Buffer, fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("file", new Blob([data]), name);
    for (const [field, value] of Object.entries(fields)) form.append(field, value);
    const response = await fetch(filesBase(), {
      method: "POST",
      headers: auth(srcKey),
      body: form,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return FileInfoSchema.parse(await response.json());
  };

  const transfer = (key: string, body: Record<string, unknown>) =>
    fetch(`${server}/admin/transfer`, {
      method: "POST",
      headers: json(key),
      body: JSON.stringify(body),
    });

  it("moves the instance, keeps the share token working, refuses a tenant key, dry run writes nothing", async () => {
    const info = await upload("doc.txt", Buffer.from("moved by e2e"), { folder_path: "docs" });
    const shared = await fetch(`${server}/shares`, {
      method: "POST",
      headers: json(srcKey),
      body: JSON.stringify({ file_id: info.id }),
    });
    expect(shared.status, await shared.clone().text()).toBe(201);
    const { token } = (await shared.json()) as { token: string };
    const body = {
      from_tenant: src,
      to_tenant: dst,
      instances: [{ instance_type: "tickets", instance_id: instanceId }],
    };

    const refused = await transfer(srcKey, body);
    expect(refused.status).toBe(403);

    const dry = await transfer(adminKey, { ...body, dry_run: true });
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(TransferResultSchema.parse(await dry.json())).toMatchObject({
      files: 1,
      folders: 1,
      shares: 1,
      dry_run: true,
    });
    const still = await fetch(filesBase(), { headers: auth(srcKey) });
    expect(FileListSchema.parse(await still.json()).files).toHaveLength(1);

    const real = await transfer(adminKey, body);
    expect(real.status, await real.clone().text()).toBe(200);
    expect(TransferResultSchema.parse(await real.json())).toMatchObject({
      from_tenant: src,
      to_tenant: dst,
      instances: 1,
      files: 1,
      folders: 1,
      merged_folders: 0,
      shares: 1,
      dry_run: false,
    });
    const gone = await fetch(filesBase(), { headers: auth(srcKey) });
    expect(FileListSchema.parse(await gone.json()).files).toEqual([]);
    const arrived = await fetch(`${filesBase()}/path/docs/doc.txt`, { headers: auth(dstKey) });
    expect(arrived.status).toBe(200);
    expect(await arrived.text()).toBe("moved by e2e");
    const link = await fetch(`${server}/s/${token}`);
    expect(link.status).toBe(200);
    expect(await link.text()).toBe("moved by e2e");

    const again = await transfer(adminKey, body);
    expect(TransferResultSchema.parse(await again.json())).toMatchObject({ files: 0, folders: 0 });
  });
});
