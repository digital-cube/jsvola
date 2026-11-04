import {
  decodeTusMetadata,
  ENCRYPTION_HEADER,
  encodeTusMetadata,
  TUS_EXTENSION_HEADER,
  TUS_MAX_SIZE_HEADER,
  TUS_PATCH_CONTENT_TYPE,
  TUS_RESUMABLE_HEADER,
  TUS_VERSION,
  TUS_VERSION_HEADER,
  UPLOAD_EXPIRES_HEADER,
  UPLOAD_LENGTH_HEADER,
  UPLOAD_META_KEYS,
  UPLOAD_METADATA_HEADER,
  UPLOAD_OFFSET_HEADER,
  VOLA_FILE_ID_HEADER,
} from "@vol-a/core";
import { type ByteSource, isStreamSource, nameOf, sizeOf, sliceOf, typeOf } from "./body.js";
import type { CallOptions, VolaClient } from "./client.js";
import { isBrowser } from "./env.js";
import { VolaError } from "./errors.js";
import type { UploadPlacement } from "./files.js";

/** Default chunk of a resumable upload: 8 MiB. */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Where a resumable upload remembers which server-side upload a source belongs to, so a
 * second call with the same source continues it: `localStorage` in a browser, memory in
 * Node, or anything with these three methods (a file, a database).
 */
export interface FingerprintStore {
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
  set(key: string, value: string): Promise<void> | void;
  remove(key: string): Promise<void> | void;
}

export class MemoryFingerprintStore implements FingerprintStore {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

/** A `FingerprintStore` over `localStorage` (or any `Storage`). */
export function storageFingerprintStore(storage: Storage): FingerprintStore {
  return {
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
  };
}

const memoryStore = new MemoryFingerprintStore();

/** `localStorage` in a browser that has one, the process-wide memory store otherwise. */
export function defaultFingerprintStore(): FingerprintStore {
  if (isBrowser() && typeof localStorage !== "undefined") {
    try {
      return storageFingerprintStore(localStorage);
    } catch {
      // a page that forbids storage
    }
  }
  return memoryStore;
}

export interface UploadProgress {
  /** Bytes the server has (plaintext bytes, also for an encrypted upload). */
  uploaded: number;
  total: number;
  uploadId: string;
}

export interface ResumableOptions extends UploadPlacement, CallOptions {
  /** Upsert under a slug once complete. */
  slug?: string | undefined;
  /** Bytes per `PATCH`. Default 8 MiB. */
  chunkSize?: number | undefined;
  onProgress?: ((progress: UploadProgress) => void) | undefined;
  /**
   * The key the upload is remembered under in the `store`, so a later call with the same
   * source resumes it. Default: derived from the base URL, the instance, the name, the size
   * (and a `File`'s `lastModified`). `false`: never remember, never resume.
   */
  fingerprint?: string | false | undefined;
  /** Where fingerprints live. Default: `localStorage` in a browser, memory in Node. */
  store?: FingerprintStore | undefined;
}

export interface ResumableCreate extends UploadPlacement, CallOptions {
  /** The total size, in bytes (the server does not support a deferred length). */
  length: number;
  filename: string;
  slug?: string | undefined;
}

export interface UploadState {
  uploadId: string;
  /** Bytes the server has. */
  offset: number;
  length: number;
  /** The `vola_file` id: of the completed file, or — for an encrypted upload — of the file it will become. */
  fileId: string | null;
  /** When the server drops an unfinished upload. */
  expiresAt: string | null;
  /** The upload's metadata as the server keeps it (`instance_type`, `filename`, …); `HEAD` only. */
  metadata: Record<string, string>;
}

export interface ResumableResult {
  fileId: string;
  uploadId: string;
}

export interface UploadProtocol {
  version: string;
  extensions: string[];
  /** `Tus-Max-Size`: the server's upload limit, in bytes. */
  maxSize: number | null;
}

/** Thrown by `resumable()` for a source that cannot be sliced (a stream): the upload would not be resumable. */
function notSliceable(): VolaError {
  return new VolaError({
    status: 0,
    code: "bad_request",
    message:
      "resumable upload: the source must be a Blob/File, a Uint8Array/Buffer or an ArrayBuffer (something that can be sized and sliced); for a stream use files.upload()",
  });
}

const tus = { [TUS_RESUMABLE_HEADER]: TUS_VERSION };

function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

function offsetOf(response: Response): number {
  const raw = header(response, UPLOAD_OFFSET_HEADER);
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new VolaError({
      status: response.status,
      code: "invalid_response",
      message: `${UPLOAD_OFFSET_HEADER}: the server did not say where the upload stands`,
    });
  }
  return Number(raw);
}

