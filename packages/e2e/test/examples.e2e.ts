/**
 * The examples site end to end (plan 8.1): the built site at `/` and every page, the demo
 * configuration route, the demo pack through `vola demo-seed`, the write proxy and its
 * limits, thumbnails and `Range` with the visitor's read-only key — against the suite's own
 * server (examples on, `apps/examples/dist` served) or an external `VOLA_E2E_URL` stack (the
 * compose `demo` profile) when `VOLA_DEMO_API_KEY` / `VOLA_DEMO_WRITE_KEY` are given.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { seedDemo } from "@vola/cli";
import { FileInfoSchema, FileListSchema, ShareCreatedSchema } from "@vola/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { startServer, stop } from "./spawn.js";

const server = inject("server");
const examples = inject("examples");
const ui = inject("ui");
const serverEnv = inject("serverEnv");
const ASSETS = fileURLToPath(new URL("../../../apps/examples/assets", import.meta.url));

/** The origin the site is served on: the API base without its prefix. */
const origin = new URL(server).origin;
const PAGES = [
  "/",
  "/examples/browse",
  "/examples/upload",
  "/examples/thumbnails",
  "/examples/streaming",
  "/examples/share",
  "/examples/encrypted",
  "/examples/api",
  "/udc/files",
  "/en/",
  "/en/examples/share",
];

interface Config {
  api_key: string;
  tenant: string;
  instance_type: string;
  instance_id: string;
  write_path: string;
  limits: { max_upload_bytes: number; ttl_hours: number; mime_types: string[] };
}

/** The `error.code` of an error envelope. */
const errorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const visitor = `demo-e2e${randomUUID().slice(0, 8).replace(/-/g, "")}`;
/** A real 8 × 8 red PNG (the worker renders a thumbnail of it). */
const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 40, b: 40 } } })
    .png()
    .toBuffer();

