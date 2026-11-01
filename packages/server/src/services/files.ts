import { type Readable, Transform } from "node:stream";
import {
  ENCRYPTED_STORED_MIME,
  FILE_LIST_DEFAULT_LIMIT,
  FILE_LIST_MAX_LIMIT,
  type FileEncryption,
  type FileInfo,
  type FileKind,
  type FileList,
  FileMetadataSchema,
  FileSlugSchema,
  type FileVersions,
  InstanceTypeSchema,
  type ProcessingStatus,
  type PurgeResult,
} from "@vola/core";
import { and, desc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLog } from "../audit/log.js";
import { fileAuditPayload } from "../audit/memento.js";
import {
  createEncryptStream,
  type FileMeta,
  JSV_VERSION,
  newFileKey,
  sealMeta,
} from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { type FileRow, files } from "../db/schema.js";
import { uuidv7 } from "../db/uuid.js";
import { VolaError } from "../errors.js";
import { type FileEventBus, publishFileEvent, publishFileEvents } from "../events/bus.js";
import {
  extensionOf,
  nextCollisionFilename,
  sanitizeFilename,
  splitFilename,
} from "../files/filename.js";
import { detectMimeDetailed, kindForMime, SNIFF_BYTES } from "../files/mime.js";
import type { JobDispatcher } from "../jobs/dispatcher.js";
import { type Lookups, recordFileCandidates } from "../lookups.js";
import {
  BlobNotFoundError,
  FileTooLargeError,
  type StagedBlob,
  type StorageBackend,
} from "../storage/index.js";
import { LastUsedThrottle } from "./apikeys.js";
import { type EncryptionService, encryptionUnavailable } from "./encryption.js";
import { attachProcessingStatus, processingStatusOf } from "./processing.js";

export interface FilesDeps {
  db: Database;
  storage: StorageBackend;
  /** Throttles `last_accessed_at` writes to one a minute per file. Default: a new one. */
  accessThrottle?: LastUsedThrottle | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** The vocabulary: a `kind` or `encryption` it does not know is recorded as a candidate. */
  lookups?: Lookups | undefined;
  /** Where every change is announced after its commit (real-time `subscribe`); absent: nowhere. */
  events?: FileEventBus | undefined;
  /**
   * Background jobs (`async` mode): `finalizeUpload` asks it for the thumbnails of a new file.
   * Absent (`sync` mode): nothing is queued, `/thumb` renders inline.
   */
  jobs?: JobDispatcher | undefined;
  /** The audit trail (plan 5.2): soft delete, purge and visibility changes are recorded on it. */
  audit?: AuditLog | undefined;
  /**
   * Encryption (plan 6.1): the wrap providers, the segment size, how a stored row's key and
   * metadata open. Absent: `encryption != none` cannot be served (`503`) nor produced.
   */
  crypto?: EncryptionService | undefined;
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

/**
 * The public view of a row. `processingStatus` is the aggregate of its jobs, which lives in
 * another table: callers that know it pass it, `withProcessingStatus` looks it up.
 */
export function serializeFile(
  row: FileRow,
  processingStatus: ProcessingStatus | null = null,
): FileInfo {
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
    processing_status: processingStatus,
  };
}

/**
 * `info` with the REAL name, type and metadata of an encrypted file put back from `meta_ct`
 * — what `info`, lists and the UDC rows show when the server holds the key (`tenant` mode).
 * `extension` and `kind` follow the real name and type.
 */
export function revealFile(info: FileInfo, meta: FileMeta): FileInfo {
  return {
    ...info,
    filename: meta.filename,
    extension: extensionOf(meta.filename),
    mime_type: meta.mime,
    kind: kindForMime(meta.mime),
    metadata: meta.metadata,
  };
}

/**
 * The public view of `row` with the metadata of an encrypted file decrypted when the server
 * can (quietly: a file whose key material is missing keeps `<id>.bin` / octet-stream, a
 * list never fails because of one file). `processingStatus` as for `serializeFile`.
 */