/**
 * Resumable uploads (`/uploads`, tus 1.0 core + creation/termination/expiration, which the
 * server implements natively). `resumable()` is the whole flow; `create`, `status`, `append`
 * and `abort` are its steps, for a client that drives them itself.
 */
export class UploadsApi {
  constructor(private readonly client: VolaClient) {}

  /** `OPTIONS /uploads`: the protocol version, the extensions, the size limit. No key needed. */
  async protocol(options: CallOptions = {}): Promise<UploadProtocol> {
    const response = await this.client.request("/uploads", {
      method: "OPTIONS",
      anonymous: true,
      signal: options.signal,
    });
    const max = header(response, TUS_MAX_SIZE_HEADER);
    return {
      version: header(response, TUS_VERSION_HEADER) ?? TUS_VERSION,
      extensions: (header(response, TUS_EXTENSION_HEADER) ?? "").split(",").filter(Boolean),
      maxSize: max !== null && /^\d+$/.test(max) ? Number(max) : null,
    };
  }

  /** `POST /uploads`: creates the upload (`201`); the id comes from `Location`. */
  async create(type: string, id: string, input: ResumableCreate): Promise<UploadState> {
    const K = UPLOAD_META_KEYS;
    const metadata = encodeTusMetadata({
      [K.instanceType]: type,
      [K.instanceId]: id,
      [K.filename]: input.filename,
      [K.folderPath]: input.folderPath,
      [K.parentId]: input.parentId,
      [K.slug]: input.slug,
      [K.contentType]: input.contentType,
      [K.metadata]: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
      [K.encryption]: input.encryption,
    });
    if (input.folderId !== undefined) {
      throw new VolaError({
        status: 0,
        code: "bad_request",
        message:
          "resumable upload: the folder is named by folderPath (folderId is not part of the tus metadata)",
      });
    }
    const response = await this.client.request("/uploads", {
      method: "POST",
      headers: {
        ...tus,
        [UPLOAD_LENGTH_HEADER]: String(input.length),
        [UPLOAD_METADATA_HEADER]: metadata,
        [ENCRYPTION_HEADER]: input.encryption,
      },
      signal: input.signal,
      unlock: input.unlock,
      contentKey: input.contentKey,
    });
    const location = header(response, "location");
    const uploadId = location?.split("/").pop();
    if (!uploadId) {
      throw new VolaError({
        status: response.status,
        code: "invalid_response",
        message: "POST /uploads: no Location header",
      });
    }
    await response.body?.cancel().catch(() => undefined);
    return {
      uploadId,
      offset: offsetOf(response),
      length: input.length,
      fileId: header(response, VOLA_FILE_ID_HEADER),
      expiresAt: header(response, UPLOAD_EXPIRES_HEADER),
      metadata: {},
    };
  }

  /** `HEAD /uploads/:id`: where the upload stands. `404 upload_not_found` / `410` throw. */
  async status(uploadId: string, options: CallOptions = {}): Promise<UploadState> {
    const response = await this.client.request(`/uploads/${encodeURIComponent(uploadId)}`, {
      method: "HEAD",
      headers: tus,
      ...options,
    });
    const length = header(response, UPLOAD_LENGTH_HEADER);
    return {
      uploadId,
      offset: offsetOf(response),
      length: length !== null && /^\d+$/.test(length) ? Number(length) : 0,
      fileId: header(response, VOLA_FILE_ID_HEADER),
      expiresAt: header(response, UPLOAD_EXPIRES_HEADER),
      metadata: decodeTusMetadata(header(response, UPLOAD_METADATA_HEADER)) ?? {},
    };
  }

  /**
   * `PATCH /uploads/:id`: `chunk` from `offset` on. Resolves with the new offset and, when the
   * upload is complete, the file id. A `keyring` upload needs the unlock token and a `caller`
   * upload the content key on EVERY call (each one unwraps the file key).
   */
  async append(
    uploadId: string,
    chunk: Blob | Uint8Array,
    offset: number,
    options: CallOptions = {},
  ): Promise<{ offset: number; fileId: string | null }> {
    const response = await this.client.request(`/uploads/${encodeURIComponent(uploadId)}`, {
      method: "PATCH",
      headers: {
        ...tus,
        "content-type": TUS_PATCH_CONTENT_TYPE,
        [UPLOAD_OFFSET_HEADER]: String(offset),
      },
      body: chunk instanceof Uint8Array ? chunk.slice() : chunk,
      ...options,
    });
    await response.body?.cancel().catch(() => undefined);
    return { offset: offsetOf(response), fileId: header(response, VOLA_FILE_ID_HEADER) };
  }

