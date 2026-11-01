import { type Readable, Transform } from "node:stream";
import {
  FILE_LIST_DEFAULT_LIMIT,
  FILE_LIST_MAX_LIMIT,
  type FileEncryption,
  type FileInfo,
  type FileKind,
  type FileList,
  FileMetadataSchema,
  FileSlugSchema,
  InstanceTypeSchema,
  type PurgeResult,
} from "@vola/core";
import { and, desc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/index.js";
import { type FileRow, files } from "../db/schema.js";
import { VolaError } from "../errors.js";
import {
  extensionOf,
  nextCollisionFilename,
  sanitizeFilename,
  splitFilename,
} from "../files/filename.js";
import { detectMime, kindForMime, SNIFF_BYTES } from "../files/mime.js";
import {
  BlobNotFoundError,
  FileTooLargeError,
  type StagedBlob,
  type StorageBackend,
} from "../storage/index.js";
import { LastUsedThrottle } from "./apikeys.js";

export interface FilesDeps {
  db: Database;
  storage: StorageBackend;
  /** Throttles `last_accessed_at` writes to one a minute per file. Default: a new one. */
  accessThrottle?: LastUsedThrottle | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a file lives: the tenant of the request and the instance of the URL. */
export interface InstanceScope {
  tenantId: string;
  instanceType: string;
  instanceId: string;
}

/** The one answer for a file that is not there — or belongs to another tenant (never 403). */
export function fileNotFound(): VolaError {
  return new VolaError("file_not_found", 404, "file not found");
}

function validation(message: string): VolaError {
  return new VolaError("validation_error", 422, message);
}

/** Validates the `:type/:id` of a route; `422 validation_error` otherwise. */
export function parseInstance(
  tenantId: string,
  instanceType: string,
  instanceId: string,
): InstanceScope {
  const type = InstanceTypeSchema.safeParse(instanceType);
  if (!type.success) throw validation(`instance_type: ${type.error.issues[0]?.message}`);
  if (!UUID_RE.test(instanceId)) throw validation("instance_id: must be a UUID");
  return { tenantId, instanceType: type.data, instanceId: instanceId.toLowerCase() };
}

/** Validates a slug of a route; `422 validation_error` otherwise. */
export function parseSlug(slug: string): string {
  const parsed = FileSlugSchema.safeParse(slug);
  if (!parsed.success) throw validation(`slug: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Parses the `metadata` field (a JSON object); `422 validation_error` otherwise. */
export function parseMetadata(raw: string | undefined | null): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw validation("metadata: must be JSON");
  }
  const parsed = FileMetadataSchema.safeParse(value);
  if (!parsed.success || Array.isArray(value)) throw validation("metadata: must be a JSON object");
  return parsed.data;
}

export function serializeFile(row: FileRow): FileInfo {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    instance_type: row.instanceType,
    instance_id: row.instanceId,
    slug: row.slug,
    hash: row.hash,
    size: Number(row.size),
    filename: row.filename,
    extension: row.extension,
    mime_type: row.mimeType,
    kind: row.kind as FileKind,
    metadata: row.metadata,
    folder_id: row.folderId,
    parent_id: row.parentId,
    is_public: row.isPublic,
    is_global_public: row.isGlobalPublic,
    encryption: row.encryption as FileEncryption,
    enc_format: row.encFormat,
    keyring_id: row.keyringId,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
    deleted_by: row.deletedBy,
    last_accessed_at: row.lastAccessedAt?.toISOString() ?? null,
    last_accessed_by: row.lastAccessedBy,
  };
}

// --- upload -----------------------------------------------------------------------------

/** A blob in the temporary area plus the bytes needed to tell its type. */
export interface StagedUpload {
  staged: StagedBlob;
  head: Buffer;
}

/** A pass-through that keeps a copy of the first `SNIFF_BYTES` for MIME detection. */
export function headSniffer(): { transform: Transform; head: () => Buffer } {
  const chunks: Buffer[] = [];
  let have = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (have < SNIFF_BYTES) {
        const take = chunk.subarray(0, SNIFF_BYTES - have);
        chunks.push(Buffer.from(take));
        have += take.length;
      }
      callback(null, chunk);
    },
  });
  return { transform, head: () => Buffer.concat(chunks) };
}

/**
 * Streams the bytes of an upload into the temporary area (hash and size computed on the way,
 * nothing buffered beyond the sniffing head). `413 file_too_large` beyond `maxBytes`.
 */
export async function stageUpload(
  deps: FilesDeps,
  stream: Readable,
  options: { maxBytes?: number | undefined } = {},
): Promise<StagedUpload> {
  const sniffer = headSniffer();
  // Errors of the source surface through pipeline() inside stage(); the sniffer only copies.
  const piped = stream.pipe(sniffer.transform);
  stream.on("error", (error) => sniffer.transform.destroy(error));
  try {
    const staged = await deps.storage.stage(piped, { maxBytes: options.maxBytes });
    return { staged, head: sniffer.head() };
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new VolaError(
        "file_too_large",
        413,
        `the file exceeds the upload limit of ${error.maxBytes} bytes`,
      );
    }
    throw error;
  }
}

export interface FinalizeUploadInput {
  scope: InstanceScope;
  upload: StagedUpload;
  /** The name the client gave the part (sanitised here). */
  filename: string | undefined | null;
  /** `Content-Type` of the part, if any. */
  declaredMime?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Upsert as the named file of the instance: the previous live file of that slug is soft-deleted. */
  slug?: string | null | undefined;
  userId: string | null;
}

/** PostgreSQL error code of a unique violation. */
const UNIQUE_VIOLATION = "23505";
const pgCode = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code ??
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/**
 * Turns a staged upload into a file row: detects MIME, extension and kind, then in ONE
 * transaction — under an advisory lock on the hash, so a concurrent purge of the same bytes
 * cannot remove the blob between its commit and the row — commits the blob (dedup when it
 * exists), soft-deletes the previous file of `slug`, resolves the collision rename and inserts.
 * On failure the staged blob is discarded.
 */
export async function finalizeUpload(
  deps: FilesDeps,
  input: FinalizeUploadInput,
): Promise<FileInfo> {
  const { scope, upload } = input;
  const slug = input.slug ?? null;
  const filename = sanitizeFilename(input.filename, slug ?? "unnamed");
  const mimeType = await detectMime({
    head: upload.head,
    filename,
    declared: input.declaredMime,
  });
  const extension = extensionOf(filename);
  const kind = kindForMime(mimeType);
  const metadata = input.metadata ?? {};
  const now = (deps.now ?? (() => new Date()))();
  let committed = false;

  try {
    // A concurrent upsert of the same slug trips the partial unique index: retry, the other
    // row is live by then and gets soft-deleted on the next pass.
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${upload.staged.hash}, 0))`,
          );
          if (!committed) {
            await deps.storage.commit(upload.staged);
            committed = true;
          } else if (!(await deps.storage.exists(upload.staged.hash))) {
            throw new VolaError(
              "blob_missing",
              500,
              "the stored bytes vanished before the file was recorded",
            );
          }
          if (slug) {
            await tx
              .update(files)
              .set({ deletedAt: now, deletedBy: input.userId, updatedAt: now })
              .where(and(instanceWhere(scope), eq(files.slug, slug), isNull(files.deletedAt)));
          }
          const resolved = await resolveFilename(tx, scope, filename);
          const [row] = await tx
            .insert(files)
            .values({
              tenantId: scope.tenantId,
              instanceType: scope.instanceType,
              instanceId: scope.instanceId,
              slug,
              hash: upload.staged.hash,
              size: upload.staged.size,
              filename: resolved,
              extension,
              mimeType,
              kind,
              metadata,
              createdBy: input.userId,
              // Millisecond timestamps from here, so the list cursor compares exactly.
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return serializeFile(row as FileRow);
        });
      } catch (error) {
        if (slug && attempt < 3 && pgCode(error) === UNIQUE_VIOLATION) continue;
        throw error;
      }
    }
  } catch (error) {
    if (!committed) await deps.storage.discard(upload.staged);
    throw error;
  }
}