export async function describeFile(
  deps: FilesDeps,
  row: FileRow,
  processingStatus: ProcessingStatus | null = null,
): Promise<FileInfo> {
  const info = serializeFile(row, processingStatus);
  if (row.encryption === "none" || !deps.crypto) return info;
  const meta = await deps.crypto.reveal(row);
  return meta ? revealFile(info, meta) : info;
}

/** `describeFile` for a page of rows, with their `processing_status` read in one query. */
export async function describeFiles(deps: FilesDeps, rows: FileRow[]): Promise<FileInfo[]> {
  const statuses = await attachProcessingStatus(
    deps.db,
    rows.map((row) => ({ id: row.id })),
  );
  const out: FileInfo[] = [];
  for (const [i, row] of rows.entries()) {
    out.push(await describeFile(deps, row, statuses[i]?.processing_status ?? null));
  }
  return out;
}

/** `describeFile` with the file's current `processing_status` read from its jobs (one query). */
export async function withProcessingStatus(deps: FilesDeps, row: FileRow): Promise<FileInfo> {
  return describeFile(deps, row, await processingStatusOf(deps.db, row.id));
}

// --- upload -----------------------------------------------------------------------------

/** What an encrypted staging produced besides the blob: the key and the id the blob is bound to. */
export interface EncryptedStage {
  mode: FileEncryption;
  /** The id of the row to come: it is in the AAD of every segment, so it is drawn BEFORE encryption. */
  fileId: string;
  /** The random file key; wrapped into `fk_ct` by `finalizeUpload`, never stored in the clear. */
  fk: Buffer;
  /** For `keyring`: the keyring the key will be wrapped under (checked against the unlock at staging). */
  keyringId: string | null;
  plaintextLength: number;
  format: number;
}

/** A blob in the temporary area plus the bytes needed to tell its type. */
export interface StagedUpload {
  staged: StagedBlob;
  /** The first `SNIFF_BYTES` of the PLAINTEXT. */
  head: Buffer;
  /** Set when the staged blob is a `JSV` ciphertext. */
  encrypted?: EncryptedStage | undefined;
}

