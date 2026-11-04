import {
  DEFAULT_ENC_INLINE_DERIVE_MAX_BYTES as DEFAULT_ENC_DERIVE_MAX,
  type ProcessingStatus,
} from "@vol-a/core";
import { type Job, UnrecoverableError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { AuditDeliveryError, type AuditSink } from "../audit/memento.js";
import type { Database } from "../db/index.js";
import { type FileRow, files } from "../db/schema.js";
import { VolaError } from "../errors.js";
import { type FileEventBus, publishProcessingStatus } from "../events/bus.js";
import {
  type DerivativesDeps,
  DerivativeTooLargeError,
  derivativeUnrecoverable,
  generateEncryptedThumbnail,
  ocrEncrypted,
} from "../services/derivatives.js";
import type { EncryptionService, OpenedFile } from "../services/encryption.js";
import {
  DEFAULT_PDFTOPPM,
  DEFAULT_TESSERACT,
  extractText,
  OcrError,
  OcrSetupError,
  probeTesseract,
  saveOcrResult,
} from "../services/ocr.js";
import {
  findJob,
  markDone,
  markFailed,
  markRunning,
  markSkipped,
  type ProcessingDeps,
  shortError,
} from "../services/processing.js";
import { refreshStaleStats } from "../services/stats.js";
import {
  DEFAULT_THUMBNAIL_TIMEOUT_MS,
  generateThumbnail,
  ThumbnailError,
} from "../services/thumbnails.js";
import { sweepExpiredUploads, type UploadsDeps } from "../services/uploads.js";
import type { StorageBackend } from "../storage/index.js";
import type { PartStore } from "../uploads/part-store.js";
import {
  AUDIT_JOB,
  type AuditJobData,
  OCR_JOB,
  type OcrJobData,
  PROCESSING_QUEUE,
  type ProcessingJobData,
  queueConnection,
  REFRESH_STATS_JOB,
  SWEEP_UPLOADS_JOB,
  THUMBNAIL_JOB,
  type ThumbnailJobData,
} from "./queue.js";

export const DEFAULT_WORKER_CONCURRENCY = 2;

/** The OCR side of the worker's configuration (`config.ocr` plus the binaries). */
export interface WorkerOcrOptions {
  /**
   * `auto`: run OCR when `tesseract` is installed, skip the jobs otherwise (one WARN line);
   * `true`: refuse to start without it; `false`: skip every `OCR` job.
   */
  enabled: "auto" | boolean;
  /** tesseract's `-l`, every code from the `OcrLanguages` vocabulary; checked against `--list-langs` at start. */
  langs: readonly string[];
  maxPages: number;
  /** Per page (or image). */
  timeoutS: number;
  tesseract?: string | undefined;
  pdftoppm?: string | undefined;
}

/** What the worker found at start: OCR runs, or every `OCR` job is `SKIPPED` with `reason`. */
export type OcrAvailability =
  | { enabled: true; version: string; langs: string[] }
  | { enabled: false; reason: string };

export interface ProcessingWorkerOptions {
  redisUrl: string;
  /** Redis key prefix of the queue; must match the server's. Default `vola`. */
  prefix?: string | undefined;
  /** Jobs run at once in this process (`VOLA_WORKER_CONCURRENCY`). Default 2. */
  concurrency?: number | undefined;
  db: Database;
  storage: StorageBackend;
  /** Where the `processing` event goes after every job (the real-time list). */
  events?: FileEventBus | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** What the expired-upload sweep needs; without it `sweep-uploads` jobs are ignored. */
  uploads?: { parts: PartStore; ttlMs: number; maxUploadBytes: number } | undefined;
  /** The statistics refresh (plan 5.1): snapshots older than `ttlMs` are recomputed; without it `refresh-stats` jobs are ignored. */
  stats?: { ttlMs: number } | undefined;
  /** Wall-clock limit of one job. Default 30 s. */
  jobTimeoutMs?: number | undefined;
  /** The `pdftoppm` binary. Default: the one on `PATH`. */
  pdftoppm?: string | undefined;
  /** OCR (plan 4.2). Without it every `OCR` job is `SKIPPED`. */
  ocr?: WorkerOcrOptions | undefined;
  /**
   * Where `audit` jobs are delivered (plan 5.2): the memento sink of `createAuditSink`.
   * Without one — the worker lacks `VOLA_MEMENTO_*` — audit jobs are dropped with one WARN line.
   */
  audit?: AuditSink | undefined;
  /**
   * Encryption (plan 6.3): the `tenant` provider on the key file, so the worker can render
   * the thumbnails and run the OCR of `tenant`-encrypted files (decrypted into memory, the
   * results sealed under the file key). Without it, or for any other encrypted mode, such
   * jobs are `SKIPPED`.
   */
  crypto?: EncryptionService | undefined;
  /** `VOLA_ENC_INLINE_DERIVE_MAX_BYTES`: the largest encrypted file a derivative is made of. Default 25 MiB. */
  encDeriveMaxBytes?: number | undefined;
  now?: (() => Date) | undefined;
}

/** Why an encrypted file's job was skipped (stored in `error`, never a name). */
const SKIP_NO_KEY = "encrypted under a key the worker does not hold";
const SKIP_TOO_LARGE = "encrypted file above VOLA_ENC_INLINE_DERIVE_MAX_BYTES";

/** The second process of `@vol-a/server`: consumes `vola-processing` and records every outcome. */
export class ProcessingWorker {
  readonly worker: Worker<ProcessingJobData>;
  private readonly connection: Redis;
  private readonly options: ProcessingWorkerOptions;
  private readonly deps: ProcessingDeps;
  private ocrState: OcrAvailability = { enabled: false, reason: "OCR not configured" };
  private started: Promise<void> | null = null;
  private warnedNoAudit = false;

  constructor(options: ProcessingWorkerOptions) {
    this.options = options;
    this.deps = { db: options.db, logger: options.logger, now: options.now };
    this.connection = queueConnection(options.redisUrl);
    const log = options.logger;
    this.connection.on("error", (error) => log?.warn({ err: error }, "worker redis error"));
    this.worker = new Worker<ProcessingJobData>(PROCESSING_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      prefix: options.prefix,
      concurrency: options.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
      // A job that hangs past its own timeout is still reaped by the stalled check (the lock
      // is renewed while a job runs, so a long OCR pass is not reaped mid-way).
      lockDuration: (options.jobTimeoutMs ?? DEFAULT_THUMBNAIL_TIMEOUT_MS) + 30_000,
      // Jobs are taken only once `ready()` checked the tools (see `start`).
      autorun: false,
    });
    this.worker.on("error", (error) => log?.error({ err: error }, "worker error"));
    this.worker.on("failed", (job, error) =>
      log?.warn(
        { job: job?.id, name: job?.name, attempt: job?.attemptsMade, err: error },
        "job failed",
      ),
    );
  }

  /**
   * Checks the OCR tools (once), connects, and starts taking jobs. Rejects with an
   * `OcrSetupError` when `ocr.enabled` is `true` and `tesseract` is missing, or when a
   * configured language is not installed — the worker must not start in that case.
   */
  ready(): Promise<void> {
    if (!this.started) {
      this.started = (async () => {
        this.ocrState = await this.checkOcr();
        void this.worker.run();
        await this.worker.waitUntilReady();
      })();
    }
    return this.started;
  }

  /** What `ready()` found about OCR. */
  ocrAvailability(): OcrAvailability {
    return this.ocrState;
  }

  private async checkOcr(): Promise<OcrAvailability> {
    const ocr = this.options.ocr;
    const log = this.options.logger;
    if (!ocr) return { enabled: false, reason: "OCR not configured" };
    if (ocr.enabled === false) {
      log?.info("OCR disabled (VOLA_OCR_ENABLED=0): OCR jobs are skipped");
      return { enabled: false, reason: "OCR disabled" };
    }
    const bin = ocr.tesseract ?? DEFAULT_TESSERACT;
    const probe = await probeTesseract(bin);
    if (!probe) {
      // The reason is stored in `error` of every skipped job: no path in it.
      const reason = "tesseract is not installed";
      if (ocr.enabled === true) {
        throw new OcrSetupError(
          `VOLA_OCR_ENABLED is on but ${reason} (${bin}): install tesseract-ocr (with the ${ocr.langs.join(", ")} data) or set VOLA_OCR_ENABLED=auto|0`,
        );
      }
      log?.warn({ tesseract: bin }, "tesseract not found: OCR jobs are skipped");
      return { enabled: false, reason };
    }
    const missing = probe.langs.length > 0 ? ocr.langs.filter((l) => !probe.langs.includes(l)) : [];
    if (missing.length > 0) {
      throw new OcrSetupError(
        `OCR language${missing.length > 1 ? "s" : ""} not installed in tesseract: ${missing.join(", ")} (installed: ${probe.langs.join(", ")}; VOLA_OCR_LANGS=${ocr.langs.join("+")})`,
      );
    }
    log?.info(
      {
        version: probe.version,
        langs: ocr.langs.join("+"),
        maxPages: ocr.maxPages,
        timeoutS: ocr.timeoutS,
      },
      "OCR enabled",
    );
    return { enabled: true, version: probe.version, langs: [...ocr.langs] };
  }

  private async process(job: Job<ProcessingJobData>): Promise<void> {
    switch (job.name) {
      case THUMBNAIL_JOB:
        return this.thumbnail(job as Job<ThumbnailJobData>);
      case OCR_JOB:
        return this.ocr(job as Job<OcrJobData>);
      case SWEEP_UPLOADS_JOB:
        return this.sweep();
      case REFRESH_STATS_JOB:
        return this.refreshStats();
      case AUDIT_JOB:
        return this.audit(job as Job<AuditJobData>);
      default:
        throw new UnrecoverableError(`unknown job ${job.name}`);
    }
  }

  private async sweep(): Promise<void> {
    const uploads = this.options.uploads;
    if (!uploads) {
      this.options.logger?.debug("sweep-uploads job ignored: no uploads configuration");
      return;
    }
    const deps: UploadsDeps = {
      db: this.options.db,
      storage: this.options.storage,
      parts: uploads.parts,
      maxUploadBytes: uploads.maxUploadBytes,
      ttlMs: uploads.ttlMs,
      logger: this.options.logger,
      events: this.options.events,
      now: this.options.now,
    };
    await sweepExpiredUploads(deps);
  }

  /**
   * One audit event to memento. A retryable failure (memento down, `5xx`, `429`) throws so
   * BullMQ tries again (`AUDIT_MAX_ATTEMPTS`, exponential backoff); one memento refuses for
   * good (`4xx`) is dropped at once. Without a sink in this process the job is dropped too.
   */
  private async audit(job: Job<AuditJobData>): Promise<void> {
    const sink = this.options.audit;
    const log = this.options.logger;
    if (!sink) {
      if (!this.warnedNoAudit) {
        this.warnedNoAudit = true;
        log?.warn(
          "audit jobs arrive but this worker has no memento sink (VOLA_MEMENTO_URL / VOLA_MEMENTO_API_KEY): they are dropped",
        );
      }
      return;
    }
    try {
      await sink.send(job.data);
    } catch (error) {
      const attempt = job.attemptsMade + 1;
      const attempts = job.opts.attempts ?? 1;
      const final =
        attempt >= attempts || (error instanceof AuditDeliveryError && !error.retryable);
      log?.[final ? "warn" : "info"](
        { event: job.data.event_type, instance: job.data.instance_id, attempt, err: error },
        final ? "audit event dropped" : "audit push failed, will retry",
      );
      if (error instanceof AuditDeliveryError && !error.retryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
    log?.debug({ event: job.data.event_type, instance: job.data.instance_id }, "audit event sent");
  }

  /** Recomputes every `vola_tenant_stats` snapshot older than the TTL whose tenant had activity since. */
  private async refreshStats(): Promise<void> {
    const stats = this.options.stats;
    if (!stats) {
      this.options.logger?.debug("refresh-stats job ignored: no stats configuration");
      return;
    }
    await refreshStaleStats(
      { db: this.options.db, logger: this.options.logger, now: this.options.now },
      { ttlMs: stats.ttlMs },
    );
  }

  /**
   * One rendition: the row goes `RUNNING` (attempt n), the thumbnail is rendered next to the
   * blob, the row goes `DONE` — or `PENDING` again for a retry, `FAILED` after the last try —
   * and a `processing` event tells every subscriber the file's aggregate changed.
   */
  private async thumbnail(job: Job<ThumbnailJobData>): Promise<void> {
    const { jobId, size, crop } = job.data;
    const log = this.options.logger;
    const row = await findJob(this.options.db, jobId);
    if (!row) {
      log?.debug({ job: jobId }, "thumbnail job skipped: its row is gone (file purged)");
      return;
    }
    const file = await this.file(row.fileId);
    if (!file) {
      log?.debug({ job: jobId, file: row.fileId }, "thumbnail job skipped: file gone");
      return;
    }
    // Only a `tenant` file's key is the worker's to hold (the key file); the rest is skipped.
    const opened = file.encryption === "none" ? null : await this.openEncrypted(file);
    if (file.encryption !== "none" && !opened) {
      await markSkipped(this.deps, jobId, SKIP_NO_KEY);
      await this.announce(file, "SKIPPED");
      return;
    }
    const attempt = job.attemptsMade + 1;
    const attempts = job.opts.attempts ?? 1;
    await markRunning(this.deps, jobId, attempt);
    try {
      if (opened) {
        await generateEncryptedThumbnail(this.derivatives(), file, opened, size, crop, {
          timeoutMs: this.options.jobTimeoutMs,
          pdftoppm: this.options.pdftoppm,
        });
      } else {
        await generateThumbnail(this.options.storage, file, size, crop, {
          timeoutMs: this.options.jobTimeoutMs,
          pdftoppm: this.options.pdftoppm,
        });
      }
    } catch (error) {
      if (error instanceof DerivativeTooLargeError) {
        await markSkipped(this.deps, jobId, SKIP_TOO_LARGE);
        await this.announce(file, "SKIPPED");
        log?.info(
          { job: jobId, file: file.id, size: file.size },
          "thumbnail skipped: file too large",
        );
        return;
      }
      const unrecoverable =
        derivativeUnrecoverable(error) ||
        (error instanceof ThumbnailError &&
          (error.code === "unsupported" || error.code === "blob_missing"));
      const final = unrecoverable || attempt >= attempts;
      await markFailed(this.deps, jobId, shortError(error), final);
      await this.announce(file, final ? "FAILED" : "PENDING");
      log?.[final ? "warn" : "info"](
        { job: jobId, file: file.id, size, crop, attempt, err: error },
        final ? "thumbnail failed" : "thumbnail try failed, will retry",
      );
      if (unrecoverable) {
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      opened?.fk.fill(0);
    }
    await markDone(this.deps, jobId);
    await this.announce(file, "DONE");
    log?.info({ job: jobId, file: file.id, size, crop, attempt }, "thumbnail ready");
  }

  /**
   * The key and metadata of a `tenant` file, from the key file; `null` for any other mode
   * (nobody in the background holds a keyring's or a caller's key) and when the crypto
   * service is absent or the key does not open (logged: the file stays `SKIPPED`, a person
   * looks at `keys-status`).
   */
  private async openEncrypted(file: FileRow): Promise<OpenedFile | null> {
    if (file.encryption !== "tenant" || !this.options.crypto) return null;
    try {
      return await this.options.crypto.open(file);
    } catch (error) {
      if (error instanceof VolaError) {
        this.options.logger?.warn(
          { file: file.id, code: error.code },
          "encrypted file not opened by the worker",
        );
        return null;
      }
      throw error;
    }
  }

  private derivatives(): DerivativesDeps {
    return {
      storage: this.options.storage,
      maxBytes: this.options.encDeriveMaxBytes ?? DEFAULT_ENC_DERIVE_MAX,
      logger: this.options.logger,
    };
  }

  /**
   * The OCR pass of one file: `RUNNING`, `tesseract` (per page of a PDF rasterised with
   * `pdftoppm`), the text into `vola_file_metadata`, `DONE` — or `PENDING` again for a
   * retry, `FAILED` after the last try (at once when the tool is missing, the type is not
   * supported or the bytes are gone); `SKIPPED` when OCR is off here or the file is
   * encrypted. A `processing` event follows every outcome.
   */
  private async ocr(job: Job<OcrJobData>): Promise<void> {
    const { jobId } = job.data;
    const log = this.options.logger;
    const row = await findJob(this.options.db, jobId);
    if (!row) {
      log?.debug({ job: jobId }, "OCR job skipped: its row is gone (file purged)");
      return;
    }
    const file = await this.file(row.fileId);
    if (!file) {
      log?.debug({ job: jobId, file: row.fileId }, "OCR job skipped: file gone");
      return;
    }
    const opened = file.encryption === "none" ? null : await this.openEncrypted(file);
    if (file.encryption !== "none" && !opened) {
      await markSkipped(this.deps, jobId, SKIP_NO_KEY);
      await this.announce(file, "SKIPPED");
      return;
    }
    const ocr = this.options.ocr;
    const state = this.ocrState;
    if (!state.enabled || !ocr) {
      opened?.fk.fill(0);
      await markSkipped(this.deps, jobId, state.enabled ? "OCR not configured" : state.reason);
      await this.announce(file, "SKIPPED");
      log?.info({ job: jobId, file: file.id }, "OCR job skipped: OCR is off in this worker");
      return;
    }
    const attempt = job.attemptsMade + 1;
    const attempts = job.opts.attempts ?? 1;
    await markRunning(this.deps, jobId, attempt);
    const started = Date.now();
    try {
      const run = {
        langs: state.langs,
        maxPages: ocr.maxPages,
        timeoutMs: ocr.timeoutS * 1000,
        tesseract: ocr.tesseract ?? DEFAULT_TESSERACT,
        pdftoppm: ocr.pdftoppm ?? this.options.pdftoppm ?? DEFAULT_PDFTOPPM,
      };
      const at = (this.options.now ?? (() => new Date()))();
      let result: { text: string; lang: string; pages: number };
      if (opened) {
        // Decrypted into memory, read through stdin, the text sealed under the file key.
        result = await ocrEncrypted(this.derivatives(), this.options.db, file, opened, {
          ...run,
          at,
        });
      } else {
        result = await extractText(this.options.storage, file, run);
        await saveOcrResult(this.options.db, {
          fileId: file.id,
          tenantId: file.tenantId,
          text: result.text,
          lang: result.lang,
          pages: result.pages,
          at,
        });
      }
      await markDone(this.deps, jobId);
      await this.announce(file, "DONE");
      log?.info(
        {
          job: jobId,
          file: file.id,
          pages: result.pages,
          chars: result.text.length,
          lang: result.lang,
          attempt,
          ms: Date.now() - started,
        },
        "OCR done",
      );
    } catch (error) {
      if (error instanceof DerivativeTooLargeError) {
        await markSkipped(this.deps, jobId, SKIP_TOO_LARGE);
        await this.announce(file, "SKIPPED");
        log?.info({ job: jobId, file: file.id, size: file.size }, "OCR skipped: file too large");
        return;
      }
      const unrecoverable =
        derivativeUnrecoverable(error) ||
        (error instanceof OcrError &&
          (error.code === "unsupported" ||
            error.code === "blob_missing" ||
            error.code === "tool_missing"));
      const final = unrecoverable || attempt >= attempts;
      await markFailed(this.deps, jobId, shortError(error), final);
      await this.announce(file, final ? "FAILED" : "PENDING");
      log?.[final ? "warn" : "info"](
        { job: jobId, file: file.id, attempt, err: error },
        final ? "OCR failed" : "OCR try failed, will retry",
      );
      if (unrecoverable) {
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      opened?.fk.fill(0);
    }
  }

  private async file(fileId: string): Promise<FileRow | null> {
    const [row] = await this.options.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return row ?? null;
  }

  private announce(file: FileRow, status: ProcessingStatus): Promise<void> {
    this.options.logger?.debug({ file: file.id, status }, "processing status changed");
    return publishProcessingStatus(
      { events: this.options.events, logger: this.options.logger },
      {
        tenantId: file.tenantId,
        instanceType: file.instanceType,
        instanceId: file.instanceId,
        folderId: file.folderId,
        fileId: file.id,
      },
    );
  }

  /** Waits for the active jobs, then disconnects. */
  async close(): Promise<void> {
    await this.worker.close().catch(() => undefined);
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
