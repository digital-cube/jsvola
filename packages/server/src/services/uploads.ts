import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FileEncryption, FileInfo } from "@vol-a/core";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  HEADER_BYTES,
  IntegrityError,
  type JsvHeader,
  parseHeader,
  plaintextLengthOf,
} from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { type FileRow, type UploadRow, uploads } from "../db/schema.js";
import { uuidv7 } from "../db/uuid.js";
import { VolaError } from "../errors.js";
import type { FileEventBus } from "../events/bus.js";
import { sanitizeFilename } from "../files/filename.js";
import type { JobDispatcher } from "../jobs/dispatcher.js";
import type { Lookups } from "../lookups.js";
import type { StorageBackend } from "../storage/index.js";
import { PartOverflowError, type PartStore } from "../uploads/part-store.js";
import { type EncryptionService, encryptionUnavailable } from "./encryption.js";
import {
  type FilesDeps,
  finalizeUpload,
  findFile,
  type InstanceScope,
  parseInstance,
  parseMetadata,
  parseSlug,
  type StagedUpload,
  stageUpload,
} from "./files.js";
import {
  effectiveKeyringId,
  effectiveKeyringIdOfPath,
  type FoldersDeps,
  parsePath,
  resolveFolderId,
} from "./folders.js";
import {
  type AnyEncState,
  appendEncrypted,
  type ClientEncState,
  createEncState,
  ENC_STATE_VERSION,
  type EncState,
  finishEncrypted,
  parseEncState,
} from "./upload-crypto.js";

export interface UploadsDeps {
  db: Database;
  storage: StorageBackend;
  parts: PartStore;
  /** `VOLA_MAX_UPLOAD_BYTES`: the largest `Upload-Length` accepted (`Tus-Max-Size`). */
  maxUploadBytes: number;
  /** `VOLA_UPLOAD_TTL_HOURS` in milliseconds: how long an unfinished upload is kept. */
  ttlMs: number;
  logger?: FastifyBaseLogger | undefined;
  /** The vocabulary unknown `kind` / `encryption` values are recorded against. */
  lookups?: Lookups | undefined;
  /** Where the completed file is announced (real-time `subscribe`); absent: nowhere. */
  events?: FileEventBus | undefined;
  /** Background jobs of the completed file (`async` mode). */
  jobs?: JobDispatcher | undefined;
  /** Encryption (plans 6.1–6.3): an upload created with `encryption != none` is encrypted segment by segment as its bytes arrive. */
  crypto?: EncryptionService | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PostgreSQL: `SELECT … FOR UPDATE NOWAIT` found the row locked. */
const LOCK_NOT_AVAILABLE = "55P03";
const pgCode = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code ??
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const clock = (deps: UploadsDeps) => (deps.now ?? (() => new Date()))();

function filesDeps(deps: UploadsDeps): FilesDeps {
  return {
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    lookups: deps.lookups,
    events: deps.events,
    jobs: deps.jobs,
    crypto: deps.crypto,
    now: deps.now,
  };
}
function foldersDeps(deps: UploadsDeps): FoldersDeps {
  return { db: deps.db, logger: deps.logger, events: deps.events, now: deps.now };
}

/** The one answer for an upload that is not there — or belongs to another tenant (never 403). */
export function uploadNotFound(): VolaError {
  return new VolaError("upload_not_found", 404, "upload not found");
}

function validation(message: string): VolaError {
  return new VolaError("validation_error", 422, message);
}

/** The part file is gone (a crash between committing the blob and recording the file). */
function uploadLost(): VolaError {
  return new VolaError(
    "upload_lost",
    410,
    "the bytes of this upload are no longer on disk; start a new one",
  );
}

/** The scope of an upload row: the instance its file will land in. */
export function uploadScope(row: UploadRow): InstanceScope {
  return { tenantId: row.tenantId, instanceType: row.instanceType, instanceId: row.instanceId };
}

// --- create ------------------------------------------------------------------------------

/** What `Upload-Metadata` carried, decoded; the route parses the header, the service validates. */
export interface CreateUploadInput {
  tenantId: string;
  apiKeyId: string;
  userId: string | null;
  /** `Upload-Length`, already a non-negative integer. */
  length: number;
  instanceType: string;
  instanceId: string;
  filename: string;
  folderPath?: string | undefined;
  parentId?: string | undefined;
  slug?: string | undefined;
  contentType?: string | undefined;
  /** The `metadata` pair: a JSON object as text. */
  metadata?: string | undefined;
  /** The `encryption` pair or `X-Vola-Encryption`: `none` | `tenant` | `keyring` | `caller` | `client`; absent: the folder policy, else the tenant default. */
  encryption?: string | undefined;
  /** `client` mode: the `fk_ct` pair (base64), required. */
  fkCt?: string | undefined;
  /** `client` mode: the `meta_ct` pair (base64), optional. */
  metaCt?: string | undefined;
}

export interface CreatedUpload {
  upload: UploadRow;
  /** Set when the upload was complete at creation (`Upload-Length: 0`). */
  file: FileInfo | null;
  /** The id the file WILL have (an encrypted upload draws it at creation: it is in every AAD). */
  fileId: string | null;
}

/** The id the completed file of `row` has or will have (`Vola-File-Id`). */
export function futureFileId(row: UploadRow): string | null {
  if (row.completedFileId) return row.completedFileId;
  const enc = row.encState as { file_id?: unknown } | null;
  return typeof enc?.file_id === "string" ? enc.file_id : null;
}

const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
/** The longest `fk_ct` / `meta_ct` a client may hand over (base64 decoded). */
const CLIENT_FK_CT_MAX_BYTES = 256;
const CLIENT_META_CT_MAX_BYTES = 256 * 1024;

/** A base64 record a `client` upload hands over, decoded and bounded; `422` otherwise. */
function clientRecord(raw: string | undefined, name: string, max: number, required: boolean) {
  if (raw === undefined || raw === "") {
    if (required) throw validation(`${name}: required for encryption=client (base64)`);
    return null;
  }
  const value = raw.trim();
  if (!B64_RE.test(value)) throw validation(`${name}: base64 is required`);
  const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length < 28 || bytes.length > max) {
    throw validation(`${name}: between 28 and ${max} bytes`);
  }
  return bytes;
}