/** A pass-through that fails with `FileTooLargeError` once more than `maxBytes` went through. */
function plaintextMeter(maxBytes: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new FileTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

export interface StageOptions {
  maxBytes?: number | undefined;
  /** `none` (default): the bytes as they are; `tenant` / `keyring`: a `JSV` blob under a fresh file key. */
  encryption?: FileEncryption | undefined;
  /** For `keyring`: the keyring a folder policy demands (the request's unlock must be its); absent: the request's. */
  keyringId?: string | null | undefined;
  /** The plaintext length when it is known up front (a resumable upload): written into the header. */
  plaintextLength?: number | undefined;
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
 *
 * With `encryption` other than `none` the stream is plaintext → sniff → encrypt → stage: the
 * blob is a `JSV` ciphertext under a fresh file key, its hash is the hash of the CIPHERTEXT
 * (so two uploads of the same bytes are two blobs — there is no deduplication of encrypted
 * files, by design), and `maxBytes` is measured on the plaintext. The mode's key material is
 * checked FIRST (`503 encryption_unavailable` before a byte is read; for `keyring` also the
 * request's unlock — `423 vola_locked` — and, with a folder policy, that it is that keyring's).
 */
export async function stageUpload(
  deps: FilesDeps,
  stream: Readable,
  options: StageOptions = {},
): Promise<StagedUpload> {
  const mode = options.encryption ?? "none";
  const sniffer = headSniffer();
  let piped: Readable = stream.pipe(sniffer.transform);
  // Errors of the source surface through pipeline() inside stage(); the sniffer only copies.
  stream.on("error", (error) => sniffer.transform.destroy(error));
  let encrypted: EncryptedStage | undefined;
  let encrypt: ReturnType<typeof createEncryptStream> | undefined;
  if (mode !== "none") {
    if (!deps.crypto) throw encryptionUnavailable(mode);
    const keyringId = await deps.crypto.assertUploadable(mode, options.keyringId);
    const fileId = uuidv7();
    const fk = newFileKey();
    encrypt = createEncryptStream(fk, fileId, {
      segmentSize: deps.crypto.segmentSize,
      plaintextLength: options.plaintextLength,
    });
    const meter = options.maxBytes === undefined ? null : plaintextMeter(options.maxBytes);
    const tail = encrypt;
    sniffer.transform.on("error", (error) => tail.destroy(error));
    if (meter) {
      meter.on("error", (error) => tail.destroy(error));
      piped = piped.pipe(meter);
    }
    piped = piped.pipe(encrypt);
    encrypted = { mode, fileId, fk, keyringId, plaintextLength: 0, format: JSV_VERSION };
  }
  try {
    const staged = await deps.storage.stage(piped, {
      // The ciphertext is a little longer than the plaintext: the plaintext meter decides.
      maxBytes: encrypted ? undefined : options.maxBytes,
    });
    if (encrypted && encrypt) encrypted.plaintextLength = encrypt.plaintextLength;
    return { staged, head: sniffer.head(), encrypted };
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
  /** The folder the file goes into (resolved by the caller); `null` or absent: the root. */
  folderId?: string | null | undefined;
  /**
   * The previous version this upload supersedes (a live file of the same instance): the new
   * row points at it with `parent_id`, inherits its `filename` and `folder_id` unless given,
   * and the previous version stays live.
   */
  parent?: FileRow | null | undefined;
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
 * exists), soft-deletes the previous file of `slug`, resolves the collision rename (per
 * folder) and inserts. A new version (`parent`) keeps the name of the version it supersedes
 * when the client sent none or the same one — no `(1)` rename against its own chain.
 * On failure the staged blob is discarded. After the commit a `created` event goes out for
 * the new row, and a `deleted` one for every live file of `slug` it replaced.
 */
export async function finalizeUpload(
  deps: FilesDeps,
  input: FinalizeUploadInput,
): Promise<FileInfo> {
  const { scope, upload } = input;
  const slug = input.slug ?? null;
  const parent = input.parent ?? null;
  const givenName = input.filename ? sanitizeFilename(input.filename) : null;
  // The name of an encrypted parent is in its `meta_ct`; without the key it has none to inherit.
  const parentName =
    parent === null
      ? null
      : parent.encryption === "none"
        ? parent.filename
        : ((await deps.crypto?.reveal(parent))?.filename ?? null);
  const inherited =
    parent !== null && parentName !== null && (givenName === null || givenName === parentName);
  const filename = inherited
    ? (parentName as string)
    : (givenName ?? sanitizeFilename(null, slug ?? "unnamed"));
  const folderId =
    input.folderId === undefined && parent ? parent.folderId : (input.folderId ?? null);
  const detected = await detectMimeDetailed({
    head: upload.head,
    filename,
    declared: input.declaredMime,
  });
  const mimeType = detected.mime;
  const extension = extensionOf(filename);
  const kind = kindForMime(mimeType);
  const metadata = input.metadata ?? {};
  const now = (deps.now ?? (() => new Date()))();
  let committed = false;

  // An encrypted file: the row shows nothing but the id, the real values are sealed under the
  // file key, and the key is wrapped by the mode's provider BEFORE anything is committed.
  const enc = upload.encrypted;
  let sealed: { fkCt: Buffer; keyringId: string | null; metaCt: Buffer; meta: FileMeta } | null =
    null;
  if (enc) {
    if (!deps.crypto) {
      await deps.storage.discard(upload.staged);
      throw encryptionUnavailable(enc.mode);
    }
    const meta: FileMeta = {
      filename,
      mime: mimeType,
      metadata,
      sniffed: detected.source === "magic",
    };
    try {
      const { fkCt, keyringId } = await deps.crypto.wrapNewKey(enc.mode, enc.fk, {
        fileId: enc.fileId,
        tenantId: scope.tenantId,
        keyringId: enc.keyringId,
      });
      sealed = { fkCt, keyringId, metaCt: sealMeta(enc.fk, enc.fileId, meta), meta };
    } catch (error) {
      await deps.storage.discard(upload.staged);
      throw error;
    } finally {
      enc.fk.fill(0);
    }
  }

  try {
    // A concurrent upsert of the same slug trips the partial unique index: retry, the other
    // row is live by then and gets soft-deleted on the next pass.
    for (let attempt = 1; ; attempt++) {
      try {
        const { info, replaced } = await deps.db.transaction(async (tx) => {
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
          const replaced = slug
            ? await tx
                .update(files)
                .set({ deletedAt: now, deletedBy: input.userId, updatedAt: now })
                .where(and(instanceWhere(scope), eq(files.slug, slug), isNull(files.deletedAt)))
                .returning({ id: files.id, folderId: files.folderId })
            : [];
          // No collision rename for an encrypted file: its stored name is `<id>.bin`, and the
          // real names of its neighbours are sealed (the UI tells them apart by id).
          const resolved =
            inherited || enc ? filename : await resolveFilename(tx, scope, filename, folderId);
          const [row] = await tx
            .insert(files)
            .values(
              enc && sealed
                ? {
                    id: enc.fileId,
                    tenantId: scope.tenantId,
                    instanceType: scope.instanceType,
                    instanceId: scope.instanceId,
                    slug,
                    hash: upload.staged.hash,
                    // The PLAINTEXT length: quotas and the UI count what the user stored.
                    size: enc.plaintextLength,
                    filename: `${enc.fileId}.bin`,
                    extension: null,
                    mimeType: ENCRYPTED_STORED_MIME,
                    kind: "other",
                    metadata: {},
                    folderId,
                    parentId: parent?.id ?? null,
                    encryption: enc.mode,
                    encFormat: enc.format,
                    keyringId: sealed.keyringId,
                    fkCt: sealed.fkCt,
                    metaCt: sealed.metaCt,
                    createdBy: input.userId,
                    createdAt: now,
                    updatedAt: now,
                  }
                : {
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
                    folderId,
                    parentId: parent?.id ?? null,
                    createdBy: input.userId,
                    // Millisecond timestamps from here, so the list cursor compares exactly.
                    createdAt: now,
                    updatedAt: now,
                  },
            )
            .returning();
          const info = serializeFile(row as FileRow);
          return { info: sealed ? revealFile(info, sealed.meta) : info, replaced };
        });
        // Best effort, after the commit: a value the vocabulary does not know is queued for review.
        await recordFileCandidates(deps.lookups, info);
        await publishFileEvents(deps, { ...scope, kind: "deleted" }, replaced);
        await publishFileEvent(deps, {
          ...scope,
          folderId: info.folder_id,
          fileId: info.id,
          kind: "created",
        });
        // Background work (thumbnails) for the new file; `afterUpload` never throws.
        if (deps.jobs) {
          info.processing_status = await deps.jobs.afterUpload({
            id: info.id,
            tenantId: scope.tenantId,
            mimeType: info.mime_type,
            encryption: info.encryption,
          });
        }
        return info;
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

/** The live files of one folder of the instance (`null`: the root). */
function folderWhere(scope: InstanceScope, folderId: string | null) {
  return and(
    instanceWhere(scope),
    folderId ? eq(files.folderId, folderId) : isNull(files.folderId),
    isNull(files.deletedAt),
  );
}

/**
 * The free name for `filename` among the live files of the folder: one exact lookup for the
 * common case, and only on a collision the `base (n).ext` candidates.
 */
async function resolveFilename(
  tx: Tx,
  scope: InstanceScope,
  filename: string,
  folderId: string | null,
): Promise<string> {
  const namespace = folderWhere(scope, folderId);
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

/**
 * The file `fileId` of the instance a reader may see: the tenant's own, or — `is_public` —
 * another tenant's with the same `(type, id, fileId)` (the vola-spp rule: knowing the three
 * ids of a public file is enough for any authenticated tenant). `404 file_not_found` otherwise.
 */
export async function findReadableFile(
  deps: FilesDeps,
  scope: InstanceScope,
  fileId: string,
): Promise<FileRow> {
  if (!UUID_RE.test(fileId)) throw fileNotFound();
  const [row] = await deps.db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instanceType, scope.instanceType),
        eq(files.instanceId, scope.instanceId),
        eq(files.id, fileId.toLowerCase()),
        isNull(files.deletedAt),
        or(eq(files.tenantId, scope.tenantId), eq(files.isPublic, true)),
      ),
    )
    .limit(1);
  if (!row) throw fileNotFound();
  return row;
}

/**
 * The live file named `filename` in the folder (`null`: the root) of the instance; with
 * versions several live rows share a name and the newest answers.
 */
export async function findFileInFolder(
  deps: FilesDeps,
  scope: InstanceScope,
  folderId: string | null,
  filename: string,
): Promise<FileRow> {
  if (!filename) throw fileNotFound();
  const [row] = await deps.db
    .select()
    .from(files)
    .where(and(folderWhere(scope, folderId), eq(files.filename, filename)))
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(1);
  if (!row) throw fileNotFound();
  return row;
}

/**
 * The file an anonymous `GET /public/:fileId` may serve: live, `is_global_public`, and not
 * encrypted (that flag cannot be set on an encrypted file; checked again here). No tenant.
 */
export async function findGlobalPublicFile(deps: FilesDeps, fileId: string): Promise<FileRow> {
  if (!UUID_RE.test(fileId)) throw fileNotFound();
  const [row] = await deps.db
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, fileId.toLowerCase()),
        eq(files.isGlobalPublic, true),
        eq(files.encryption, "none"),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw fileNotFound();
  return row;
}

// --- patch -------------------------------------------------------------------------------

export interface FilePatchInput {
  /** The folder to move into (resolved by the caller), `null` for the root; absent: unchanged. */
  folderId?: string | null | undefined;
  /** The new name (sanitised here); absent: unchanged. */
  filename?: string | undefined;
  isPublic?: boolean | undefined;
  isGlobalPublic?: boolean | undefined;
  userId: string | null;
}

/**
 * Moves, renames and/or changes the visibility of the tenant's own file `fileId`. A move or
 * rename lands on a `(folder, filename)` that must be free among the live files of the
 * folder — `409 file_exists` otherwise (the versions of this file excepted: they share the
 * name by design). `is_global_public` on an encrypted file is `409 encrypted_not_public`.
 */
export async function patchFile(
  deps: FilesDeps,
  scope: InstanceScope,
  fileId: string,
  patch: FilePatchInput,
): Promise<FileInfo> {
  const row = await findFile(deps, scope, fileId);
  const folderId = patch.folderId === undefined ? row.folderId : patch.folderId;
  if (patch.isGlobalPublic === true && row.encryption !== "none") {
    throw new VolaError(
      "encrypted_not_public",
      409,
      "an encrypted file cannot be made globally public",
    );
  }
  // The name of an encrypted file lives in `meta_ct`: a rename re-seals it (no collision rule,
  // the stored name stays `<id>.bin`). Only when the server holds the key (`tenant`).
  if (patch.filename !== undefined && row.encryption !== "none") {
    return renameEncrypted(deps, scope, row, patch);
  }
  const filename = patch.filename === undefined ? row.filename : sanitizeFilename(patch.filename);
  const relocates = folderId !== row.folderId || filename !== row.filename;
  if (relocates) {
    const family = new Set((await versionFamily(deps.db, row)).map((f) => f.id));
    const taken = await deps.db
      .select({ id: files.id })
      .from(files)
      .where(and(folderWhere(scope, folderId), eq(files.filename, filename)));
    if (taken.some((f) => !family.has(f.id))) {
      throw new VolaError("file_exists", 409, `a file "${filename}" already exists in that folder`);
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  const [updated] = await deps.db
    .update(files)
    .set({
      folderId,
      filename,
      extension: filename === row.filename ? row.extension : extensionOf(filename),
      isPublic: patch.isPublic ?? row.isPublic,
      isGlobalPublic: patch.isGlobalPublic ?? row.isGlobalPublic,
      updatedAt: now,
    })
    .where(and(eq(files.id, row.id), isNull(files.deletedAt)))
    .returning();
  if (!updated) throw fileNotFound();
  deps.logger?.info(
    {
      file: row.id,
      ...(relocates ? { folder: folderId, filename } : {}),
      is_public: updated.isPublic,
      is_global_public: updated.isGlobalPublic,
    },
    "file updated",
  );
  await publishFileEvent(deps, {
    ...scope,
    folderId: updated.folderId,
    fileId: updated.id,
    kind: "updated",
  });
  if (updated.isPublic !== row.isPublic || updated.isGlobalPublic !== row.isGlobalPublic) {
    deps.audit?.emit({
      event_type: "VOLA_FILE_VISIBILITY_CHANGED",
      instance_type: "vola_file",
      instance_id: updated.id,
      payload: {
        ...fileAuditPayload(updated),
        is_public: updated.isPublic,
        is_global_public: updated.isGlobalPublic,
        previous: { is_public: row.isPublic, is_global_public: row.isGlobalPublic },
      },
    });
  }
  return withProcessingStatus(deps, updated);
}

/** `patchFile` for an encrypted row with a new name: the metadata record is re-sealed under the file key. */
async function renameEncrypted(
  deps: FilesDeps,
  scope: InstanceScope,
  row: FileRow,
  patch: FilePatchInput,
): Promise<FileInfo> {
  if (!deps.crypto) throw encryptionUnavailable(row.encryption);
  const { fk, meta } = await deps.crypto.open(row);
  const filename = sanitizeFilename(patch.filename);
  const metaCt = sealMeta(fk, row.id, { ...meta, filename });
  fk.fill(0);
  const folderId = patch.folderId === undefined ? row.folderId : patch.folderId;
  const now = (deps.now ?? (() => new Date()))();
  const [updated] = await deps.db
    .update(files)
    .set({
      folderId,
      metaCt,
      isPublic: patch.isPublic ?? row.isPublic,
      isGlobalPublic: patch.isGlobalPublic ?? row.isGlobalPublic,
      updatedAt: now,
    })
    .where(and(eq(files.id, row.id), isNull(files.deletedAt)))
    .returning();
  if (!updated) throw fileNotFound();
  // Never the name: it is what the encryption protects.
  deps.logger?.info({ file: row.id, folder: folderId, renamed: true }, "file updated");
  await publishFileEvent(deps, {
    ...scope,
    folderId: updated.folderId,
    fileId: updated.id,
    kind: "updated",
  });
  return withProcessingStatus(deps, updated);
}

// --- versions ----------------------------------------------------------------------------

/**
 * The version chain of the tenant's file `fileId` — every row linked through `parent_id`,
 * older and newer — newest first; soft-deleted versions only with `includeDeleted`.
 */
export async function listVersions(
  deps: FilesDeps,
  scope: InstanceScope,
  fileId: string,
  options: FindOptions = {},
): Promise<FileVersions> {
  const row = await findFile(deps, scope, fileId, { includeDeleted: true });
  const family = (await versionFamily(deps.db, row))
    .filter((f) => options.includeDeleted || f.deletedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return { versions: await describeFiles(deps, family) };
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
    files: await describeFiles(deps, page),
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
  if (row.deletedAt) return withProcessingStatus(deps, row);
  const now = (deps.now ?? (() => new Date()))();
  const [updated] = await deps.db
    .update(files)
    .set({ deletedAt: now, deletedBy: userId, updatedAt: now })
    .where(and(eq(files.id, row.id), isNull(files.deletedAt)))
    .returning();
  await publishFileEvent(deps, {
    ...scope,
    folderId: row.folderId,
    fileId: row.id,
    kind: "deleted",
  });
  deps.audit?.emit({
    event_type: "VOLA_FILE_DELETED",
    instance_type: "vola_file",
    instance_id: row.id,
    payload: fileAuditPayload(row),
  });
  return withProcessingStatus(
    deps,
    updated ?? { ...row, deletedAt: now, deletedBy: userId, updatedAt: now },
  );
}

/**
 * Every row linked to `row` through `parent_id`, older and newer versions alike, within the
 * tenant, soft-deleted ones included (`[row]` for a file without versions).
 */
export async function versionFamily(db: Database, row: FileRow): Promise<FileRow[]> {
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
  const gone = new Set(deleted.map((f) => f.id));
  await publishFileEvents(
    deps,
    { ...scope, kind: "purged" },
    family.filter((f) => gone.has(f.id)),
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
  deps.audit?.emit({
    event_type: "VOLA_FILE_PURGED",
    instance_type: "vola_file",
    instance_id: row.id,
    payload: {
      ...fileAuditPayload(row),
      versions: ids,
      files: deleted.length,
      blobs,
    },
  });
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
