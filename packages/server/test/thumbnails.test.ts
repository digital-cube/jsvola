import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInfoSchema, THUMBNAIL_SIZES, thumbnailDerivedName } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "../src/db/schema.js";
import { resolveJobsMode } from "../src/jobs/availability.js";
import { thumbnailable } from "../src/jobs/dispatcher.js";
import { listProcessingJobs, shortError } from "../src/services/processing.js";
import { createTenant } from "../src/services/tenants.js";
import {
  parseThumbnailCrop,
  parseThumbnailSize,
  renderThumbnail,
  ThumbnailError,
  thumbnailPlaceholder,
} from "../src/services/thumbnails.js";
import { FilesystemBackend } from "../src/storage/index.js";
import {
  brokenPngFixture,
  decode,
  isBlue,
  isRed,
  isTransparent,
  jpegExifFixture,
  pdfFixture,
  pngFixture,
} from "./fixtures.js";
import { type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let http: ReturnType<typeof httpClient>;
let root: string;
let storage: FilesystemBackend;
let otherKey: string;

const TYPE = "tickets";

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-thumbs-"));
  storage = new FilesystemBackend(root);
  // The fixture's config has VOLA_WORKER_ENABLED=0: sync mode, thumbnails render inline.
  fx = await setupFixture(handle, { storage, uploadSweepIntervalMs: 0 });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  otherKey = (await mintKey(handle, tenant.id, "other", "live", ["files:read", "files:write"])).key;
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

async function uploaded(data: Buffer, filename: string, contentType?: string) {
  const { response, instanceId } = await http.upload(data, filename, { contentType });
  expect(response.statusCode, response.body).toBe(201);
  const info = FileInfoSchema.parse(response.json());
  return { info, instanceId, url: `/vola/files/${TYPE}/${instanceId}/${info.id}` };
}

describe("GET /thumb/:size in sync mode (VOLA_WORKER_ENABLED=0)", () => {
  it("renders a PNG inline at every size, 200 ready with ETag and a day of private cache", async () => {
    const { info, url } = await uploaded(await pngFixture(), "photo.png");
    expect(info.processing_status).toBeNull(); // nothing was queued
    for (const size of THUMBNAIL_SIZES) {
      const response = await http.get(`${url}/thumb/${size}`, {}, fx.readOnly.key);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-type"]).toBe("image/webp");
      expect(response.headers["x-thumbnail-status"]).toBe("ready");
      expect(response.headers["cache-control"]).toBe("private, max-age=86400");
      expect(response.headers.etag).toBe(`"${info.hash}.thumb-${size}-cover.webp"`);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      const image = await decode(response.rawPayload);
      expect(image.format).toBe("webp");
      expect([image.width, image.height]).toEqual([size, size]);
      // cover = the centre square of a 200×100 red|blue: left red, right blue.
      expect(isRed(image.pixel(size / 4, size / 2))).toBe(true);
      expect(isBlue(image.pixel((size * 3) / 4, size / 2))).toBe(true);
      expect(
        await storage.statDerived(info.hash, thumbnailDerivedName(size, "cover")),
      ).not.toBeNull();
    }
    // No job rows in sync mode; the aggregate stays empty.
    expect(await listProcessingJobs(handle.db, info.id)).toEqual([]);
    const again = await http.get(`${url}/info`);
    expect(again.json().processing_status).toBeNull();
  });

  it("serves a rendered thumbnail from disk, answers 304 to If-None-Match and HEAD without a body", async () => {
    const { info, url } = await uploaded(await pngFixture(), "photo.png");
    const first = await http.get(`${url}/thumb/64`);
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    const cached = await http.get(`${url}/thumb/64`, { "if-none-match": etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");
    const head = await http.head(`${url}/thumb/64`);
    expect(head.statusCode).toBe(200);
    expect(head.headers["x-thumbnail-status"]).toBe("ready");
    expect(head.headers["content-length"]).toBe(String(first.rawPayload.length));
    expect(head.body).toBe("");
    expect(head.headers.etag).toBe(`"${info.hash}.thumb-64-cover.webp"`);
  });

  it("applies the EXIF orientation of a JPEG before cropping", async () => {
    const { url } = await uploaded(await jpegExifFixture(), "rotated.jpg", "image/jpeg");
    // Displayed, the picture is 100×200 with red on top: cover crops the middle square.
    const cover = await decode((await http.get(`${url}/thumb/64`)).rawPayload);
    expect(isRed(cover.pixel(32, 8))).toBe(true);
    expect(isBlue(cover.pixel(32, 56))).toBe(true);
    // fit = contain: the whole 100×200 inside 64×64 → a 32×64 column, transparent padding.
    const fit = await http.get(`${url}/thumb/64?crop=fit`);
    expect(fit.statusCode).toBe(200);
    expect(fit.headers.etag).toContain("thumb-64-fit.webp");
    const contained = await decode(fit.rawPayload);
    expect([contained.width, contained.height]).toEqual([64, 64]);
    expect(isRed(contained.pixel(32, 8))).toBe(true);
    expect(isBlue(contained.pixel(32, 56))).toBe(true);
    expect(isTransparent(contained.pixel(4, 32))).toBe(true);
    expect(isTransparent(contained.pixel(60, 32))).toBe(true);
    // attention: a square too, from the most "interesting" region.
    const attention = await decode((await http.get(`${url}/thumb/128?crop=attention`)).rawPayload);
    expect([attention.width, attention.height]).toEqual([128, 128]);
  });

  it("renders the first page of a PDF through pdftoppm", async () => {
    const { info, url } = await uploaded(pdfFixture(), "doc.pdf", "application/pdf");
    expect(info.mime_type).toBe("application/pdf");
    const response = await http.get(`${url}/thumb/256?crop=fit`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-thumbnail-status"]).toBe("ready");
    const page = await decode(response.rawPayload);
    expect([page.width, page.height]).toEqual([256, 256]);
    // A 200×100 pt page contained in 256×256: 256×128 in the middle; its left half is red.
    expect(isRed(page.pixel(64, 128))).toBe(true);
    const right = page.pixel(192, 128);
    expect(right.r > 200 && right.g > 200 && right.b > 200).toBe(true); // white paper
    expect(isTransparent(page.pixel(128, 16))).toBe(true);
  });

  it("answers 404 no_thumbnail for a type without one (text, SVG)", async () => {
    const text = await uploaded(Buffer.from("hello"), "note.txt");
    const response = await http.get(`${text.url}/thumb/128`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("no_thumbnail");
    const svg = await uploaded(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
      "icon.svg",
      "image/svg+xml",
    );
    expect(svg.info.mime_type).toBe("image/svg+xml");
    expect((await http.get(`${svg.url}/thumb/128`)).json().error.code).toBe("no_thumbnail");
  });

  it("answers 404 no_thumbnail for a client-encrypted file and 409 for a row marked encrypted without a key record", async () => {
    const { info, url } = await uploaded(await pngFixture(), "secret.png");
    await handle.db.update(files).set({ encryption: "client" }).where(eq(files.id, info.id));
    const response = await http.get(`${url}/thumb/128`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("no_thumbnail");
    // A `tenant` row without `fk_ct` cannot open: the integrity answer (test/derivatives.test.ts has the real thing).
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, info.id));
    const broken = await http.get(`${url}/thumb/128`);
    expect([409, 503]).toContain(broken.statusCode);
    expect(thumbnailable({ mimeType: "image/png", encryption: "tenant" })).toBe(true);
    expect(thumbnailable({ mimeType: "image/png", encryption: "keyring" })).toBe(false);
    expect(thumbnailable({ mimeType: "image/png", encryption: "none" })).toBe(true);
  });

  it("rejects a size outside 64/128/256/512 with 400 and an unknown crop with 400", async () => {
    const { url } = await uploaded(await pngFixture(), "photo.png");
    for (const size of ["100", "0", "1024", "abc", "64.5"]) {
      const response = await http.get(`${url}/thumb/${size}`);
      expect(response.statusCode, size).toBe(400);
      expect(response.json().error.code).toBe("invalid_size");
    }
    const crop = await http.get(`${url}/thumb/64?crop=center-square`);
    expect(crop.statusCode).toBe(400);
    expect(crop.json().error.code).toBe("invalid_crop");
    expect(parseThumbnailCrop(undefined)).toBe("cover");
    expect(parseThumbnailCrop("")).toBe("cover");
    expect(parseThumbnailSize("512")).toBe(512);
  });

  it("checks the size before it looks at the file", async () => {
    const response = await http.get(`/vola/files/${TYPE}/${randomUUID()}/${randomUUID()}/thumb/99`);
    expect(response.statusCode).toBe(400);
  });

  it("is tenant-scoped: another tenant's key gets 404 file_not_found, a public file is readable", async () => {
    const { url } = await uploaded(await pngFixture(), "photo.png");
    const foreign = await http.get(`${url}/thumb/64`, {}, otherKey);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("file_not_found");
    const noScope = await http.get(`${url}/thumb/64`, {}, fx.admin.key);
    expect(noScope.statusCode).toBe(400); // admin without X-Tenant-Slug
    await http.patch(url, { is_public: true });
    const shared = await http.get(`${url}/thumb/64`, {}, otherKey);
    expect(shared.statusCode).toBe(200);
  });

  it("needs files:read", async () => {
    const { url } = await uploaded(await pngFixture(), "photo.png");
    const response = await app.inject({ method: "GET", url: `${url}/thumb/64` });
    expect(response.statusCode).toBe(401);
  });

  it("answers a broken image with a 200 grey placeholder marked failed, not cached", async () => {
    const { info, url } = await uploaded(brokenPngFixture(), "broken.png");
    expect(info.mime_type).toBe("image/png");
    const response = await http.get(`${url}/thumb/128`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-thumbnail-status"]).toBe("failed");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers.etag).toBeUndefined();
    const image = await decode(response.rawPayload);
    expect([image.width, image.height]).toEqual([128, 128]);
    const grey = image.pixel(64, 64);
    expect(
      Math.abs(grey.r - 204) < 8 && Math.abs(grey.g - 204) < 8 && Math.abs(grey.b - 204) < 8,
    ).toBe(true);
    expect(await storage.statDerived(info.hash, thumbnailDerivedName(128, "cover"))).toBeNull();
  });
});

describe("thumbnail building blocks", () => {
  it("makes a grey WebP placeholder of about 90 bytes per size, cached", async () => {
    for (const size of THUMBNAIL_SIZES) {
      const bytes = await thumbnailPlaceholder(size);
      expect(bytes.length).toBeLessThan(200);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
      const image = await decode(bytes);
      expect([image.width, image.height]).toEqual([size, size]);
    }
    expect(await thumbnailPlaceholder(64)).toBe(await thumbnailPlaceholder(64));
  });

  it("renderThumbnail: unsupported type, missing blob, broken bytes, pdftoppm missing", async () => {
    await expect(
      renderThumbnail(storage, { hash: "a".repeat(64), mimeType: "text/plain" }, 64, "cover"),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      renderThumbnail(storage, { hash: "b".repeat(64), mimeType: "image/png" }, 64, "cover"),
    ).rejects.toMatchObject({ code: "blob_missing" });
    const { Readable } = await import("node:stream");
    const broken = await storage.put(Readable.from([brokenPngFixture()]));
    const failure = await renderThumbnail(
      storage,
      { hash: broken.hash, mimeType: "image/png" },
      64,
      "cover",
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ThumbnailError);
    expect((failure as ThumbnailError).code).toBe("render_failed");
    const pdf = await storage.put(Readable.from([pdfFixture()]));
    const noTool = await renderThumbnail(
      storage,
      { hash: pdf.hash, mimeType: "application/pdf" },
      64,
      "cover",
      { pdftoppm: "/nonexistent/pdftoppm" },
    ).catch((e: unknown) => e);
    expect((noTool as ThumbnailError).code).toBe("render_failed");
    expect((noTool as ThumbnailError).message).toContain("not installed");
  });

  it("shortError keeps one short line without paths", () => {
    expect(shortError(new Error("Input file /tmp/vola-thumb-x/in.pdf is broken"))).toBe(
      "Error: Input file <path> is broken",
    );
    expect(shortError("x".repeat(600)).length).toBe(500);
    expect(shortError(new TypeError("a\nb   c"))).toBe("TypeError: a b c");
  });

  it("resolveJobsMode: auto follows Redis, 1 without Redis is one ERROR and sync, 0 is sync", () => {
    const lines: string[] = [];
    const log = {
      info: (_o: unknown, msg?: string) => void lines.push(`info ${msg}`),
      error: (_o: unknown, msg?: string) => void lines.push(`error ${msg}`),
    };
    expect(resolveJobsMode({ enabled: "auto", redisUrl: "redis://x", log })).toBe("async");
    expect(lines).toEqual([]);
    expect(resolveJobsMode({ enabled: "auto", redisUrl: null, log })).toBe("sync");
    expect(lines).toEqual(["info background jobs disabled"]);
    expect(resolveJobsMode({ enabled: true, redisUrl: null, log })).toBe("sync");
    expect(lines.at(-1)).toBe("error background jobs misconfigured: running synchronously");
    expect(resolveJobsMode({ enabled: true, redisUrl: "redis://x", log })).toBe("async");
    expect(resolveJobsMode({ enabled: false, redisUrl: "redis://x", log })).toBe("sync");
    expect(lines.at(-1)).toBe("info background jobs disabled");
  });
});
