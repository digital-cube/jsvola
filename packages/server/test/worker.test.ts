import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInfoSchema, THUMBNAIL_SIZES, thumbnailDerivedName } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files, processingJobs } from "../src/db/schema.js";
import { type FileEvent, LocalFileEventBus } from "../src/events/bus.js";
import { QueuedJobDispatcher } from "../src/jobs/dispatcher.js";
import { ProcessingQueue } from "../src/jobs/queue.js";
import { ProcessingWorker } from "../src/jobs/worker.js";
import { listProcessingJobs, processingStatusOf } from "../src/services/processing.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import {
  brokenPngFixture,
  decode,
  isBlue,
  isRed,
  pdfFixture,
  pngFixture,
  waitFor,
} from "./fixtures.js";
import { config, type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

/**
 * The async path end to end: the server queues jobs on a private BullMQ prefix of the test
 * Redis, a REAL `ProcessingWorker` in this process consumes them, and the `processing` events
 * go through one in-process bus both sides share.
 */
const handle = testDatabase(6);
let fx: Fixture;
let app: FastifyInstance;
let http: ReturnType<typeof httpClient>;
let root: string;
let storage: FilesystemBackend;
let queue: ProcessingQueue;
let worker: ProcessingWorker;
let events: LocalFileEventBus;
let otherKey: string;

const TYPE = "tickets";
const prefix = `vola-test-${randomUUID().slice(0, 8)}`;
const redisUrl = config.redisUrl as string;

beforeAll(async () => {
  expect(redisUrl, "VOLA_REDIS_URL is needed for the worker suite").toBeTruthy();
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-worker-"));
  storage = new FilesystemBackend(root);
  events = new LocalFileEventBus();
  queue = new ProcessingQueue({ redisUrl, prefix, backoffMs: 20 });
  // OCR (4.2) is exercised by ocr.test.ts; this suite counts THUMBNAIL rows and events only.
  fx = await setupFixture(handle, {
    config: { ...config, ocr: { ...config.ocr, enabled: false } },
    storage,
    events,
    jobs: queue,
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  worker = new ProcessingWorker({
    redisUrl,
    prefix,
    concurrency: 2,
    db: handle.db,
    storage,
    events,
    jobTimeoutMs: 20_000,
  });
  await worker.ready();
  const tenant = await createTenant(handle.db, { slug: "other" });
  otherKey = (await mintKey(handle, tenant.id, "other", "live", ["files:read", "files:write"])).key;
});
afterAll(async () => {
  await worker.close();
  await app.close();
  await queue.queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

async function uploaded(data: Buffer, filename: string, contentType?: string) {
  const { response, instanceId } = await http.upload(data, filename, { contentType });
  expect(response.statusCode, response.body).toBe(201);
  const info = FileInfoSchema.parse(response.json());
  return { info, instanceId, url: `/vola/files/${TYPE}/${instanceId}/${info.id}` };
}

const settled = (fileId: string) =>
  waitFor(
    async () => {
      const jobs = await listProcessingJobs(handle.db, fileId);
      return jobs.length > 0 && jobs.every((j) => j.status === "DONE" || j.status === "FAILED")
        ? jobs
        : null;
    },
    { label: `jobs of ${fileId}`, timeoutMs: 30_000 },
  );

describe("processing jobs through the worker", () => {
  it("queues 4 THUMBNAIL jobs for a PNG, the worker renders them, the aggregate goes PENDING → DONE", async () => {
    const received: FileEvent[] = [];
    const unsubscribe = await events.subscribe(fx.tenant.id, (event) => void received.push(event));
    const { info, url } = await uploaded(await pngFixture(), "photo.png");
    expect(info.processing_status).toBe("PENDING");
    const jobs = await settled(info.id);
    expect(jobs.map((j) => j.kind)).toEqual(["THUMBNAIL", "THUMBNAIL", "THUMBNAIL", "THUMBNAIL"]);
    expect(jobs.map((j) => (j.params as { size: number }).size).sort((a, b) => a - b)).toEqual([
      64, 128, 256, 512,
    ]);
    for (const job of jobs) {
      expect(job.status).toBe("DONE");
      expect(job.attempts).toBe(1);
      expect(job.error).toBeNull();
      expect(job.startedAt).toBeInstanceOf(Date);
      expect(job.finishedAt).toBeInstanceOf(Date);
      expect(job.tenantId).toBe(fx.tenant.id);
      expect((job.params as { crop: string }).crop).toBe("cover");
    }
    for (const size of THUMBNAIL_SIZES) {
      expect(
        await storage.statDerived(info.hash, thumbnailDerivedName(size, "cover")),
      ).not.toBeNull();
    }
    expect(await processingStatusOf(handle.db, info.id)).toBe("DONE");
    expect((await http.get(`${url}/info`)).json().processing_status).toBe("DONE");
    // The worker announced each outcome on the bus: the subscriber saw `processing` events.
    const processing = received.filter((e) => e.kind === "processing" && e.fileId === info.id);
    expect(processing.length).toBe(4);
    expect(processing[0]).toMatchObject({
      tenantId: fx.tenant.id,
      instanceType: TYPE,
      instanceId: info.instance_id,
      folderId: null,
    });
    await unsubscribe();
    // Now a plain 200 ready.
    const ready = await http.get(`${url}/thumb/256`);
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["x-thumbnail-status"]).toBe("ready");
    const image = await decode(ready.rawPayload);
    expect(isRed(image.pixel(64, 128)) && isBlue(image.pixel(192, 128))).toBe(true);
  });

  it("answers 202 with a grey placeholder while the worker renders, then 200", async () => {
    // A rendition no upload queues (crop=fit): the first GET is a miss.
    const { info, url } = await uploaded(await pngFixture(), "photo.png");
    await settled(info.id);
    const first = await http.get(`${url}/thumb/128?crop=fit`);
    expect(first.statusCode).toBe(202);
    expect(first.headers["content-type"]).toBe("image/webp");
    expect(first.headers["x-thumbnail-status"]).toBe("generating");
    expect(first.headers["cache-control"]).toBe("no-cache");
    expect(first.headers.etag).toBeUndefined();
    expect(first.rawPayload.length).toBeLessThan(200);
    const placeholder = await decode(first.rawPayload);
    expect([placeholder.width, placeholder.height]).toEqual([128, 128]);
    // The job row exists for that rendition (and a HEAD miss queues too, body-less).
    const head = await http.head(`${url}/thumb/64?crop=fit`);
    expect(head.statusCode).toBe(202);
    expect(head.body).toBe("");
    const rows = await listProcessingJobs(handle.db, info.id);
    expect(rows.filter((j) => (j.params as { crop: string }).crop === "fit")).toHaveLength(2);
    const ready = await waitFor(
      async () => {
        const response = await http.get(`${url}/thumb/128?crop=fit`);
        return response.statusCode === 200 ? response : null;
      },
      { label: "thumbnail ready", timeoutMs: 30_000 },
    );
    expect(ready.headers["x-thumbnail-status"]).toBe("ready");
    expect(ready.headers["cache-control"]).toBe("private, max-age=86400");
    expect(ready.headers.etag).toBe(`"${info.hash}.thumb-128-fit.webp"`);
    // Both `fit` jobs settle; nothing beyond the 4 + 2 rows was ever added.
    const all = await settled(info.id);
    expect(all.length).toBe(6);
    expect((await http.get(`${url}/info`)).json().processing_status).toBe("DONE");
  });

  it("renders the first page of a PDF in the worker", async () => {
    const { info, url } = await uploaded(pdfFixture(), "doc.pdf", "application/pdf");
    expect(info.processing_status).toBe("PENDING");
    const jobs = await settled(info.id);
    expect(jobs.every((j) => j.status === "DONE")).toBe(true);
    const response = await http.get(`${url}/thumb/128`);
    expect(response.statusCode).toBe(200);
    const page = await decode(response.rawPayload);
    // cover of a 200×100 red|white page: the middle square, red on the left.
    expect(isRed(page.pixel(16, 64))).toBe(true);
  });

  it("creates no job for a text file; its processing_status stays empty", async () => {
    const { info, url } = await uploaded(Buffer.from("plain"), "note.txt");
    expect(info.processing_status).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await listProcessingJobs(handle.db, info.id)).toEqual([]);
    expect((await http.get(`${url}/info`)).json().processing_status).toBeNull();
    expect((await http.get(`${url}/thumb/64`)).statusCode).toBe(404);
  });

  it("marks a broken image FAILED after 3 attempts, with a short error and the aggregate FAILED", async () => {
    const received: FileEvent[] = [];
    const unsubscribe = await events.subscribe(fx.tenant.id, (event) => void received.push(event));
    const { info, url } = await uploaded(brokenPngFixture(), "broken.png");
    const jobs = await settled(info.id);
    await unsubscribe();
    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      expect(job.status).toBe("FAILED");
      expect(job.attempts).toBe(3);
      expect(job.error).toMatch(/^ThumbnailError: rendering failed/);
      expect(job.error).not.toContain("broken.png");
      expect(job.error?.length ?? 0).toBeLessThanOrEqual(500);
      expect(job.finishedAt).toBeInstanceOf(Date);
    }
    expect(await processingStatusOf(handle.db, info.id)).toBe("FAILED");
    expect((await http.get(`${url}/info`)).json().processing_status).toBe("FAILED");
    // Every try announced itself: 4 jobs × 3 tries.
    expect(received.filter((e) => e.kind === "processing" && e.fileId === info.id).length).toBe(12);
    // The UDC row carries the aggregate too.
    const list = await app.inject({
      method: "POST",
      url: "/vola/udc/list",
      headers: { authorization: `Bearer ${fx.full.key}`, "x-udc-message-id": "m1" },
      payload: {
        collection: "files",
        filter: {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "instance_id", op: "eq", value: info.instance_id },
          ],
        },
      },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().payload.rows[0].processing_status).toBe("FAILED");
    // A FAILED rendition asked for again is refreshed and queued once more → 202, then FAILED again.
    const retry = await http.get(`${url}/thumb/64`);
    expect(retry.statusCode).toBe(202);
    const firstRun = jobs[0]?.createdAt ?? new Date(0);
    const row = await waitFor(
      async () => {
        const [j] = (await listProcessingJobs(handle.db, info.id)).filter(
          (j) => (j.params as { size: number }).size === 64,
        );
        return j && j.status === "FAILED" && j.createdAt > firstRun ? j : null;
      },
      { label: "retried job", timeoutMs: 30_000 },
    );
    expect(row.attempts).toBe(3);
    expect((await listProcessingJobs(handle.db, info.id)).length).toBe(4); // refreshed, not added
  });

  it("skips a job of a file that became encrypted and keeps the aggregate clean", async () => {
    const { info } = await uploaded(await pngFixture(), "secret.png");
    await settled(info.id);
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, info.id));
    const dispatcher = new QueuedJobDispatcher({ db: handle.db, queue });
    await dispatcher.requestThumbnail(
      { id: info.id, tenantId: fx.tenant.id, mimeType: "image/png", encryption: "none" },
      64,
      "attention",
    );
    const skipped = await waitFor(
      async () => {
        const [j] = (await listProcessingJobs(handle.db, info.id)).filter(
          (j) => (j.params as { crop: string }).crop === "attention",
        );
        return j && j.status === "SKIPPED" ? j : null;
      },
      { label: "skipped job" },
    );
    expect(skipped.error).toBe("encrypted file");
    expect(await processingStatusOf(handle.db, info.id)).toBe("DONE"); // SKIPPED is ignored
  });

  it("drops a job whose file was purged meanwhile", async () => {
    const { info, url } = await uploaded(await pngFixture(), "gone.png");
    await settled(info.id);
    const dispatcher = new QueuedJobDispatcher({ db: handle.db, queue });
    // Pause the worker's view: queue a job, purge the file, let the worker find nothing.
    await dispatcher.requestThumbnail(
      { id: info.id, tenantId: fx.tenant.id, mimeType: "image/png", encryption: "none" },
      512,
      "fit",
    );
    const purge = await http.del(`${url}/purge`);
    expect(purge.statusCode).toBe(200);
    await waitFor(
      async () =>
        (await queue.queue.getJobCounts("waiting", "active", "delayed")).waiting === 0
          ? true
          : null,
      {
        label: "queue drained",
      },
    );
    expect(
      await handle.db.select().from(processingJobs).where(eq(processingJobs.fileId, info.id)),
    ).toEqual([]); // cascaded with the file
  });

  it("keeps another tenant out, and the sweep job runs through the worker", async () => {
    const { url } = await uploaded(await pngFixture(), "photo.png");
    const foreign = await http.get(`${url}/thumb/64`, {}, otherKey);
    expect(foreign.statusCode).toBe(404);
    // The repeatable sweep: scheduled by the plugin in async mode (here with a short period),
    // consumed by the worker as a `sweep-uploads` job.
    await queue.scheduleUploadSweep(200);
    const schedulers = await queue.queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.key ?? schedulers[0]?.id).toContain("sweep-uploads");
    await waitFor(
      async () => {
        // Completed sweep jobs are removed on completion; what we can see is the scheduler
        // moving on to its next iteration.
        const [current] = await queue.queue.getJobSchedulers();
        return current && (current.next ?? 0) > Date.now() ? current : null;
      },
      { label: "sweep iteration scheduled" },
    );
    await queue.unscheduleUploadSweep();
    expect(await queue.queue.getJobSchedulers()).toEqual([]);
  });
});