/**
 * Creates an upload: validates the instance, the optional folder path, slug and parent (the
 * parent must be a live file of the instance NOW; it is looked up again at completion),
 * inserts the row with `expires_at = now + ttl` and creates its empty part file. A zero-length
 * upload is complete at once and goes straight through `finalizeUpload`, since a tus client
 * sends no PATCH for it.
 */
export async function createUpload(
  deps: UploadsDeps,
  input: CreateUploadInput,
): Promise<CreatedUpload> {
  if (!Number.isSafeInteger(input.length) || input.length < 0) {
    throw validation("Upload-Length: a non-negative integer is required");
  }
  if (input.length > deps.maxUploadBytes) {
    throw new VolaError(
      "file_too_large",
      413,
      `the upload exceeds the limit of ${deps.maxUploadBytes} bytes`,
    );
  }
  const scope = parseInstance(input.tenantId, input.instanceType, input.instanceId);
  if (!input.filename?.trim()) throw validation("filename: required");
  const filename = sanitizeFilename(input.filename);
  const folderPath =
    input.folderPath === undefined ? null : parsePath(input.folderPath, "folder_path");
  const slug = input.slug === undefined ? null : parseSlug(input.slug);
  const metadata = parseMetadata(input.metadata);
  let parent: FileRow | null = null;
  if (input.parentId !== undefined) {
    if (!UUID_RE.test(input.parentId)) throw validation("parent_id: must be a UUID");
    parent = await findFile(filesDeps(deps), scope, input.parentId);
  }
  // Decided at creation (and checked to be servable), so a client knows before it sends a
  // byte: a folder policy (6.2) outranks the explicit mode; `keyring` needs the unlock NOW
  // (and on every PATCH: each one unwraps the file key), `caller` the content key likewise.
  let encryption: FileEncryption = "none";
  let policy: string | null = null;
  if (deps.crypto) {
    policy =
      folderPath === null
        ? await effectiveKeyringId(foldersDeps(deps), scope, parent?.folderId ?? null)
        : await effectiveKeyringIdOfPath(foldersDeps(deps), scope, folderPath);
    encryption = await deps.crypto.resolveMode(
      scope.tenantId,
      deps.crypto.parseMode(input.encryption, { client: true }),
      policy,
    );
    if (encryption !== "none" && encryption !== "client") {
      await deps.crypto.assertUploadable(encryption, policy);
    }
  } else if (
    input.encryption !== undefined &&
    input.encryption !== "" &&
    input.encryption !== "none"
  ) {
    throw new VolaError("encryption_unavailable", 503, "encryption is not configured");
  }
  // A `client` blob comes with its wrapped key; `fk_ct` without `client` is a mistake worth naming.
  let client: ClientEncState | null = null;
  if (encryption === "client") {
    if (policy) {
      throw validation(
        "encryption: this folder's policy encrypts under a keyring; a client-encrypted blob cannot go there",
      );
    }
    const fkCt = clientRecord(input.fkCt, "fk_ct", CLIENT_FK_CT_MAX_BYTES, true) as Buffer;
    const metaCt = clientRecord(input.metaCt, "meta_ct", CLIENT_META_CT_MAX_BYTES, false);
    if (input.length < HEADER_BYTES + 16) {
      throw validation("Upload-Length: a JSV blob is at least 40 bytes (header and one tag)");
    }
    client = {
      v: ENC_STATE_VERSION,
      mode: "client",
      file_id: uuidv7(),
      fk_ct: fkCt.toString("base64"),
      meta_ct: metaCt ? metaCt.toString("base64") : null,
    };
  } else if (input.fkCt !== undefined || input.metaCt !== undefined) {
    throw validation("fk_ct / meta_ct: only with encryption=client");
  }
  const now = clock(deps);
  const [row] = await deps.db
    .insert(uploads)
    .values({
      tenantId: scope.tenantId,
      apiKeyId: input.apiKeyId,
      instanceType: scope.instanceType,
      instanceId: scope.instanceId,
      folderPath,
      parentId: parent?.id ?? null,
      slug,
      filename,
      declaredMime: input.contentType?.trim() || null,
      metadata,
      length: input.length,
      offset: 0,
      encryption,
      encState: client as Record<string, unknown> | null,
      createdBy: input.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + deps.ttlMs),
    })
    .returning();
  let upload = row as UploadRow;
  try {
    await deps.parts.create(upload.id);
    // A server-encrypted upload: the file key, the blob header and the hash start NOW, so
    // the first PATCH has nothing to decide and the part file is ciphertext from byte 0.
    if (encryption !== "none" && encryption !== "client") {
      if (!deps.crypto) throw encryptionUnavailable(encryption);
      const enc = await createEncState(deps.crypto, deps.parts, {
        uploadId: upload.id,
        tenantId: scope.tenantId,
        mode: encryption,
        keyringId: policy,
        length: input.length,
      });
      const [stored] = await deps.db
        .update(uploads)
        .set({ encState: enc as unknown as Record<string, unknown> })
        .where(eq(uploads.id, upload.id))
        .returning();
      upload = stored as UploadRow;
    }
  } catch (error) {
    await deps.parts.remove(upload.id).catch(() => undefined);
    await deps.db.delete(uploads).where(eq(uploads.id, upload.id));
    throw error;
  }
  deps.logger?.info(
    {
      upload: upload.id,
      length: upload.length,
      encryption,
      instance: `${scope.instanceType}/${scope.instanceId}`,
    },
    "upload created",
  );
  if (upload.length > 0) return { upload, file: null, fileId: futureFileId(upload) };
  const file = await deps.db.transaction(async (tx) => {
    const locked = await lockUpload(tx, scope.tenantId, upload.id);
    // An encrypted empty file is one empty, sealed last segment: the "flush" writes it.
    const enc = parseEncState(locked.encState);
    if (enc && enc.mode !== "client" && deps.crypto) {
      const flushed = await appendEncrypted(deps.crypto, deps.parts, enc, {
        uploadId: locked.id,
        tenantId: scope.tenantId,
        length: 0,
        offset: 0,
        body: null,
        room: 0,
      });
      await tx
        .update(uploads)
        .set({ encState: flushed.enc as unknown as Record<string, unknown> })
        .where(eq(uploads.id, locked.id));
      locked.encState = flushed.enc as unknown as Record<string, unknown>;
    }
    return completeLocked(deps, tx, locked);
  });
  return { upload: { ...upload, completedFileId: file.id }, file, fileId: file.id };
}

