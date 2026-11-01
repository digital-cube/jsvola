import {
  aggregateProcessingStatus,
  type ProcessingKind,
  type ProcessingStatus,
  type ThumbnailCrop,
  type ThumbnailSize,
} from "@vola/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/index.js";
import { type ProcessingJobRow, processingJobs } from "../db/schema.js";

export interface ProcessingDeps {
  db: Database;
  logger?: FastifyBaseLogger | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

/** The `params` of a `THUMBNAIL` job: which rendition it produces. */
export interface ThumbnailJobParams {
  size: ThumbnailSize;
  crop: ThumbnailCrop;
}

export interface JobIdentity {
  tenantId: string;
  fileId: string;
  kind: ProcessingKind;
  params: Record<string, unknown>;
}

/** How many times the worker tries a job before it is `FAILED`. */
export const PROCESSING_MAX_ATTEMPTS = 3;
/** Longest an `error` is kept. */
export const PROCESSING_ERROR_MAX_LENGTH = 500;

const clock = (deps: ProcessingDeps) => (deps.now ?? (() => new Date()))();

// --- aggregate ---------------------------------------------------------------------------

/**
 * The `processing_status` of every file in `fileIds`, in ONE query; a file with no (counted)
 * job is absent from the map, so `map.get(id) ?? null` is its status.
 */
export async function processingStatusByFile(
  db: Database,
  fileIds: readonly string[],
): Promise<Map<string, ProcessingStatus>> {
  const result = new Map<string, ProcessingStatus>();
  if (fileIds.length === 0) return result;
  const rows = await db
    .select({ fileId: processingJobs.fileId, status: processingJobs.status })
    .from(processingJobs)
    .where(inArray(processingJobs.fileId, [...fileIds]));
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.fileId);
    if (list) list.push(row.status);
    else grouped.set(row.fileId, [row.status]);
  }
  for (const [fileId, statuses] of grouped) {
    const aggregate = aggregateProcessingStatus(statuses);
    if (aggregate) result.set(fileId, aggregate);
  }
  return result;
}

/** The `processing_status` of one file (`null`: no job). */
export async function processingStatusOf(
  db: Database,
  fileId: string,
): Promise<ProcessingStatus | null> {
  return (await processingStatusByFile(db, [fileId])).get(fileId) ?? null;
}

/** Sets `processing_status` on every item of `infos` (anything with an `id`), one query. */
export async function attachProcessingStatus<T extends { id: string }>(
  db: Database,
  infos: T[],
): Promise<(T & { processing_status: ProcessingStatus | null })[]> {
  const statuses = await processingStatusByFile(
    db,
    infos.map((info) => info.id),
  );
  return infos.map((info) => ({ ...info, processing_status: statuses.get(info.id) ?? null }));
}

/** The jobs of a file, oldest first. */
export async function listProcessingJobs(
  db: Database,
  fileId: string,
): Promise<ProcessingJobRow[]> {
  return db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.fileId, fileId))
    .orderBy(processingJobs.createdAt, processingJobs.id);
}

// --- lifecycle ---------------------------------------------------------------------------

export interface RequestedJob {
  job: ProcessingJobRow;
  /**
   * `true` when the row was inserted or reset to `PENDING` (the queue must get it);
   * `false` when a `PENDING` / `RUNNING` row was already there (the queue has it).
   */
  queued: boolean;
}

/**
 * Asks for a job: inserts a `PENDING` row for `(file, kind, params)`, or — when that row is
 * `DONE` or `FAILED` — resets it to `PENDING` (attempts 0, no error); a `PENDING` or
 * `RUNNING` row is left as it is. Idempotent under concurrency: the unique index decides.
 */
export async function requestJob(
  deps: ProcessingDeps,
  identity: JobIdentity,
): Promise<RequestedJob> {
  const now = clock(deps);
  const [reset] = await deps.db
    .insert(processingJobs)
    .values({
      tenantId: identity.tenantId,
      fileId: identity.fileId,
      kind: identity.kind,
      params: identity.params,
      status: "PENDING",
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [processingJobs.fileId, processingJobs.kind, processingJobs.params],
      set: {
        status: "PENDING",
        attempts: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
      },
      setWhere: sql`${processingJobs.status} in ('DONE', 'FAILED', 'SKIPPED')`,
    })
    .returning();
  if (reset) return { job: reset, queued: true };
  const [existing] = await deps.db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.fileId, identity.fileId),
        eq(processingJobs.kind, identity.kind),
        sql`${processingJobs.params} = ${JSON.stringify(identity.params)}::jsonb`,
      ),
    )
    .limit(1);
  if (!existing) {
    // The row vanished between the two statements (the file was purged): nothing to run.
    throw new JobGoneError(identity.fileId);
  }
  return { job: existing, queued: false };
}

/** The file (and so its job row) is gone. */
export class JobGoneError extends Error {
  constructor(readonly fileId: string) {
    super(`no processing job: file ${fileId} is gone`);
    this.name = "JobGoneError";
  }
}

/** The job row `jobId`, or `null` once its file was purged. */
export async function findJob(db: Database, jobId: string): Promise<ProcessingJobRow | null> {
  const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  return row ?? null;
}

/** The worker took the job: `RUNNING`, `attempts = attempt`, `started_at = now`. */
export async function markRunning(
  deps: ProcessingDeps,
  jobId: string,
  attempt: number,
): Promise<ProcessingJobRow | null> {
  const [row] = await deps.db
    .update(processingJobs)
    .set({ status: "RUNNING", attempts: attempt, startedAt: clock(deps), error: null })
    .where(eq(processingJobs.id, jobId))
    .returning();
  return row ?? null;
}

/** The job produced its result. */
export async function markDone(
  deps: ProcessingDeps,
  jobId: string,
): Promise<ProcessingJobRow | null> {
  const [row] = await deps.db
    .update(processingJobs)
    .set({ status: "DONE", finishedAt: clock(deps), error: null })
    .where(eq(processingJobs.id, jobId))
    .returning();
  return row ?? null;
}

/**
 * The try failed: `FAILED` with `finished_at` when it was the last one (`final`), otherwise
 * back to `PENDING` — the queue retries it — with the reason kept.
 */
export async function markFailed(
  deps: ProcessingDeps,
  jobId: string,
  error: string,
  final: boolean,
): Promise<ProcessingJobRow | null> {
  const [row] = await deps.db
    .update(processingJobs)
    .set(
      final
        ? { status: "FAILED", finishedAt: clock(deps), error: shortError(error) }
        : { status: "PENDING", error: shortError(error) },
    )
    .where(eq(processingJobs.id, jobId))
    .returning();
  return row ?? null;
}

/** The job was deliberately not run (an encrypted file). */
export async function markSkipped(
  deps: ProcessingDeps,
  jobId: string,
  reason: string,
): Promise<ProcessingJobRow | null> {
  const [row] = await deps.db
    .update(processingJobs)
    .set({ status: "SKIPPED", finishedAt: clock(deps), error: shortError(reason) })
    .where(eq(processingJobs.id, jobId))
    .returning();
  return row ?? null;
}

/**
 * The text kept in `error`: one line, path-like tokens removed (never a file name), cut to
 * `PROCESSING_ERROR_MAX_LENGTH`.
 */
export function shortError(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : String(error);
  return text
    .replace(/\s+/g, " ")
    .replace(/(?:^|\s)(?:[A-Za-z]:)?(?:\/[^\s'"]+|\\[^\s'"]+)/g, " <path>")
    .trim()
    .slice(0, PROCESSING_ERROR_MAX_LENGTH);
}
