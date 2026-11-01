import {
  DEFAULT_THUMBNAIL_CROP,
  type ProcessingStatus,
  THUMBNAIL_SIZES,
  type ThumbnailCrop,
  type ThumbnailSize,
  thumbnailSupported,
} from "@vola/core";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/index.js";
import type { FileRow } from "../db/schema.js";
import {
  type ProcessingDeps,
  requestJob,
  type ThumbnailJobParams,
} from "../services/processing.js";
import type { ProcessingQueue } from "./queue.js";

/** What a file row must carry for the dispatcher to decide about it. */
export type DispatchableFile = Pick<FileRow, "id" | "tenantId" | "mimeType" | "encryption">;

/**
 * The server's handle on background work. Present only in `async` mode (see
 * `resolveJobsMode`): without it thumbnails are rendered inline on `/thumb` and nothing is
 * recorded in `vola_processing_job`.
 */
export interface JobDispatcher {
  /**
   * After `finalizeUpload`: one `THUMBNAIL` job per size (64, 128, 256, 512; crop `cover`) for
   * a raster image or PDF that is not encrypted — nothing for anything else (no `SKIPPED`
   * rows either). Never throws: a queue failure is logged, the upload already succeeded.
   * Returns the `processing_status` the new file has now (`PENDING`, or `null`).
   */
  afterUpload(file: DispatchableFile): Promise<ProcessingStatus | null>;
  /**
   * A `/thumb` miss: records (or refreshes) the job for that rendition and queues it. Throws
   * when the queue is unreachable so the route can fall back to rendering inline.
   */
  requestThumbnail(file: DispatchableFile, size: ThumbnailSize, crop: ThumbnailCrop): Promise<void>;
}

export interface QueuedJobDispatcherOptions {
  db: Database;
  queue: ProcessingQueue;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

/** `true` when the worker will render thumbnails of this file: supported type, not encrypted. */
export function thumbnailable(file: Pick<FileRow, "mimeType" | "encryption">): boolean {
  return file.encryption === "none" && thumbnailSupported(file.mimeType);
}

/** The dispatcher of `async` mode: rows in `vola_processing_job`, jobs in the BullMQ queue. */
export class QueuedJobDispatcher implements JobDispatcher {
  private readonly deps: ProcessingDeps;
  private readonly queue: ProcessingQueue;
  private readonly logger: FastifyBaseLogger | undefined;

  constructor(options: QueuedJobDispatcherOptions) {
    this.deps = { db: options.db, logger: options.logger, now: options.now };
    this.queue = options.queue;
    this.logger = options.logger;
  }

  async afterUpload(file: DispatchableFile): Promise<ProcessingStatus | null> {
    if (!thumbnailable(file)) return null;
    let queued = 0;
    for (const size of THUMBNAIL_SIZES) {
      try {
        await this.requestThumbnail(file, size, DEFAULT_THUMBNAIL_CROP);
        queued++;
      } catch (error) {
        this.logger?.warn({ err: error, file: file.id, size }, "thumbnail job not queued");
      }
    }
    return queued > 0 ? "PENDING" : null;
  }

  async requestThumbnail(
    file: DispatchableFile,
    size: ThumbnailSize,
    crop: ThumbnailCrop,
  ): Promise<void> {
    const params: ThumbnailJobParams = { size, crop };
    const { job, queued } = await requestJob(this.deps, {
      tenantId: file.tenantId,
      fileId: file.id,
      kind: "THUMBNAIL",
      params: { ...params },
    });
    await this.queue.enqueueThumbnail(
      { jobId: job.id, tenantId: file.tenantId, fileId: file.id, size, crop },
      {
        replace: queued && job.attempts === 0 && job.startedAt === null && job.finishedAt === null,
      },
    );
  }
}