// --- lookup ------------------------------------------------------------------------------

/** The tenant's upload `uploadId`; `404 upload_not_found` otherwise, `410 upload_expired` past its TTL. */
export async function findUpload(
  deps: UploadsDeps,
  tenantId: string,
  uploadId: string,
): Promise<UploadRow> {
  if (!UUID_RE.test(uploadId)) throw uploadNotFound();
  const [row] = await deps.db
    .select()
    .from(uploads)
    .where(and(eq(uploads.tenantId, tenantId), eq(uploads.id, uploadId.toLowerCase())))
    .limit(1);
  if (!row) throw uploadNotFound();
  assertNotExpired(deps, row);
  return row;
}

function assertNotExpired(deps: UploadsDeps, row: UploadRow): void {
  if (row.completedFileId === null && row.expiresAt.getTime() <= clock(deps).getTime()) {
    throw new VolaError("upload_expired", 410, "the upload expired; start a new one");
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The row under `FOR UPDATE NOWAIT`: a second PATCH (or DELETE) on the same upload while one
 * is streaming does not wait — `409 upload_locked` at once.
 */
async function lockUpload(tx: Tx, tenantId: string, uploadId: string): Promise<UploadRow> {
  if (!UUID_RE.test(uploadId)) throw uploadNotFound();
  let rows: UploadRow[];
  try {
    rows = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.tenantId, tenantId), eq(uploads.id, uploadId.toLowerCase())))
      .for("update", { noWait: true });
  } catch (error) {
    if (pgCode(error) === LOCK_NOT_AVAILABLE) {
      throw new VolaError(
        "upload_locked",
        409,
        "another request is writing to this upload; retry when it has finished",
      );
    }
    throw error;
  }
  const [row] = rows;
  if (!row) throw uploadNotFound();
  return row;
}