describe.skipIf(!examples)("the examples site (built server)", () => {
  let config: Config;
  let seeded: Awaited<ReturnType<typeof seedDemo>>;

  beforeAll(async () => {
    const response = await fetch(`${server}/examples/config`);
    expect(response.status).toBe(200);
    config = (await response.json()) as Config;
    // The pack, as the compose `seeder` uploads it (twice: the second run changes nothing).
    seeded = await seedDemo({
      url: server,
      key: examples?.writeKey as string,
      assets: ASSETS,
      instanceType: config.instance_type,
      instanceId: config.instance_id,
      waitS: 30,
    });
  }, 120_000);

  it("GET /examples/config hands out the read-only key and the limits", () => {
    expect(config.api_key).toBe(examples?.apiKey);
    expect(config.api_key).not.toBe(examples?.writeKey);
    expect(config.write_path.endsWith("/examples/write/")).toBe(true);
    expect(config.limits.max_upload_bytes).toBeGreaterThan(0);
    expect(config.limits.mime_types).toContain("image/png");
  });

  it("the seeder uploaded the pack and a second run leaves it alone", async () => {
    expect(seeded.uploaded.length + seeded.unchanged.length).toBeGreaterThanOrEqual(8);
    expect(seeded.published.length + (seeded.unchanged.includes("clip") ? 1 : 0)).toBeGreaterThan(
      0,
    );
    const again = await seedDemo({
      url: server,
      key: examples?.writeKey as string,
      assets: ASSETS,
      instanceType: config.instance_type,
      instanceId: config.instance_id,
      waitS: 10,
    });
    expect(again.uploaded).toEqual([]);
    expect(again.unchanged.length).toBeGreaterThanOrEqual(8);
  }, 60_000);

  describe.skipIf(!ui)("the site at /", () => {
    it.each(PAGES)("GET %s answers the page", async (path) => {
      const response = await fetch(`${origin}${path}`, { headers: { accept: "text/html" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      const html = await response.text();
      expect(html).toContain('<div id="root">');
      expect(html).toContain("vola examples");
    });

    it("serves the hashed assets immutable and keeps the API's 404s JSON", async () => {
      const html = await (await fetch(`${origin}/`)).text();
      const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
      expect(asset).toBeTruthy();
      const js = await fetch(`${origin}${asset}`);
      expect(js.status).toBe(200);
      expect(js.headers.get("cache-control")).toContain("immutable");
      const api = await fetch(`${server}/nope`, { headers: { accept: "text/html" } });
      expect(api.status).toBe(404);
      expect(await errorCode(api)).toBe("not_found");
      expect((await fetch(`${origin}/en`, { redirect: "manual" })).status).toBe(301);
    });
  });

  describe("the visitor's key", () => {
    const auth = () => ({ authorization: `Bearer ${config.api_key}` });
    const instance = () => `${server}/files/${config.instance_type}/${config.instance_id}`;

    it("lists the seeded files but cannot write", async () => {
      const list = await fetch(`${instance()}?limit=200`, { headers: auth() });
      expect(list.status).toBe(200);
      const files = FileListSchema.parse(await list.json()).files;
      const slugs = files.map((f) => f.slug);
      expect(slugs).toEqual(
        expect.arrayContaining(["aurora", "ocr-sample", "clip", "vault-poster"]),
      );
      expect(files.find((f) => f.slug === "vault-poster")?.encryption).toBe("tenant");
      const form = new FormData();
      form.append("file", new Blob([await png()], { type: "image/png" }), "x.png");
      const write = await fetch(instance(), { method: "POST", headers: auth(), body: form });
      expect(write.status).toBe(403);
    });

    it("gets a thumbnail (202 first with a worker, then 200) and the public clip with Range → 206", async () => {
      const list = FileListSchema.parse(
        await (await fetch(`${instance()}?limit=200`, { headers: auth() })).json(),
      );
      const aurora = list.files.find((f) => f.slug === "aurora");
      const clip = list.files.find((f) => f.slug === "clip");
      expect(aurora && clip).toBeTruthy();
      let status = 0;
      for (let i = 0; i < 30 && status !== 200; i++) {
        const thumb = await fetch(`${instance()}/${aurora?.id}/thumb/128?crop=fit`, {
          headers: auth(),
        });
        status = thumb.status;
        expect([200, 202]).toContain(status);
        if (status === 202) await new Promise((r) => setTimeout(r, 500));
      }
      expect(status).toBe(200);
      const part = await fetch(`${server}/public/${clip?.id}`, {
        headers: { range: "bytes=100-199" },
      });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toMatch(/^bytes 100-199\/\d+$/);
      expect((await part.arrayBuffer()).byteLength).toBe(100);
    }, 30_000);
  });

  describe("the write proxy", () => {
    const write = () => `${origin}${new URL(server).pathname}/examples/write`;
    const instance = () => `files/${config.instance_type}/${config.instance_id}`;

    it("uploads for a visitor, refuses a type it does not keep, a seeded file's rename, and no visitor id", async () => {
      const form = new FormData();
      form.append("file", new Blob([await png()], { type: "image/png" }), "visitor.png");
      form.append("folder_path", "uploads");
      const created = await fetch(`${write()}/${instance()}`, {
        method: "POST",
        headers: { "x-user-id": visitor },
        body: form,
      });
      expect(created.status).toBe(201);
      const info = FileInfoSchema.parse(await created.json());
      expect(info.created_by).toBe(visitor);

      const zip = new FormData();
      zip.append(
        "file",
        new Blob([Buffer.from("PK\u0003\u0004zip")], { type: "application/zip" }),
        "x.zip",
      );
      const refused = await fetch(`${write()}/${instance()}`, {
        method: "POST",
        headers: { "x-user-id": visitor },
        body: zip,
      });
      expect(refused.status).toBe(415);
      expect(await errorCode(refused)).toBe("demo_mime_not_allowed");

      const list = FileListSchema.parse(
        await (
          await fetch(`${server}/${instance()}?limit=200`, {
            headers: { authorization: `Bearer ${config.api_key}` },
          })
        ).json(),
      );
      const seededFile = list.files.find((f) => f.slug === "aurora");
      const rename = await fetch(`${write()}/${instance()}/${seededFile?.id}`, {
        method: "PATCH",
        headers: { "x-user-id": visitor, "content-type": "application/json" },
        body: JSON.stringify({ filename: "hacked.jpg" }),
      });
      expect(rename.status).toBe(403);
      const mine = await fetch(`${write()}/${instance()}/${info.id}`, {
        method: "PATCH",
        headers: { "x-user-id": visitor, "content-type": "application/json" },
        body: JSON.stringify({ filename: "renamed.png" }),
      });
      expect(mine.status).toBe(200);

      const anonymous = await fetch(`${write()}/${instance()}`, { method: "POST", body: form });
      expect(anonymous.status).toBe(400);
      const forbidden = await fetch(`${write()}/keys`, {
        method: "POST",
        headers: { "x-user-id": visitor, "content-type": "application/json" },
        body: "{}",
      });
      expect(forbidden.status).toBe(403);
    });

    it("caps a share's expiry at the demo TTL", async () => {
      const list = FileListSchema.parse(
        await (
          await fetch(`${server}/${instance()}?limit=200`, {
            headers: { authorization: `Bearer ${config.api_key}` },
          })
        ).json(),
      );
      const file = list.files.find((f) => f.slug === "geometry");
      const far = new Date(Date.now() + 90 * 86_400_000).toISOString();
      const created = await fetch(`${write()}/shares`, {
        method: "POST",
        headers: { "x-user-id": visitor, "content-type": "application/json" },
        body: JSON.stringify({ file_id: file?.id, expires_at: far }),
      });
      expect(created.status).toBe(201);
      const share = ShareCreatedSchema.parse(await created.json());
      expect(new Date(share.expires_at ?? 0).getTime()).toBeLessThanOrEqual(
        Date.now() + config.limits.ttl_hours * 3_600_000 + 5000,
      );
      // The link works without a key.
      const opened = await fetch(share.url);
      expect(opened.status).toBe(200);
      const revoked = await fetch(`${write()}/shares/${share.id}`, {
        method: "DELETE",
        headers: { "x-user-id": visitor },
      });
      expect(revoked.status).toBe(200);
    });
  });
});

describe.skipIf(!serverEnv)("without VOLA_EXAMPLES", () => {
  let plain: Awaited<ReturnType<typeof startServer>> | null = null;
  beforeAll(async () => {
    const env = { ...(serverEnv as Record<string, string>) };
    delete env.VOLA_EXAMPLES;
    delete env.VOLA_DEMO_API_KEY;
    delete env.VOLA_DEMO_WRITE_KEY;
    delete env.VOLA_UI_DIR;
    env.VOLA_QUEUE_PREFIX = `${env.VOLA_QUEUE_PREFIX}-plain`;
    plain = await startServer(env);
  }, 60_000);
  afterAll(async () => stop(plain?.child ?? null));

  it("GET /examples/config and the write proxy do not exist, and / is a JSON 404", async () => {
    const base = plain?.base as string;
    expect((await fetch(`${base}/examples/config`)).status).toBe(404);
    expect((await fetch(`${base}/examples/write/shares`, { method: "POST" })).status).toBe(404);
    const root = await fetch(new URL(base).origin, { headers: { accept: "text/html" } });
    expect(root.status).toBe(404);
    expect(await errorCode(root)).toBe("not_found");
  });
});
