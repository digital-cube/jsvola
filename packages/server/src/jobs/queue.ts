import type { ThumbnailCrop, ThumbnailSize } from "@vola/core";
import { type JobsOptions, Queue } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import type { AuditEvent } from "../audit/memento.js";
import { PROCESSING_MAX_ATTEMPTS } from "../services/processing.js";

/** The one BullMQ queue every background job of vola travels through. */
export const PROCESSING_QUEUE = "vola-processing";
/** Redis key prefix of the queue (`<prefix>:vola-processing:*`). */
export const DEFAULT_QUEUE_PREFIX = "vola";
/** The job scheduler id and job name of the expired-upload sweep. */
export const SWEEP_UPLOADS_JOB = "sweep-uploads";
/** The job name of one thumbnail rendition. */
export const THUMBNAIL_JOB = "thumbnail";
/** The job name of the OCR pass of one file (plan 4.2). */
export const OCR_JOB = "ocr";
/** The job scheduler id and job name of the statistics refresh (plan 5.1). */
export const REFRESH_STATS_JOB = "refresh-stats";
/** The job name of one audit event on its way to memento (plan 5.2). */
export const AUDIT_JOB = "audit";
/** Tries the worker gives one audit event before it is dropped (with a WARN line). */
export const AUDIT_MAX_ATTEMPTS = 5;
/** Base of the exponential backoff between the tries of a job, in ms. */
export const DEFAULT_BACKOFF_MS = 1000;

/** What a `thumbnail` job carries; the worker reads the job row and the file row by id. */
export interface ThumbnailJobData {
  /** `vola_processing_job.id` — also the BullMQ job id, so one row is one queued job. */
  jobId: string;
  tenantId: string;
  fileId: string;
  size: ThumbnailSize;
  crop: ThumbnailCrop;
}

/** What an `ocr` job carries; the languages and limits are the worker's configuration. */
export interface OcrJobData {
  /** `vola_processing_job.id` — also the BullMQ job id. */
  jobId: string;
  tenantId: string;
  fileId: string;
}

/** What an `audit` job carries: the complete memento event, as the sink posts it. */
export type AuditJobData = AuditEvent;

export type ProcessingJobData =
  | ThumbnailJobData
  | OcrJobData
  | AuditJobData
  | Record<string, never>;

export interface ProcessingQueueOptions {
  redisUrl: string;
  /** Redis key prefix; default `vola` (tests use a random one so runs do not meet). */
  prefix?: string | undefined;
  /** Tries per job before it is `FAILED`. Default 3. */
  attempts?: number | undefined;
  /** Base of the exponential backoff between tries. Default 1000 ms. */
  backoffMs?: number | undefined;
  log?: FastifyBaseLogger | undefined;
}

/** A Redis client the way BullMQ wants it (no per-request retry cap). */
export function queueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true });
}

/**
 * The producer side of the queue: the server enqueues thumbnail jobs here (after an upload,
 * on a `/thumb` miss) and keeps the repeatable expired-upload sweep scheduled. The job id is
 * the processing row id, so asking twice for a rendition that is still queued adds nothing.
 */
export class ProcessingQueue {
  readonly queue: Queue<ProcessingJobData>;
  readonly prefix: string;
  private readonly connection: Redis;
  private readonly jobOptions: JobsOptions;

  constructor(options: ProcessingQueueOptions) {
    this.prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.connection = queueConnection(options.redisUrl);
    const log = options.log;
    this.connection.on("error", (error) => log?.warn({ err: error }, "job queue redis error"));
    this.queue = new Queue<ProcessingJobData>(PROCESSING_QUEUE, {
      connection: this.connection,
      prefix: this.prefix,
    });
    this.queue.on("error", (error) => log?.warn({ err: error }, "job queue error"));
    this.jobOptions = {
      attempts: options.attempts ?? PROCESSING_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: options.backoffMs ?? DEFAULT_BACKOFF_MS },
      // The database row is the record; a finished BullMQ job has nothing left to say.
      removeOnComplete: true,
      removeOnFail: true,
    };
  }

  /**
   * Queues one thumbnail rendition under the id of its processing row. `replace`: the row
   * was reset after a `DONE` / `FAILED` run, so a stale job of the same id (should BullMQ
   * still hold one) is dropped first.
   */
  async enqueueThumbnail(
    data: ThumbnailJobData,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    await this.enqueue(THUMBNAIL_JOB, data, options);
  }

  /** Queues the OCR pass of one file under the id of its processing row (`replace` as above). */
  async enqueueOcr(data: OcrJobData, options: { replace?: boolean } = {}): Promise<void> {
    await this.enqueue(OCR_JOB, data, options);
  }

  private async enqueue(
    name: string,
    data: ThumbnailJobData | OcrJobData,
    options: { replace?: boolean },
  ): Promise<void> {
    if (options.replace) {
      await this.queue.remove(data.jobId).catch(() => undefined);
    }
    await this.queue.add(name, data, { ...this.jobOptions, jobId: data.jobId });
  }

  /**
   * Queues one audit event for the worker to push to memento: `AUDIT_MAX_ATTEMPTS` tries with
   * the queue's exponential backoff. No job id: every event is its own job.
   */
  async enqueueAudit(event: AuditJobData): Promise<void> {
    await this.queue.add(AUDIT_JOB, event, {
      ...this.jobOptions,
      attempts: AUDIT_MAX_ATTEMPTS,
    });
  }

  /** Keeps the expired-upload sweep running every `everyMs` (one scheduler, shared by every server). */
  async scheduleUploadSweep(everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      SWEEP_UPLOADS_JOB,
      { every: everyMs },
      { name: SWEEP_UPLOADS_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
  }

  /** Stops the sweep (tests). */
  async unscheduleUploadSweep(): Promise<void> {
    await this.queue.removeJobScheduler(SWEEP_UPLOADS_JOB);
  }

  /** Keeps the statistics refresh running every `everyMs` (one scheduler, shared by every server). */
  async scheduleStatsRefresh(everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      REFRESH_STATS_JOB,
      { every: everyMs },
      { name: REFRESH_STATS_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
  }

  /** Stops the statistics refresh (tests). */
  async unscheduleStatsRefresh(): Promise<void> {
    await this.queue.removeJobScheduler(REFRESH_STATS_JOB);
  }

  /** Runs the statistics refresh once, now (tests, an operator's nudge). */
  async enqueueStatsRefresh(): Promise<void> {
    await this.queue.add(REFRESH_STATS_JOB, {}, { removeOnComplete: true, removeOnFail: true });
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