// --- append ------------------------------------------------------------------------------

export interface AppendInput {
  tenantId: string;
  uploadId: string;
  /** `Upload-Offset` of the request; must equal the stored offset. */
  offset: number;
  body: Readable;
  /** `Content-Length` of the request, when the client sent one: checked against the room left. */
  contentLength?: number | undefined;
  /** `X-User-Id` of this request (attribution of the file when this PATCH completes it). */
  userId: string | null;
}

export interface AppendResult {
  upload: UploadRow;
  /** The file this PATCH completed, when it did. */
  file: FileInfo | null;
}

/**
 * `PATCH`: appends the body at the upload's offset. The row is locked for the duration
 * (`FOR UPDATE NOWAIT` → a parallel PATCH is `409 upload_locked`), the request offset must
 * match (`409 upload_offset_mismatch`), the bytes go to the part file and the new offset is
 * committed only after `fsync`. A client that dies mid-body still gets what arrived counted:
 * the offset is committed and the error re-thrown afterwards, so the next `HEAD` is exact.
 * When the offset reaches the length the upload completes in the same transaction.
 */
export async function appendUpload(deps: UploadsDeps, input: AppendInput): Promise<AppendResult> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new VolaError("bad_request", 400, "Upload-Offset: a non-negative integer is required");
  }
  const outcome = await deps.db.transaction(async (tx) => {
    const row = await lockUpload(tx, input.tenantId, input.uploadId);
    assertNotExpired(deps, row);
    if (row.completedFileId !== null) {
      throw new VolaError("upload_completed", 409, "the upload is complete; nothing more to send");
    }
    if (input.offset !== row.offset) {
      throw new VolaError(
        "upload_offset_mismatch",
        409,
        `Upload-Offset ${input.offset} does not match the current offset ${row.offset}`,
      );
    }
    const room = row.length - row.offset;
    if (input.contentLength !== undefined && input.contentLength > room) {
      throw new VolaError(
        "upload_overflow",
        400,
        `Content-Length ${input.contentLength} exceeds the ${room} bytes left before Upload-Length`,
      );
    }
    if ((await deps.parts.size(row.id)) === null) throw uploadLost();
    const enc = parseEncState(row.encState);
    let appended: { size: number; error: Error | null; encState?: EncState };
    try {
      if (enc && enc.mode !== "client") {
        // Segment by segment, under the key of THIS request (423 / 409 / 503 before a byte).
        if (!deps.crypto) throw encryptionUnavailable(enc.mode);
        const result = await appendEncrypted(deps.crypto, deps.parts, enc, {
          uploadId: row.id,
          tenantId: row.tenantId,
          length: row.length,
          offset: row.offset,
          body: input.body,
          room,
        });
        appended = { size: result.offset, error: result.error, encState: result.enc };
      } else {
        appended = await deps.parts.append(row.id, row.offset, input.body, room);
      }
    } catch (error) {
      if (error instanceof PartOverflowError) {
        throw new VolaError(
          "upload_overflow",
          400,
          `the body exceeds the ${error.room} bytes left before Upload-Length`,
        );
      }
      throw error;
    }
    const [updated] = await tx
      .update(uploads)
      .set({
        offset: appended.size,
        ...(appended.encState
          ? { encState: appended.encState as unknown as Record<string, unknown> }
          : {}),
      })
      .where(eq(uploads.id, row.id))
      .returning();
    const upload = updated as UploadRow;
    if (appended.error || upload.offset < upload.length) {
      return { upload, file: null, error: appended.error };
    }
    const file = await completeLocked(deps, tx, upload, input.userId);
    return { upload: { ...upload, completedFileId: file.id }, file, error: null };
  });
  if (outcome.error) {
    deps.logger?.info(
      { upload: outcome.upload.id, offset: outcome.upload.offset, err: outcome.error },
      "upload body interrupted; offset committed",
    );
    throw outcome.error;
  }
  return { upload: outcome.upload, file: outcome.file };
}

