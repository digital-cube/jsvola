import { randomUUID } from "node:crypto";
import { FileInfoSchema, THUMBNAIL_SIZES } from "@vol-a/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vol-a/server";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");
const hasWorker = inject("worker");

/**
 * Thumbnails across two real processes: the built server queues the jobs on Redis, the built
 * worker (`node dist/worker.js`, started by `stack.ts`) renders them, and `/thumb` goes from
 * `202 generating` to `200 ready`. Needs the stack's own server and worker.
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL) || !hasWorker)(
  "thumbnails (server + worker)",
  () => {
    let handle: DatabaseHandle;
    let key: string;
    const slug = `e2e-thumbs-${Date.now().toString(36)}`;
    const instanceId = randomUUID();
    const base = () => `${server}/files/tickets/${instanceId}`;
    const auth = () => ({ authorization: `Bearer ${key}` });

    beforeAll(async () => {
      handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
      const tenant = await createTenant(handle.db, { slug, name: "E2E thumbnails" });
      key = (
        await createApiKey(handle.db, {
          tenantId: tenant.id,
          env: "test",
          name: "e2e-thumbs",
          scopes: ["files:read", "files:write"],
        })
      ).key;
    });
    afterAll(async () => {
      await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
      await handle.close();
    });

    it("uploads a JPEG, sees PENDING, gets 202 then 200 from the worker, and DONE in info", async () => {
      const jpeg = await sharp({
        create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 30, b: 30 } },
      })
        .jpeg()
        .toBuffer();
      const form = new FormData();
      form.append("file", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
      const uploaded = await fetch(base(), { method: "POST", headers: auth(), body: form });
      expect(uploaded.status).toBe(201);
      const info = FileInfoSchema.parse(await uploaded.json());
      expect(info.mime_type).toBe("image/jpeg");
      expect(info.processing_status).toBe("PENDING");

      // A rendition the upload did not queue: the first answer is a 202 placeholder.
      const first = await fetch(`${base()}/${info.id}/thumb/128?crop=fit`, { headers: auth() });
      expect([200, 202]).toContain(first.status); // 200 only if the worker was faster than us
      expect(first.headers.get("content-type")).toBe("image/webp");
      if (first.status === 202) {
        expect(first.headers.get("x-thumbnail-status")).toBe("generating");
        expect(first.headers.get("cache-control")).toBe("no-cache");
        expect((await first.arrayBuffer()).byteLength).toBeLessThan(200);
      }

      const deadline = Date.now() + 30_000;
      let ready: Response | null = null;
      while (Date.now() < deadline) {
        const response = await fetch(`${base()}/${info.id}/thumb/128?crop=fit`, {
          headers: auth(),
        });
        if (response.status === 200) {
          ready = response;
          break;
        }
        expect(response.status).toBe(202);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(ready, "the worker did not render the thumbnail in 30 s").not.toBeNull();
      expect(ready?.headers.get("x-thumbnail-status")).toBe("ready");
      expect(ready?.headers.get("cache-control")).toBe("private, max-age=86400");
      const bytes = Buffer.from(await (ready as Response).arrayBuffer());
      const meta = await sharp(bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", 128, 128]);

      // The four default renditions settle too; the aggregate becomes DONE.
      let status = "";
      while (Date.now() < deadline) {
        const response = await fetch(`${base()}/${info.id}/info`, { headers: auth() });
        status = ((await response.json()) as { processing_status: string }).processing_status;
        if (status === "DONE") break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(status).toBe("DONE");
      for (const size of THUMBNAIL_SIZES) {
        const response = await fetch(`${base()}/${info.id}/thumb/${size}`, {
          method: "HEAD",
          headers: auth(),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-thumbnail-status")).toBe("ready");
      }
      // Not a picture: 404 no_thumbnail; a bad size: 400.
      const bad = await fetch(`${base()}/${info.id}/thumb/100`, { headers: auth() });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_size");
    });
  },
);