export interface UploadInput extends Omit<FinalizeUploadInput, "upload"> {
  stream: Readable;
  maxBytes?: number | undefined;
}

/** `stageUpload` + `finalizeUpload`. */
export async function uploadFile(deps: FilesDeps, input: UploadInput): Promise<FileInfo> {
  const { stream, maxBytes, ...rest } = input;
  const upload = await stageUpload(deps, stream, { maxBytes });
  return finalizeUpload(deps, { ...rest, upload });
}

type Tx = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

function instanceWhere(scope: InstanceScope) {
  return and(
    eq(files.tenantId, scope.tenantId),
    eq(files.instanceType, scope.instanceType),
    eq(files.instanceId, scope.instanceId),
  );
}

/** `%`, `_` and `\` of a LIKE pattern literal, escaped (PostgreSQL's default escape is `\`). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The free name for `filename` among the live files of the instance (root folder): one exact
 * lookup for the common case, and only on a collision the `base (n).ext` candidates.
 */
async function resolveFilename(tx: Tx, scope: InstanceScope, filename: string): Promise<string> {
  const namespace = and(instanceWhere(scope), isNull(files.folderId), isNull(files.deletedAt));
  const exact = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(namespace, eq(files.filename, filename)))
    .limit(1);
  if (exact.length === 0) return filename;
  const { base } = splitFilename(filename);
  const siblings = await tx
    .select({ filename: files.filename })
    .from(files)
    .where(and(namespace, like(files.filename, `${escapeLike(base)} (%`)));
  return nextCollisionFilename(filename, [filename, ...siblings.map((row) => row.filename)]);
}