/**
 * The common end of every upload: the part file goes through `finalizeUpload` exactly like
 * the body of a plain `POST /files` (hash, CAS commit with dedup, MIME sniff, collision
 * rename, folder and version, the `vola_file` row) and the upload row records the file.
 * Runs with the upload row locked. The folder path is resolved (created when missing) and
 * the parent looked up again HERE, since either may have changed since creation.
 *
 * An upload created with `encryption != none` already IS the `JSV` blob (`upload-crypto.ts`
 * sealed every segment as it arrived): its hash comes out of the running state, nothing is
 * read twice, and the part is hard-linked into the store. A `client` upload is checked to be
 * a well-formed `JSV` blob (header, lengths) and stored opaque. A folder whose keyring policy
 * was set AFTER a PLAIN upload was created is honoured the 6.2 way — the part file is
 * encrypted now and removed — but a policy that disagrees with an upload already encrypted
 * under another mode or keyring is `422`: the segments cannot be re-sealed.
 */
async function completeLocked(
  deps: UploadsDeps,
  tx: Tx,
  row: UploadRow,
  userId: string | null = null,
): Promise<FileInfo> {
  const scope = uploadScope(row);
  const actor = userId ?? row.createdBy;
  const parent = row.parentId ? await findFile(filesDeps(deps), scope, row.parentId) : null;
  // No folder_path: `undefined` inherits the parent's folder for a version, the root otherwise.
  const folderId =
    row.folderPath === null
      ? undefined
      : await resolveFolderId(foldersDeps(deps), scope, row.folderPath, actor);
  const partSize = await deps.parts.size(row.id);
  if (partSize === null) throw uploadLost();
  const enc: AnyEncState | null = parseEncState(row.encState);
  if (!enc && partSize !== row.length) {
    throw new VolaError(
      "upload_lost",
      410,
      `the part file holds ${partSize} bytes, the upload expects ${row.length}`,
    );
  }
  let encryption = (row.encryption ?? "none") as FileEncryption;
  // The folder's policy as it stands NOW (it may have been set since the upload was created).
  const policy = await effectiveKeyringId(
    foldersDeps(deps),
    scope,
    folderId === undefined ? (parent?.folderId ?? null) : folderId,
  );
  if (policy && (enc?.mode !== "keyring" || enc.keyring_id !== policy)) {
    if (enc) {
      throw validation(
        "the folder's encryption policy changed after this upload was created; delete it and start a new one",
      );
    }
    encryption = "keyring";
  }
  let upload: StagedUpload;
  let plaintextPartToRemove = false;
  if (enc && enc.mode === "client") {
    upload = await stageClientBlob(deps, row, enc, partSize);
  } else if (enc) {
    if (!deps.crypto) throw encryptionUnavailable(enc.mode);
    const finished = await finishEncrypted(deps.crypto, deps.parts, enc, {
      uploadId: row.id,
      tenantId: row.tenantId,
      length: row.length,
    });
    upload = {
      staged: {
        hash: finished.hash,
        size: finished.ciphertextLength,
        tmpPath: deps.parts.path(row.id),
      },
      head: finished.head,
      encrypted: {
        mode: enc.mode,
        fileId: enc.file_id,
        fk: finished.fk,
        keyringId: enc.keyring_id,
        plaintextLength: row.length,
        format: finished.format,
      },
    };
  } else if (encryption === "none") {
    upload = await deps.parts.stage(row.id);
  } else {
    // The 6.2 path: a plain part file that a policy set meanwhile wants encrypted.
    upload = await stageUpload(filesDeps(deps), createReadStream(deps.parts.path(row.id)), {
      encryption,
      keyringId: policy,
      plaintextLength: row.length,
      maxBytes: deps.maxUploadBytes,
    });
    plaintextPartToRemove = true;
  }
  const file = await finalizeUpload(filesDeps(deps), {
    scope,
    upload,
    filename: row.filename,
    declaredMime: row.declaredMime,
    metadata: row.metadata,
    slug: row.slug,
    folderId,
    parent,
    userId: actor,
  });
  await tx
    .update(uploads)
    .set({ completedFileId: file.id, folderId: file.folder_id, offset: row.length })
    .where(eq(uploads.id, row.id));
  // The plaintext part file of a 6.2-style late encryption: the ciphertext is committed, it goes now.
  if (plaintextPartToRemove) await deps.parts.remove(row.id).catch(() => undefined);
  deps.logger?.info(
    {
      upload: row.id,
      file: file.id,
      hash: file.hash,
      size: file.size,
      slug: file.slug,
      encryption: file.encryption,
    },
    "upload completed",
  );
  return file;
}

