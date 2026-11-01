import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Row } from "@jsudc/core";
import { FileDetailSchema, OCR_PAGE_SEPARATOR } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "../src/context.js";
import { type FileRow, files } from "../src/db/schema.js";
import { type FileEvent, LocalFileEventBus } from "../src/events/bus.js";
import { QueuedJobDispatcher } from "../src/jobs/dispatcher.js";
import { ProcessingQueue } from "../src/jobs/queue.js";
import { ProcessingWorker } from "../src/jobs/worker.js";
import { findFileMetadata, OcrSetupError, probeTesseract } from "../src/services/ocr.js";
import { listProcessingJobs } from "../src/services/processing.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { FilesCollectionSource } from "../src/udc/files-source.js";
import { pngFixture, waitFor } from "./fixtures.js";
import { bearer, config, type Fixture, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

/**
 * OCR through the worker (plan 4.2). The first block needs a real `tesseract` (and
 * `pdftoppm`) and is skipped without one — CI installs both; the second runs everywhere
 * with shell scripts standing in for the tools.
 */
const handle = testDatabase(8);
let fx: Fixture;
let app: FastifyInstance;
let http: ReturnType<typeof httpClient>;
let root: string;
let storage: FilesystemBackend;
let queue: ProcessingQueue;
let worker: ProcessingWorker;
let events: LocalFileEventBus;
let scripts: string;
const extraQueues: ProcessingQueue[] = [];
const extraWorkers: ProcessingWorker[] = [];

const TYPE = "tickets";
const prefix = `vola-ocr-${randomUUID().slice(0, 8)}`;
const redisUrl = config.redisUrl as string;
const tesseract = await probeTesseract().catch(() => null);
const hasTesseract = tesseract !== null;

/** A white PNG with `text` in black, big enough for tesseract to read. */
async function textImage(text: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
  <rect width="100%" height="100%" fill="white"/>
  <text x="40" y="130" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="80" fill="black">${text}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A PDF with one line of Helvetica text per page (poppler substitutes a system font). */
function textPdf(pages: string[]): Buffer {
  // 1 catalog, 2 pages, then a (page, content) pair per page, the font object last.
  const fontObject = 3 + 2 * pages.length;
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  pages.forEach((text, i) => {
    const page = 3 + 2 * i;
    const content = `BT /F1 32 Tf 80 140 Td (${text}) Tj ET`;
    kids.push(`${page} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 300] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${page + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function script(name: string, body: string): Promise<string> {
  const path = join(scripts, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** A fake tesseract: answers the probe with `langs`, then runs `body` for any OCR call. */
const fakeTesseract = (name: string, langs: string[], body: string) =>
  script(
    name,
    `case "$1" in
  --version) echo "tesseract 9.9-fake"; exit 0;;
  --list-langs) echo "List of available languages (${langs.length}):"; ${langs.map((l) => `echo ${l};`).join(" ")} exit 0;;
esac
${body}`,
  );

async function uploaded(data: Buffer, filename: string, contentType?: string) {
  const { response, instanceId } = await http.upload(data, filename, { contentType });
  expect(response.statusCode, response.body).toBe(201);
  const info = response.json() as { id: string; hash: string; processing_status: string | null };
  return { info, instanceId, url: `/vola/files/${TYPE}/${instanceId}/${info.id}` };
}

/** A file row without going through an upload (so no dispatcher saw it). */
async function seedFile(
  bytes: Buffer,
  mimeType: string,
  encryption = "none",
  filename = "seed.bin",
): Promise<FileRow> {
  const staged = await storage.stage(Readable.from(bytes));
  await storage.commit(staged);
  const [row] = await handle.db
    .insert(files)
    .values({
      tenantId: fx.tenant.id,
      instanceType: TYPE,
      instanceId: randomUUID(),
      hash: staged.hash,
      size: bytes.length,
      filename,
      mimeType,
      kind: mimeType.startsWith("image/") ? "image" : "document",
      encryption,
    })
    .returning();
  return row as FileRow;
}

const ocrJob = (fileId: string) =>
  listProcessingJobs(handle.db, fileId).then((jobs) => jobs.find((j) => j.kind === "OCR") ?? null);

const ocrSettled = (fileId: string, timeoutMs = 60_000) =>
  waitFor(
    async () => {
      const job = await ocrJob(fileId);
      return job && ["DONE", "FAILED", "SKIPPED"].includes(job.status) ? job : null;
    },
    { label: `OCR job of ${fileId}`, timeoutMs },
  );

async function udcList(filter: unknown, key = fx.full.key) {
  const response = await app.inject({
    method: "POST",
    url: "/vola/udc/list",
    headers: { ...bearer(key), "x-udc-message-id": "m1" },
    payload: { collection: "files", filter, page: { limit: 50 } },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    kind: string;
    payload: { rows: Row[]; total: number; code?: string; message?: string };
  };
}
const inType = (...more: unknown[]) => ({
  and: [{ field: "instance_type", op: "eq", value: TYPE }, ...more],
});

beforeAll(async () => {
  expect(redisUrl, "VOLA_REDIS_URL is needed for the OCR suite").toBeTruthy();
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-ocr-suite-"));
  scripts = join(root, "bin");
  await mkdir(scripts);
  storage = new FilesystemBackend(join(root, "storage"));
  events = new LocalFileEventBus();
  queue = new ProcessingQueue({ redisUrl, prefix, backoffMs: 20 });
  // VOLA_OCR_ENABLED=auto (the default): the server queues OCR jobs, the worker decides.
  fx = await setupFixture(handle, {
    storage,
    events,
    jobs: queue,
    uploadSweepIntervalMs: 0,
    statsRefreshIntervalMs: 0,
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
    ocr: { ...config.ocr, enabled: "auto", timeoutS: 60 },
  });
  await worker.ready();
});
afterAll(async () => {
  await worker.close();
  for (const w of extraWorkers) await w.close();
  await app.close();
  for (const q of [queue, ...extraQueues]) {
    await q.queue.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
  await handle.close();
  await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!hasTesseract)("OCR with tesseract", () => {
  it("the worker found tesseract and the configured languages", () => {
    expect(worker.ocrAvailability()).toMatchObject({ enabled: true, langs: config.ocr.langs });
  });

  it("reads the text of a PNG: one OCR job, the sidecar row, the info block, a processing event", async () => {
    const received: FileEvent[] = [];
    const unsubscribe = await events.subscribe(fx.tenant.id, (event) => void received.push(event));
    const { info, url } = await uploaded(await textImage("HELLO VOLA"), "hello.png");
    expect(info.processing_status).toBe("PENDING");
    const jobs = await listProcessingJobs(handle.db, info.id);
    expect(jobs.map((j) => j.kind).sort()).toEqual([
      "OCR",
      "THUMBNAIL",
      "THUMBNAIL",
      "THUMBNAIL",
      "THUMBNAIL",
    ]);
    const job = await ocrSettled(info.id);
    expect(job.status).toBe("DONE");
    expect(job.attempts).toBe(1);
    expect(job.params).toEqual({});
    const meta = await findFileMetadata(handle.db, info.id);
    expect(meta).not.toBeNull();
    expect(meta?.ocrText?.toUpperCase()).toContain("HELLO");
    expect(meta?.ocrLang).toBe(config.ocr.langs.join("+"));
    expect(meta?.ocrPages).toBe(1);
    expect(meta?.ocrAt).toBeInstanceOf(Date);
    expect(meta?.tenantId).toBe(fx.tenant.id);
    // `…/info`: the preview, no full text; `?ocr=full`: the text.
    const detail = FileDetailSchema.parse((await http.get(`${url}/info`)).json());
    expect(detail.ocr).toEqual({
      status: "DONE",
      lang: config.ocr.langs.join("+"),
      pages: 1,
      text_preview: meta?.ocrText?.slice(0, 500),
    });
    expect(detail.ocr.text).toBeUndefined();
    const full = FileDetailSchema.parse((await http.get(`${url}/info?ocr=full`)).json());
    expect(full.ocr.text).toBe(meta?.ocrText);
    await waitFor(async () => (await http.get(`${url}/info`)).json().processing_status === "DONE", {
      label: "thumbnails done",
    });
    await unsubscribe();
    // 4 thumbnails + 1 OCR, each announced.
    expect(received.filter((e) => e.kind === "processing" && e.fileId === info.id).length).toBe(5);
  }, 60_000);

  it("reads a 2-page PDF page by page: pages = 2, the texts joined with \\f", async () => {
    const { info, url } = await uploaded(textPdf(["INVOICE ALPHA", "SECOND PAGE"]), "two.pdf");
    const job = await ocrSettled(info.id);
    expect(job.status, job.error ?? "").toBe("DONE");
    const meta = await findFileMetadata(handle.db, info.id);
    expect(meta?.ocrPages).toBe(2);
    const pages = (meta?.ocrText ?? "").split(OCR_PAGE_SEPARATOR);
    expect(pages.length).toBe(2);
    expect(pages[0]?.toUpperCase()).toContain("INVOICE");
    expect(pages[1]?.toUpperCase()).toContain("SECOND");
    const detail = FileDetailSchema.parse((await http.get(`${url}/info`)).json());
    expect(detail.ocr.pages).toBe(2);
  }, 60_000);

  it("the UDC files collection: `ocr` is yes/no in the row and a full-text filter", async () => {
    const hello = await uploaded(await textImage("ZEBRA CROSSING"), "zebra.png");
    const plain = await uploaded(Buffer.from("just text"), "notes.txt", "text/plain");
    await ocrSettled(hello.info.id);
    const found = await udcList(inType({ field: "ocr", op: "contains", value: "zebra" }));
    expect(found.payload.total).toBe(1);
    expect(found.payload.rows.map((r) => r.id)).toEqual([hello.info.id]);
    expect(found.payload.rows[0]?.ocr).toBe(true);
    // `simple`: case does not matter, word order does not matter, every word must be there.
    expect(
      (await udcList(inType({ field: "ocr", op: "eq", value: "Crossing ZEBRA" }))).payload.total,
    ).toBe(1);
    expect(
      (await udcList(inType({ field: "ocr", op: "contains", value: "zebra unicorn" }))).payload
        .total,
    ).toBe(0);
    expect((await udcList(inType({ field: "ocr", op: "contains", value: "" }))).payload.total).toBe(
      0,
    );
    // The flag: with / without text.
    const withText = await udcList(inType({ field: "ocr", op: "eq", value: true }));
    expect(withText.payload.rows.map((r) => r.id)).toContain(hello.info.id);
    expect(withText.payload.rows.map((r) => r.id)).not.toContain(plain.info.id);
    const without = await udcList(inType({ field: "ocr", op: "is_null", value: null }));
    expect(without.payload.rows.map((r) => r.id)).toContain(plain.info.id);
    expect(without.payload.rows.map((r) => r.id)).not.toContain(hello.info.id);
    const notZebra = await udcList(inType({ field: "ocr", op: "neq", value: "zebra" }));
    expect(notZebra.payload.rows.map((r) => r.id)).toContain(plain.info.id);
    expect(notZebra.payload.rows.map((r) => r.id)).not.toContain(hello.info.id);
    const plainRow = (await udcList(inType({ field: "id", op: "eq", value: plain.info.id })))
      .payload.rows[0];
    expect(plainRow?.ocr).toBe(false);
    // Not an op of the field.
    const bad = await udcList(inType({ field: "ocr", op: "gt", value: "x" }));
    expect(bad.kind).toBe("udc.list.err");
    expect(bad.payload.code).toBe("validation_error");
  }, 60_000);

  it("a live subscription with an OCR text filter gets the row once its text is in", async () => {
    const source = new FilesCollectionSource({ db: handle.db, prefix: "/vola", events });
    const upserts: Row[] = [];
    const context = {
      tenantId: fx.tenant.id,
      tenantSlug: fx.tenant.slug,
      apiKeyId: fx.full.apiKey.id,
      apiKeyLabel: "vola_test…abcd",
      scopes: ["files:read" as const],
      isAdmin: false,
      userId: null,
      unlockToken: null,
      contentKey: null,
      browserOrigin: null,
    };
    const subscription = await runWithTenant(context, () =>
      source.subscribe(inType({ field: "ocr", op: "contains", value: "pelican" }) as never, {
        upsert: (row) => void upserts.push(row),
        remove: () => undefined,
      }),
    );
    try {
      const { info } = await uploaded(await textImage("PELICAN BAY"), "pelican.png");
      await ocrSettled(info.id);
      await waitFor(
        async () => {
          await source.idle();
          return upserts.find((r) => r.id === info.id) ?? null;
        },
        { label: "live upsert after OCR" },
      );
      expect(upserts.find((r) => r.id === info.id)?.ocr).toBe(true);
    } finally {
      await subscription.close();
    }
  }, 60_000);
});

describe("OCR without tesseract (scripts stand in for the tools)", () => {
  it("VOLA_OCR_ENABLED=0: no OCR job after an upload (thumbnails as before)", async () => {
    const off = new ProcessingQueue({ redisUrl, prefix: `${prefix}-off`, backoffMs: 20 });
    extraQueues.push(off);
    const dispatcher = new QueuedJobDispatcher({ db: handle.db, queue: off, ocr: false });
    const png = await seedFile(await pngFixture(), "image/png");
    expect(await dispatcher.afterUpload(png)).toBe("PENDING");
    const jobs = await listProcessingJobs(handle.db, png.id);
    expect(jobs.map((j) => j.kind)).toEqual(["THUMBNAIL", "THUMBNAIL", "THUMBNAIL", "THUMBNAIL"]);
  });

  it("an encrypted file, a GIF, an SVG or a text file never gets an OCR job", async () => {
    const q = new ProcessingQueue({ redisUrl, prefix: `${prefix}-elig`, backoffMs: 20 });
    extraQueues.push(q);
    const dispatcher = new QueuedJobDispatcher({ db: handle.db, queue: q, ocr: true });
    expect(dispatcher.ocr).toBe(true);
    const encrypted = await seedFile(await pngFixture(), "image/png", "keyring");
    expect(await dispatcher.afterUpload(encrypted)).toBeNull();
    expect(await listProcessingJobs(handle.db, encrypted.id)).toEqual([]);
    const gif = await seedFile(Buffer.from("GIF89a"), "image/gif");
    await dispatcher.afterUpload(gif);
    expect((await listProcessingJobs(handle.db, gif.id)).map((j) => j.kind)).not.toContain("OCR");
    const svg = await seedFile(Buffer.from("<svg/>"), "image/svg+xml");
    expect(await dispatcher.afterUpload(svg)).toBeNull();
    const text = await seedFile(Buffer.from("hi"), "text/plain");
    expect(await dispatcher.afterUpload(text)).toBeNull();
    // Eligible: one OCR row, `params` {}, asked twice → still one row.
    const png = await seedFile(await pngFixture(), "image/png");
    await dispatcher.afterUpload(png);
    await dispatcher.requestOcr(png);
    const ocr = (await listProcessingJobs(handle.db, png.id)).filter((j) => j.kind === "OCR");
    expect(ocr.length).toBe(1);
    expect(ocr[0]?.status).toBe("PENDING");
  });

  it("a page past VOLA_OCR_TIMEOUT_S fails the try; FAILED after the 3rd, the error short and without paths", async () => {
    const slow = await fakeTesseract("tesseract-slow", ["eng", "srp", "deu"], "sleep 30");
    const q = new ProcessingQueue({ redisUrl, prefix: `${prefix}-slow`, backoffMs: 20 });
    extraQueues.push(q);
    const w = new ProcessingWorker({
      redisUrl,
      prefix: `${prefix}-slow`,
      db: handle.db,
      storage,
      events,
      ocr: { enabled: true, langs: ["eng"], maxPages: 20, timeoutS: 0.3, tesseract: slow },
    });
    extraWorkers.push(w);
    await w.ready();
    expect(w.ocrAvailability()).toEqual({
      enabled: true,
      version: "tesseract 9.9-fake",
      langs: ["eng"],
    });
    const dispatcher = new QueuedJobDispatcher({ db: handle.db, queue: q, ocr: true });
    const png = await seedFile(await pngFixture(), "image/png", "none", "slow.png");
    const received: FileEvent[] = [];
    const unsubscribe = await events.subscribe(fx.tenant.id, (event) => void received.push(event));
    await dispatcher.requestOcr(png);
    const job = await ocrSettled(png.id, 30_000);
    expect(job.status).toBe("FAILED");
    expect(job.attempts).toBe(3);
    expect(job.error).toBe("OcrError: tesseract-slow exceeded 300 ms");
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(await findFileMetadata(handle.db, png.id)).toBeNull();
    await unsubscribe();
    expect(received.filter((e) => e.kind === "processing" && e.fileId === png.id).length).toBe(3);
    const detail = await app.inject({
      method: "GET",
      url: `/vola/files/${TYPE}/${png.instanceId}/${png.id}/info`,
      headers: bearer(fx.full.key),
    });
    expect(detail.json().ocr).toEqual({
      status: "FAILED",
      lang: null,
      pages: null,
      text_preview: null,
    });

    // The same worker skips a file that was encrypted meanwhile under a key it does not hold — before any tool runs.
    const enc = await seedFile(await pngFixture(), "image/png", "none", "enc.png");
    await handle.db.update(files).set({ encryption: "keyring" }).where(eq(files.id, enc.id));
    await dispatcher.requestOcr({ ...enc, encryption: "keyring" });
    const skipped = await ocrSettled(enc.id);
    expect(skipped.status).toBe("SKIPPED");
    expect(skipped.error).toBe("encrypted under a key the worker does not hold");
  }, 30_000);

  it("a worker with OCR off, or in auto mode without tesseract, skips the job with the reason", async () => {
    const q = new ProcessingQueue({ redisUrl, prefix: `${prefix}-skip`, backoffMs: 20 });
    extraQueues.push(q);
    const off = new ProcessingWorker({
      redisUrl,
      prefix: `${prefix}-skip`,
      db: handle.db,
      storage,
      events,
      ocr: { enabled: false, langs: ["eng"], maxPages: 20, timeoutS: 10 },
    });
    extraWorkers.push(off);
    await off.ready();
    expect(off.ocrAvailability()).toEqual({ enabled: false, reason: "OCR disabled" });
    const dispatcher = new QueuedJobDispatcher({ db: handle.db, queue: q, ocr: true });
    const png = await seedFile(await pngFixture(), "image/png");
    await dispatcher.requestOcr(png);
    const job = await ocrSettled(png.id);
    expect(job.status).toBe("SKIPPED");
    expect(job.error).toBe("OCR disabled");
    await off.close();
    extraWorkers.splice(extraWorkers.indexOf(off), 1);

    const missing = join(scripts, "tesseract-missing");
    const auto = new ProcessingWorker({
      redisUrl,
      prefix: `${prefix}-skip`,
      db: handle.db,
      storage,
      events,
      ocr: { enabled: "auto", langs: ["eng"], maxPages: 20, timeoutS: 10, tesseract: missing },
    });
    extraWorkers.push(auto);
    await auto.ready();
    expect(auto.ocrAvailability()).toEqual({
      enabled: false,
      reason: "tesseract is not installed",
    });
    const png2 = await seedFile(await pngFixture(), "image/png", "none", "two.png");
    await dispatcher.requestOcr(png2);
    const job2 = await ocrSettled(png2.id);
    expect(job2.status).toBe("SKIPPED");
    expect(job2.error).toBe("tesseract is not installed");
  }, 30_000);

  it("refuses to start when OCR is insisted on without tesseract, or a language is not installed", async () => {
    const insist = new ProcessingWorker({
      redisUrl,
      prefix: `${prefix}-refuse`,
      db: handle.db,
      storage,
      ocr: {
        enabled: true,
        langs: ["eng", "srp"],
        maxPages: 20,
        timeoutS: 10,
        tesseract: join(scripts, "tesseract-missing"),
      },
    });
    await expect(insist.ready()).rejects.toThrow(OcrSetupError);
    await expect(insist.ready()).rejects.toThrow(
      /VOLA_OCR_ENABLED is on but tesseract is not installed \(.*tesseract-missing\): install tesseract-ocr \(with the eng, srp data\) or set VOLA_OCR_ENABLED=auto\|0/,
    );
    await insist.close();

    const noSrp = await fakeTesseract("tesseract-eng-only", ["eng", "osd"], "exit 0");
    for (const enabled of ["auto", true] as const) {
      const w = new ProcessingWorker({
        redisUrl,
        prefix: `${prefix}-refuse`,
        db: handle.db,
        storage,
        ocr: {
          enabled,
          langs: ["eng", "srp", "deu"],
          maxPages: 20,
          timeoutS: 10,
          tesseract: noSrp,
        },
      });
      await expect(w.ready()).rejects.toThrow(
        "OCR languages not installed in tesseract: srp, deu (installed: eng, osd; VOLA_OCR_LANGS=eng+srp+deu)",
      );
      await w.close();
    }
  });
});
