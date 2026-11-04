import { randomBytes, randomUUID } from "node:crypto";
import nodeHttp from "node:http";
import { FileInfoSchema, FolderInfoSchema, FolderListingSchema } from "@vol-a/core";
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
 * Folders, path downloads, versions and the anonymous public route over HTTP against the
 * built server — real URL encoding (a space and a `č` in a path), a raw `..` that no client
 * normalised away, a cross-origin style anonymous fetch. Needs that server's database.
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))(
  "folders and public files (built server)",
  () => {
    let handle: DatabaseHandle;
    let key: string;
    const slug = `e2e-folders-${Date.now().toString(36)}`;
    const instanceId = randomUUID();
    const filesBase = () => `${server}/files/tickets/${instanceId}`;
    const foldersBase = () => `${server}/folders/tickets/${instanceId}`;
    const auth = () => ({ authorization: `Bearer ${key}` });

    beforeAll(async () => {
      handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
      const tenant = await createTenant(handle.db, { slug, name: "E2E folders" });
      key = (
        await createApiKey(handle.db, {
          tenantId: tenant.id,
          env: "test",
          name: "e2e-folders",
          scopes: ["files:read", "files:write", "folders:read", "folders:write"],
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

    it("creates folders, uploads into them, downloads by an encoded path, renames the chain", async () => {
      const created = await fetch(`${foldersBase()}/Izve%C5%A1taji/2026%20Q4`, {
        method: "POST",
        headers: auth(),
      });
      expect(created.status).toBe(201);
      const leaf = FolderInfoSchema.parse(await created.json());
      expect(leaf.path).toBe("Izveštaji/2026 Q4");

      const data = randomBytes(10_000);
      const info = await upload("Račun.pdf", data, { folder_path: "Izveštaji/2026 Q4" });
      expect(info.folder_id).toBe(leaf.id);

      const byPath = await fetch(
        `${filesBase()}/path/${encodeURI("Izveštaji/2026 Q4/Račun.pdf")}`,
        {
          headers: { ...auth(), range: "bytes=0-9" },
        },
      );
      expect(byPath.status).toBe(206);
      expect(Buffer.from(await byPath.arrayBuffer()).equals(data.subarray(0, 10))).toBe(true);

      const listing = await fetch(`${foldersBase()}/Izve%C5%A1taji`, { headers: auth() });
      const parsed = FolderListingSchema.parse(await listing.json());
      expect(parsed.subfolders.map((f) => f.path)).toEqual(["Izveštaji/2026 Q4"]);

      const renamed = await fetch(`${foldersBase()}/Izve%C5%A1taji`, {
        method: "PATCH",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ name: "Reports" }),
      });
      expect(renamed.status).toBe(200);
      const moved = await fetch(`${filesBase()}/path/${encodeURI("Reports/2026 Q4/Račun.pdf")}`, {
        method: "HEAD",
        headers: auth(),
      });
      expect(moved.status).toBe(200);
      expect(moved.headers.get("content-length")).toBe("10000");

      // `fetch` resolves `..` and `%2e%2e` itself (WHATWG URL), so only a raw request shows
      // what the server does with one: it refuses it.
      const target = new URL(foldersBase());
      const traversal = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = nodeHttp.request(
          {
            host: target.hostname,
            port: target.port,
            path: `${target.pathname}/Reports/%2e%2e/escape`,
            method: "POST",
            headers: auth(),
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(traversal.status, traversal.body).toBe(422);
      expect(JSON.parse(traversal.body).error.code).toBe("validation_error");
    });

    it("serves a globally public file anonymously and nothing else", async () => {
      const data = randomBytes(2000);
      const info = await upload("public.bin", data);
      const anonymous = await fetch(`${server}/public/${info.id}`);
      expect(anonymous.status).toBe(404);

      const flagged = await fetch(`${filesBase()}/${info.id}`, {
        method: "PATCH",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ is_global_public: true }),
      });
      expect(flagged.status).toBe(200);
      const served = await fetch(`${server}/public/${info.id}`);
      expect(served.status).toBe(200);
      expect(served.headers.get("cache-control")).toBe("public, max-age=300");
      expect(Buffer.from(await served.arrayBuffer()).equals(data)).toBe(true);

      const version = await upload("", data.subarray(0, 100), { parent_id: info.id });
      expect(version).toMatchObject({ parent_id: info.id, filename: "public.bin" });
      const versions = await fetch(`${filesBase()}/${info.id}/versions`, { headers: auth() });
      expect(
        ((await versions.json()) as { versions: { id: string }[] }).versions.map((v) => v.id),
      ).toEqual([version.id, info.id]);
    });
  },
);