/**
 * A finished `client` upload as a staged blob: the part is hashed once (it is the blob) and
 * checked to be a `JSV` blob whose arithmetic works out — the header parses, the ciphertext
 * length is a whole number of segments. `422 client_blob_invalid` otherwise. The server
 * cannot verify a tag (it has no key): a blob that is well-formed but does not decrypt is
 * the client's problem, exactly as a `caller` file whose key is lost.
 */
async function stageClientBlob(
  deps: UploadsDeps,
  row: UploadRow,
  enc: ClientEncState,
  partSize: number,
): Promise<StagedUpload> {
  if (partSize !== row.length) {
    throw new VolaError(
      "upload_lost",
      410,
      `the part file holds ${partSize} bytes, the upload expects ${row.length}`,
    );
  }
  let header: JsvHeader;
  let plaintextLength: number;
  try {
    const handle = await open(deps.parts.path(row.id), "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(HEADER_BYTES);
      await handle.read(head, 0, HEADER_BYTES, 0);
    } finally {
      await handle.close();
    }
    header = parseHeader(head);
    plaintextLength = plaintextLengthOf(header, partSize);
  } catch (error) {
    if (error instanceof IntegrityError) {
      throw new VolaError(
        "client_blob_invalid",
        422,
        `the uploaded bytes are not a JSV blob: ${error.reason}`,
      );
    }
    throw error;
  }
  const staged = await deps.parts.stage(row.id);
  return {
    staged: staged.staged,
    head: Buffer.alloc(0),
    encrypted: {
      mode: "client",
      fileId: enc.file_id,
      fk: null,
      fkCt: Buffer.from(enc.fk_ct, "base64"),
      metaCt: enc.meta_ct ? Buffer.from(enc.meta_ct, "base64") : null,
      keyringId: null,
      plaintextLength,
      format: header.version,
    },
  };
}

