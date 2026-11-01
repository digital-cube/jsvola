import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FileInfoSchema } from "@vola/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vola/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");
const storagePath = inject("storagePath");

/**
 * Encryption at rest over HTTP against the built server (`VOLA_KEY_FILE` is the stack's):
 * an encrypted multipart upload, a byte-identical download, a real `Range`, the masked row.
 * Needs that server's database (skipped for an external `VOLA_E2E_URL`).
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("encryption (built server)", () => {
  let handle: DatabaseHandle;
  let key: string;
  const slug = `e2e-enc-${Date.now().toString(36)}`;
  const instanceId = randomUUID();
  const base = () => `${server}/files/tickets/${instanceId}`;

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E encryption" });
    key = (
      await createApiKey(handle.db, {
        tenantId: tenant.id,
        env: "test",
        name: "e2e-enc",
        scopes: ["files:read", "files:write"],
      })
    ).key;
  });
  afterAll(async () => {
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
    await handle.close();
  });

  it("uploads with X-Vola-Encryption: tenant, downloads byte-identically, seeks, keeps the row dark", async () => {
    const data = randomBytes(2 * 1024 * 1024 + 123);
    const marker = data.subarray(1000, 1064);
    const form = new FormData();
    form.append("file", new Blob([data], { type: "application/octet-stream" }), "Tajna.bin");
    const uploaded = await fetch(base(), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-vola-encryption": "tenant" },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const info = FileInfoSchema.parse(await uploaded.json());
    expect(info).toMatchObject({
      filename: "Tajna.bin",
      encryption: "tenant",
      enc_format: 1,
      size: data.length,
      processing_status: null,
    });
    expect(info.hash).not.toBe(createHash("sha256").update(data).digest("hex"));

    const [row] = await handle.db.select().from(schema.files).where(eq(schema.files.id, info.id));
    expect(row?.filename).toBe(`${info.id}.bin`);
    expect(row?.mimeType).toBe("application/octet-stream");
    expect(row?.fkCt?.length).toBe(64);
    if (storagePath) {
      const h = info.hash;
      const blob = await readFile(
        `${storagePath}/blobs/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4, 6)}/${h}`,
      );
      expect(blob.subarray(0, 3).toString()).toBe("JSV");
      expect(blob.includes(marker)).toBe(false);
    }

    const download = await fetch(`${base()}/${info.id}`, { headers: { "x-api-key": key } });
    expect(download.status).toBe(200);
    expect(download.headers.get("etag")).toBe(`"${info.id}"`);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="Tajna.bin"');
    expect(Buffer.from(await download.arrayBuffer()).equals(data)).toBe(true);

    const start = 1024 * 1024 + 7;
    const end = start + 99_999;
    const part = await fetch(`${base()}/${info.id}`, {
      headers: { "x-api-key": key, range: `bytes=${start}-${end}` },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes ${start}-${end}/${data.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(start, end + 1))).toBe(true);

    const detail = await fetch(`${base()}/${info.id}/info`, { headers: { "x-api-key": key } });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ filename: "Tajna.bin", encryption: "tenant" });
    const thumb = await fetch(`${base()}/${info.id}/thumb/128`, { headers: { "x-api-key": key } });
    expect(thumb.status).toBe(404);
  });
});
