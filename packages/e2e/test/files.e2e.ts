import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FileInfoSchema, FileListSchema, PurgeResultSchema } from "@vola/core";
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

/**
 * Files over HTTP against the built server: a real multipart body from `fetch` + `FormData`,
 * a real `Range` request, purge. Needs that server's database (skipped for an external
 * `VOLA_E2E_URL`).
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("files (built server)", () => {
  let handle: DatabaseHandle;
  let key: string;
  const slug = `e2e-files-${Date.now().toString(36)}`;
  const instanceId = randomUUID();
  const base = () => `${server}/files/tickets/${instanceId}`;

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E files" });
    key = (
      await createApiKey(handle.db, {
        tenantId: tenant.id,
        env: "test",
        name: "e2e-files",
        scopes: ["files:read", "files:write"],
      })
    ).key;
  });
  afterAll(async () => {
    // Only this suite's tenant (its keys and files cascade).
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
    await handle.close();
  });

  it("uploads, downloads byte-identically, seeks with Range, lists and purges", async () => {
    const data = randomBytes(300_000);
    const form = new FormData();
    form.append("file", new Blob([data], { type: "application/pdf" }), "Račun.pdf");
    form.append("metadata", JSON.stringify({ via: "e2e" }));
    const uploaded = await fetch(base(), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-user-id": "e2e" },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const info = FileInfoSchema.parse(await uploaded.json());
    expect(info).toMatchObject({
      filename: "Račun.pdf",
      mime_type: "application/pdf",
      kind: "document",
      size: data.length,
      hash: createHash("sha256").update(data).digest("hex"),
      metadata: { via: "e2e" },
      created_by: "e2e",
    });

    const download = await fetch(`${base()}/${info.id}`, { headers: { "x-api-key": key } });
    expect(download.status).toBe(200);
    expect(download.headers.get("etag")).toBe(`"${info.hash}"`);
    expect(download.headers.get("accept-ranges")).toBe("bytes");
    expect(download.headers.get("content-disposition")).toMatch(
      /^inline; filename="Ra_un\.pdf"; filename\*=UTF-8''Ra%C4%8Dun\.pdf$/,
    );
    expect(Buffer.from(await download.arrayBuffer()).equals(data)).toBe(true);

    const partial = await fetch(`${base()}/${info.id}`, {
      headers: { "x-api-key": key, range: "bytes=1000-1999" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 1000-1999/${data.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(data.subarray(1000, 2000))).toBe(true);

    const headResponse = await fetch(`${base()}/${info.id}`, {
      method: "HEAD",
      headers: { "x-api-key": key },
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-length")).toBe(String(data.length));
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0);

    const notModified = await fetch(`${base()}/${info.id}`, {
      headers: { "x-api-key": key, "if-none-match": `"${info.hash}"` },
    });
    expect(notModified.status).toBe(304);

    const listed = await fetch(base(), { headers: { "x-api-key": key } });
    expect(FileListSchema.parse(await listed.json()).files.map((f) => f.id)).toEqual([info.id]);

    const purged = await fetch(`${base()}/${info.id}/purge`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    expect(PurgeResultSchema.parse(await purged.json())).toEqual({ files: 1, blobs: 1 });
    const gone = await fetch(`${base()}/${info.id}`, { headers: { "x-api-key": key } });
    expect(gone.status).toBe(404);
  });

  it("upserts a named file by slug", async () => {
    const put = async (content: string) => {
      const form = new FormData();
      form.append("file", new Blob([content], { type: "text/plain" }), "note.txt");
      return fetch(`${base()}/slug/note`, {
        method: "PUT",
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
    };
    expect((await put("first")).status).toBe(201);
    expect((await put("second")).status).toBe(201);
    const current = await fetch(`${base()}/slug/note`, { headers: { "x-api-key": key } });
    expect(current.status).toBe(200);
    expect(await current.text()).toBe("second");
    const all = FileListSchema.parse(
      await (await fetch(`${base()}?include_deleted=1`, { headers: { "x-api-key": key } })).json(),
    );
    expect(all.files.filter((f) => f.slug === "note")).toHaveLength(2);
    expect(all.files.filter((f) => f.slug === "note" && f.deleted_at === null)).toHaveLength(1);
  });
});