// --- lookup ------------------------------------------------------------------------------

export interface FindOptions {
  /** Also find a soft-deleted file (purge, `?include_deleted=1`). */
  includeDeleted?: boolean | undefined;
}

/** The file `fileId` of the instance; `404 file_not_found` otherwise (another tenant's too). */
export async function findFile(
  deps: FilesDeps,
  scope: InstanceScope,
  fileId: string,
  options: FindOptions = {},
): Promise<FileRow> {
  if (!UUID_RE.test(fileId)) throw fileNotFound();
  const [row] = await deps.db
    .select()
    .from(files)
    .where(
      and(
        instanceWhere(scope),
        eq(files.id, fileId.toLowerCase()),
        options.includeDeleted ? undefined : isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw fileNotFound();
  return row;
}

/** The live file named `slug` in the instance (the newest, should a race have left two). */
export async function findFileBySlug(
  deps: FilesDeps,
  scope: InstanceScope,
  slug: string,
): Promise<FileRow> {
  const [row] = await deps.db
    .select()
    .from(files)
    .where(and(instanceWhere(scope), eq(files.slug, slug), isNull(files.deletedAt)))
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(1);
  if (!row) throw fileNotFound();
  return row;
}

// --- list --------------------------------------------------------------------------------

export interface ListInput {
  cursor?: string | null | undefined;
  limit?: string | number | null | undefined;
  includeDeleted?: boolean | undefined;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(row: Pick<FileRow, "createdAt" | "id">): string {
  return Buffer.from(`${row.createdAt.getTime()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  const [ms, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const time = Number(ms);
  if (!ms || !id || !Number.isSafeInteger(time) || !UUID_RE.test(id)) {
    throw validation("cursor: not a cursor of this list");
  }
  return { createdAt: new Date(time), id };
}

/** The page size: `1..FILE_LIST_MAX_LIMIT`, default `FILE_LIST_DEFAULT_LIMIT`. */
export function parseLimit(raw: string | number | null | undefined): number {
  if (raw === undefined || raw === null || raw === "") return FILE_LIST_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > FILE_LIST_MAX_LIMIT) {
    throw validation(`limit: an integer from 1 to ${FILE_LIST_MAX_LIMIT}`);
  }
  return limit;
}

/** The instance's files, newest first (`created_at desc, id desc`), one page per call. */
export async function listFiles(
  deps: FilesDeps,
  scope: InstanceScope,
  input: ListInput = {},
): Promise<FileList> {
  const limit = parseLimit(input.limit);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await deps.db
    .select()
    .from(files)
    .where(
      and(
        instanceWhere(scope),
        input.includeDeleted ? undefined : isNull(files.deletedAt),
        cursor
          ? or(
              lt(files.createdAt, cursor.createdAt),
              and(eq(files.createdAt, cursor.createdAt), lt(files.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    files: page.map(serializeFile),
    next_cursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

// --- access tracking ---------------------------------------------------------------------

/**
 * Records a download (`last_accessed_at/by`), at most once a minute per file; best effort
 * and never awaited by the response.
 */
export function touchLastAccessed(deps: FilesDeps, fileId: string, userId: string | null): void {
  const now = (deps.now ?? (() => new Date()))();
  deps.accessThrottle ??= new LastUsedThrottle();
  if (!deps.accessThrottle.shouldWrite(fileId, now.getTime())) return;
  void deps.db
    .update(files)
    .set({ lastAccessedAt: now, lastAccessedBy: userId })
    .where(eq(files.id, fileId))
    .catch((error: unknown) =>
      deps.logger?.warn({ err: error, file: fileId }, "last_accessed_at not written"),
    );
}

// --- delete ------------------------------------------------------------------------------

/** Soft delete: `deleted_at` + `deleted_by`; the bytes stay. Idempotent. */
export async function softDeleteFile(
  deps: FilesDeps,
  scope: InstanceScope,
  fileId: string,
  userId: string | null,
): Promise<FileInfo> {
  const row = await findFile(deps, scope, fileId, { includeDeleted: true });
  if (row.deletedAt) return serializeFile(row);
  const now = (deps.now ?? (() => new Date()))();
  const [updated] = await deps.db
    .update(files)
    .set({ deletedAt: now, deletedBy: userId, updatedAt: now })
    .where(and(eq(files.id, row.id), isNull(files.deletedAt)))
    .returning();
  return serializeFile(updated ?? { ...row, deletedAt: now, deletedBy: userId, updatedAt: now });
}

/**
 * Every row linked to `row` through `parent_id`, older and newer versions alike, within the
 * tenant, soft-deleted ones included. Until versions exist (2.2) this is `[row]`.
 */
async function versionFamily(db: Database, row: FileRow): Promise<FileRow[]> {
  const found = new Map<string, FileRow>([[row.id, row]]);
  let frontier: FileRow[] = [row];
  while (frontier.length > 0) {
    const parentIds = frontier.map((f) => f.parentId).filter((id): id is string => id !== null);
    const childOf = frontier.map((f) => f.id);
    const next = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.tenantId, row.tenantId),
          or(
            parentIds.length > 0 ? inArray(files.id, parentIds) : undefined,
            inArray(files.parentId, childOf),
          ),
        ),
      );
    frontier = next.filter((f) => !found.has(f.id));
    for (const f of frontier) found.set(f.id, f);
  }
  return [...found.values()];
}

/**
 * Permanent delete: the row and its whole version chain go in one transaction; afterwards each
 * blob is removed from disk ONLY when no row of any tenant — live or soft-deleted — references
 * it any more (checked under the same advisory lock uploads commit under, so a simultaneous
 * upload of the same bytes cannot lose its blob). A disk failure is logged, not reported.
 * Works on an already soft-deleted file.
 */
export async function purgeFile(
  deps: FilesDeps,
  scope: InstanceScope,
  fileId: string,
): Promise<PurgeResult> {
  const row = await findFile(deps, scope, fileId, { includeDeleted: true });
  const family = await versionFamily(deps.db, row);
  const ids = family.map((f) => f.id);
  const hashes = [...new Set(family.map((f) => f.hash))].sort();

  const deleted = await deps.db.transaction((tx) =>
    tx.delete(files).where(inArray(files.id, ids)).returning({ id: files.id }),
  );

  let blobs = 0;
  for (const hash of hashes) {
    try {
      const removed = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`);
        const [reference] = await tx
          .select({ id: files.id })
          .from(files)
          .where(eq(files.hash, hash))
          .limit(1);
        if (reference) return false;
        return deps.storage.remove(hash);
      });
      if (removed) blobs++;
    } catch (error) {
      deps.logger?.error({ err: error, hash }, "blob not removed after purge");
    }
  }
  deps.logger?.info({ file: row.id, files: deleted.length, blobs }, "file purged");
  return { files: deleted.length, blobs };
}

/** Opens the bytes of `row` (or `range` of them); a blob missing from disk is `500 blob_missing`. */
export async function openFile(
  deps: FilesDeps,
  row: Pick<FileRow, "hash">,
  range?: { start: number; end: number },
): Promise<Readable> {
  try {
    return await deps.storage.open(row.hash, range);
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      throw new VolaError("blob_missing", 500, "the stored bytes of this file are missing");
    }
    throw error;
  }
}