  /** `DELETE /uploads/:id`: drops the upload and its partial bytes. */
  async abort(uploadId: string, options: CallOptions = {}): Promise<void> {
    const response = await this.client.request(`/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      headers: tus,
      ...options,
    });
    await response.body?.cancel().catch(() => undefined);
  }

  /** The default fingerprint of a source. */
  fingerprintOf(type: string, id: string, source: ByteSource, filename: string): string {
    const modified =
      typeof Blob !== "undefined" && source instanceof Blob && "lastModified" in source
        ? String((source as { lastModified: unknown }).lastModified)
        : "";
    return `vola-upload:${this.client.baseUrl}:${type}/${id}:${filename}:${sizeOf(source)}:${modified}`;
  }

  /**
   * The whole resumable flow: remembers the upload under its fingerprint, `HEAD`s a remembered
   * one for its offset (a vanished one is forgotten and started again), creates a new one
   * otherwise, `PATCH`es `chunkSize` bytes at a time from the offset on, reports progress, and
   * resolves with the file id. An abort (`signal`) or a network failure mid-`PATCH` rejects
   * and keeps the fingerprint: the next call with the same source continues where the server
   * stands. A `409` (the server's offset moved) re-reads the offset and goes on.
   */
  async resumable(
    type: string,
    id: string,
    source: ByteSource,
    options: ResumableOptions = {},
  ): Promise<ResumableResult> {
    if (isStreamSource(source)) throw notSliceable();
    const filename = options.filename ?? nameOf(source);
    if (!filename) {
      throw new VolaError({
        status: 0,
        code: "bad_request",
        message: "resumable upload: filename is required when the source is not a File",
      });
    }
    const total = sizeOf(source);
    const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const store =
      options.fingerprint === false ? null : (options.store ?? defaultFingerprintStore());
    const key =
      options.fingerprint === false
        ? null
        : (options.fingerprint ?? this.fingerprintOf(type, id, source, filename));
    const call: CallOptions = {
      signal: options.signal,
      unlock: options.unlock,
      contentKey: options.contentKey,
    };

    let state: UploadState | null = null;
    if (store && key) {
      const remembered = await store.get(key);
      if (remembered) {
        try {
          state = await this.status(remembered, call);
        } catch (error) {
          if (!(error instanceof VolaError) || (error.status !== 404 && error.status !== 410)) {
            throw error;
          }
          await store.remove(key);
        }
      }
    }
    if (!state) {
      state = await this.create(type, id, {
        length: total,
        filename,
        contentType: options.contentType ?? typeOf(source),
        folderPath: options.folderPath,
        parentId: options.parentId,
        slug: options.slug,
        metadata: options.metadata,
        encryption: options.encryption,
        ...call,
      });
      if (store && key) await store.set(key, state.uploadId);
    }

    let offset = state.offset;
    let fileId = state.fileId;
    let conflicts = 0;
    options.onProgress?.({ uploaded: offset, total, uploadId: state.uploadId });
    while (offset < total || (total === 0 && fileId === null)) {
      const end = Math.min(offset + chunkSize, total);
      try {
        const result = await this.append(
          state.uploadId,
          sliceOf(source, offset, end),
          offset,
          call,
        );
        offset = result.offset;
        fileId = result.fileId ?? fileId;
        conflicts = 0;
      } catch (error) {
        if (error instanceof VolaError && error.status === 409 && conflicts++ < 3) {
          offset = (await this.status(state.uploadId, call)).offset;
          continue;
        }
        throw error;
      }
      options.onProgress?.({ uploaded: offset, total, uploadId: state.uploadId });
      if (total === 0) break;
    }
    if (offset >= total && fileId === null) {
      // The last PATCH answered without the id (a proxy dropped the header): ask.
      fileId = (await this.status(state.uploadId, call)).fileId;
    }
    if (fileId === null) {
      throw new VolaError({
        status: 0,
        code: "invalid_response",
        message: "resumable upload: complete, but the server did not name the file",
      });
    }
    if (store && key) await store.remove(key);
    return { fileId, uploadId: state.uploadId };
  }
}