// --- delete ------------------------------------------------------------------------------

/** `DELETE`: the row and the part file go; `409 upload_locked` while a PATCH is streaming. */
export async function deleteUpload(
  deps: UploadsDeps,
  tenantId: string,
  uploadId: string,
): Promise<void> {
  const row = await deps.db.transaction(async (tx) => {
    const locked = await lockUpload(tx, tenantId, uploadId);
    await tx.delete(uploads).where(eq(uploads.id, locked.id));
    return locked;
  });
  await deps.parts.remove(row.id);
  deps.logger?.info({ upload: row.id, offset: row.offset, length: row.length }, "upload deleted");
}

// --- expiry ------------------------------------------------------------------------------

export interface SweepResult {
  /** Expired rows removed (and their part files). */
  uploads: number;
  /** Part files with no row (a crash between the two writes), older than the TTL, removed. */
  orphans: number;
}

/**
 * Removes every upload past `expires_at` — row and part file — and any part file that has no
 * row and has not been written for a TTL. An upload a PATCH is holding right now is skipped
 * (`NOWAIT`) and caught on the next sweep. Also runs on completed rows: they stay around until
 * their TTL so `HEAD` can still answer `Vola-File-Id`, then go.
 */
export async function sweepExpiredUploads(deps: UploadsDeps): Promise<SweepResult> {
  const now = clock(deps);
  const expired = await deps.db
    .select({ id: uploads.id, tenantId: uploads.tenantId })
    .from(uploads)
    .where(lt(uploads.expiresAt, now));
  let removed = 0;
  for (const { id, tenantId } of expired) {
    try {
      await deleteUpload(deps, tenantId, id);
      removed++;
    } catch (error) {
      if (error instanceof VolaError && (error.code === "upload_locked" || error.status === 404)) {
        continue;
      }
      deps.logger?.error({ err: error, upload: id }, "expired upload not removed");
    }
  }
  let orphans = 0;
  const cutoff = now.getTime() - deps.ttlMs;
  for (const { uploadId, modifiedAt } of await deps.parts.list()) {
    if (modifiedAt.getTime() > cutoff) continue;
    const [row] = await deps.db
      .select({ id: uploads.id })
      .from(uploads)
      .where(eq(uploads.id, uploadId))
      .limit(1);
    if (row) continue;
    await deps.parts.remove(uploadId).catch(() => undefined);
    orphans++;
  }
  if (removed || orphans) {
    deps.logger?.info({ uploads: removed, orphans }, "expired uploads swept");
  }
  return { uploads: removed, orphans };
}
