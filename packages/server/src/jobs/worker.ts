import type { ProcessingStatus } from "@vola/core";
import { type Job, UnrecoverableError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { Database } from "../db/index.js";
import { type FileRow, files } from "../db/schema.js";
import { type FileEventBus, publishProcessingStatus } from "../events/bus.js";
import {
  findJob,
  markDone,
  markFailed,
  markRunning,
  markSkipped,
  type ProcessingDeps,
  shortError,
} from "../services/processing.js";
import {
  DEFAULT_THUMBNAIL_TIMEOUT_MS,
  generateThumbnail,
  ThumbnailError,
} from "../services/thumbnails.js";
import { sweepExpiredUploads, type UploadsDeps } from "../services/uploads.js";
import type { StorageBackend } from "../storage/index.js";
import type { PartStore } from "../uploads/part-store.js";
import {
  PROCESSING_QUEUE,
  type ProcessingJobData,
  queueConnection,
  SWEEP_UPLOADS_JOB,
  THUMBNAIL_JOB,
  type ThumbnailJobData,
} from "./queue.js";

export const DEFAULT_WORKER_CONCURRENCY = 2;

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
  /** Wall-clock limit of one job. Default 30 s. */
  jobTimeoutMs?: number | undefined;
  /** The `pdftoppm` binary. Default: the one on `PATH`. */
  pdftoppm?: string | undefined;
  now?: (() => Date) | undefined;
}

/** The second process of `@vola/server`: consumes `vola-processing` and records every outcome. */
export class ProcessingWorker {
  readonly worker: Worker<ProcessingJobData>;
  private readonly connection: Redis;
  private readonly options: ProcessingWorkerOptions;
  private readonly deps: ProcessingDeps;

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
      // A job that hangs past its own timeout is still reaped by the stalled check.
      lockDuration: (options.jobTimeoutMs ?? DEFAULT_THUMBNAIL_TIMEOUT_MS) + 30_000,
    });
    this.worker.on("error", (error) => log?.error({ err: error }, "worker error"));
    this.worker.on("failed", (job, error) =>
      log?.warn(
        { job: job?.id, name: job?.name, attempt: job?.attemptsMade, err: error },
        "job failed",
      ),
    );
  }

  /** Resolves once the worker is connected and taking jobs. */
  ready(): Promise<void> {
    return this.worker.waitUntilReady().then(() => undefined);
  }

  private async process(job: Job<ProcessingJobData>): Promise<void> {
    switch (job.name) {
      case THUMBNAIL_JOB:
        return this.thumbnail(job as Job<ThumbnailJobData>);
      case SWEEP_UPLOADS_JOB:
        return this.sweep();
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
    if (file.encryption !== "none") {
      // The worker never touches encrypted bytes (plan 6.3 renders those under the key).
      await markSkipped(this.deps, jobId, "encrypted file");
      await this.announce(file, "SKIPPED");
      return;
    }
    const attempt = job.attemptsMade + 1;
    const attempts = job.opts.attempts ?? 1;
    await markRunning(this.deps, jobId, attempt);
    try {
      await generateThumbnail(this.options.storage, file, size, crop, {
        timeoutMs: this.options.jobTimeoutMs,
        pdftoppm: this.options.pdftoppm,
      });
    } catch (error) {
      const unrecoverable =
        error instanceof ThumbnailError &&
        (error.code === "unsupported" || error.code === "blob_missing");
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
    }
    await markDone(this.deps, jobId);
    await this.announce(file, "DONE");
    log?.info({ job: jobId, file: file.id, size, crop, attempt }, "thumbnail ready");
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
