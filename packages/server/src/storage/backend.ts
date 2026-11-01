import type { Readable } from "node:stream";

/** A SHA-256 as 64 lowercase hex characters: the only form a blob is ever addressed by. */
export const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Name of a derived file (thumbnail, OCR text, …) kept next to its blob: a safe filename
 * token — no separators, no leading dot — such as `thumb.128.center.webp`.
 */
export const DERIVED_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/** `hash` is not a lowercase SHA-256 hex digest (also catches every path-traversal attempt). */
export class InvalidHashError extends Error {
  constructor(hash: string) {
    super(`invalid blob hash: ${JSON.stringify(hash)}`);
    this.name = "InvalidHashError";
  }
}

/** A derived-file name that is not a plain filename token. */
export class InvalidDerivedNameError extends Error {
  constructor(name: string) {
    super(`invalid derived file name: ${JSON.stringify(name)}`);
    this.name = "InvalidDerivedNameError";
  }
}

/** The blob (or derived file) is not on disk. */
export class BlobNotFoundError extends Error {
  constructor(
    readonly hash: string,
    readonly derived?: string,
  ) {
    super(derived ? `derived file ${derived} of blob ${hash} not found` : `blob ${hash} not found`);
    this.name = "BlobNotFoundError";
  }
}

/** The stream carried more than `maxBytes` (`PutOptions.maxBytes`). */
export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`file larger than ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

/** A closed byte interval of a blob; `end` is INCLUSIVE, like the `Range` header. */
export interface ByteSpan {
  start: number;
  end: number;
}

export interface PutOptions {
  /** Abort (and clean up) once the stream exceeds this many bytes. */
  maxBytes?: number | undefined;
}

/** Bytes written to the temporary area, hashed, but not yet in the content-addressable store. */
export interface StagedBlob {
  /** SHA-256 hex of the bytes. */
  hash: string;
  size: number;
  /** The temporary file; `commit` moves it, `discard` deletes it. */
  tmpPath: string;
}

export interface StoredBlob {
  hash: string;
  size: number;
  /** Absolute path of the blob on disk. */
  path: string;
  /** `true`: the blob was already there, nothing was written (the temp file was dropped). */
  deduplicated: boolean;
}

export interface BlobStat {
  size: number;
  path: string;
}

/**
 * Content-addressable blob storage shared by every tenant: the SAME bytes are one blob, so
 * tenant isolation lives in the metadata layer (database rows), never in the layout.
 *
 * `put` = `stage` + `commit`. The split exists so a caller can hold a database lock on the
 * hash while the blob is committed (upload) or removed (purge) — the two must not race.
 * Derived files (thumbnails, …) live next to their blob and vanish with it.
 */
export interface StorageBackend {
  /** Streams `stream` into the temporary area, computing the SHA-256 and size on the way. */
  stage(stream: Readable, options?: PutOptions): Promise<StagedBlob>;
  /** Moves a staged blob into the store (atomically); an existing blob is never overwritten. */
  commit(staged: StagedBlob): Promise<StoredBlob>;
  /** Deletes a staged blob that will not be committed. */
  discard(staged: StagedBlob): Promise<void>;
  /** `stage` + `commit` (with the temp file discarded on failure). */
  put(stream: Readable, options?: PutOptions): Promise<StoredBlob>;
  /** A readable of the blob, or of `range` of it. Throws `BlobNotFoundError`. */
  open(hash: string, range?: ByteSpan): Promise<Readable>;
  stat(hash: string): Promise<BlobStat | null>;
  exists(hash: string): Promise<boolean>;
  /** Removes the blob and every derived file; `false` when there was no blob. */
  remove(hash: string): Promise<boolean>;
  /** Writes (or replaces) a derived file of an existing blob; returns its path. */
  putDerived(hash: string, name: string, data: Buffer | Readable): Promise<string>;
  /** A readable of a derived file. Throws `BlobNotFoundError` (with `derived`). */
  openDerived(hash: string, name: string): Promise<Readable>;
  statDerived(hash: string, name: string): Promise<BlobStat | null>;
  /** Where the blob is (or would be) on disk. */
  blobPath(hash: string): string;
}

/** Throws `InvalidHashError` unless `hash` is a lowercase SHA-256 hex digest. */
export function assertHash(hash: string): string {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new InvalidHashError(String(hash));
  return hash;
}

/** Throws `InvalidDerivedNameError` unless `name` is a safe derived-file token. */
export function assertDerivedName(name: string): string {
  if (typeof name !== "string" || !DERIVED_NAME_RE.test(name)) {
    throw new InvalidDerivedNameError(String(name));
  }
  return name;
}
