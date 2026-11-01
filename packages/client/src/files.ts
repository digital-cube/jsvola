import {
  ENCRYPTION_HEADER,
  type FileDetail,
  FileDetailSchema,
  type FileEncryption,
  type FileInfo,
  FileInfoSchema,
  type FileList,
  FileListSchema,
  type FileMetadata,
  type FilePatch,
  type FileVersions,
  FileVersionsSchema,
  FORCE_DOWNLOAD_QUERY,
  OCR_QUERY,
  OCR_QUERY_FULL,
  type PurgeResult,
  PurgeResultSchema,
  THUMBNAIL_CROP_QUERY,
  THUMBNAIL_STATUS_HEADER,
  type ThumbnailCrop,
  type ThumbnailSize,
  UPLOAD_FILE_FIELD,
  UPLOAD_FOLDER_ID_FIELD,
  UPLOAD_FOLDER_PATH_FIELD,
  UPLOAD_METADATA_FIELD,
  UPLOAD_PARENT_ID_FIELD,
} from "@vola/core";
import { multipartBody, nameOf, typeOf, type UploadSource } from "./body.js";
import type { CallOptions, VolaClient } from "./client.js";
import { ok2xx } from "./client.js";
import { encodePath } from "./env.js";
import { VolaError } from "./errors.js";

/** A `Range`: `{start, end?}` (inclusive, as HTTP), `{suffix}` (the last N bytes), or the header value itself. */
export type ByteRange = { start: number; end?: number | undefined } | { suffix: number } | string;

export function rangeHeader(range: ByteRange): string {
  if (typeof range === "string") return range;
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  return `bytes=${range.start}-${range.end ?? ""}`;
}

/** Where an upload lands and what it is. */
export interface UploadPlacement {
  /** Required unless the source is a `File` (its `name` is used). */
  filename?: string | undefined;
  /** The MIME type of the bytes; default: the `Blob`'s type, else `application/octet-stream` (the server sniffs anyway). */
  contentType?: string | undefined;
  /** The folder (`a/b/c`, created when missing; `""` the root). Excludes `folderId`. */
  folderPath?: string | undefined;
  /** An existing folder by id (`null`: the root). */
  folderId?: string | null | undefined;
  /** The previous version this upload supersedes. */
  parentId?: string | undefined;
  /** Free JSON attached to the file. */
  metadata?: FileMetadata | undefined;
  /** `none` | `tenant` | `keyring` (needs an unlock token) | `caller` (needs `contentKey`, Node only). Default: the folder's policy, else the tenant's default. */
  encryption?: FileEncryption | undefined;
}

export interface UploadOptions extends UploadPlacement, CallOptions {
  /** Upsert the file under this slug (`PUT …/slug/:slug`): at most one live file per slug. */
  slug?: string | undefined;
}

export interface DownloadOptions extends CallOptions {
  range?: ByteRange | undefined;
  /** `?download=1`: `Content-Disposition: attachment` whatever the type. */
  download?: boolean | undefined;
  /** `If-None-Match`: a `304` resolves (with an empty body). */
  ifNoneMatch?: string | undefined;
}

export interface InfoOptions extends CallOptions {
  /** See a soft-deleted file too. */
  includeDeleted?: boolean | undefined;
  /** `"full"`: the whole OCR text under `ocr.text` (the 500-character preview is always there). */
  ocr?: "full" | undefined;
}

export interface ListOptions extends CallOptions {
  cursor?: string | null | undefined;
  /** Page size, at most 200. */
  limit?: number | undefined;
  includeDeleted?: boolean | undefined;
}

export interface VersionsOptions extends CallOptions {
  includeDeleted?: boolean | undefined;
}

export interface ThumbnailOptions extends CallOptions {
  crop?: ThumbnailCrop | undefined;
  ifNoneMatch?: string | undefined;
}

/**
 * What `thumb()` resolves with. A `202` of the server is NOT the image: it is a grey placeholder
 * while the worker renders — `generating` tells the caller to retry (and never to cache).
 */
export type ThumbnailResult =
  | { status: "ready"; blob: Blob; etag: string | null; response: Response }
  | { status: "not_modified"; etag: string | null; response: Response }
  | { status: "generating"; response: Response }
  | { status: "failed"; response: Response };

/** `/files/:type/:id`. */
export function instancePath(type: string, id: string): string {
  return `/files/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

/** `/files/:type/:id/:fileId`. */
export function filePath(type: string, id: string, fileId: string): string {
  return `${instancePath(type, id)}/${encodeURIComponent(fileId)}`;
}

/** The files of an instance: upload, download, metadata, versions, visibility, delete. */
export class FilesApi {
  constructor(private readonly client: VolaClient) {}

  /**
   * `POST /files/:type/:id` (multipart) — or `PUT …/slug/:slug` with `slug`. The source is a
   * `File`/`Blob`, a `Uint8Array`/`Buffer`, an `ArrayBuffer`, a web `ReadableStream` or any
   * async iterable of bytes (a Node `Readable`): streams are sent without being buffered.
   * Resolves with the stored file (`201`).
   */
  async upload(
    type: string,
    id: string,
    source: UploadSource,
    options: UploadOptions = {},
  ): Promise<FileInfo> {
    const filename = options.filename ?? nameOf(source);
    if (!filename) {
      throw new VolaError({
        status: 0,
        code: "bad_request",
        message: "upload: filename is required when the source is not a File",
      });
    }
    if (options.folderPath !== undefined && options.folderId !== undefined) {
      throw new VolaError({
        status: 0,
        code: "bad_request",
        message: "upload: folderPath and folderId exclude each other",
      });
    }
    const fields: [string, string][] = [];
    if (options.folderPath !== undefined)
      fields.push([UPLOAD_FOLDER_PATH_FIELD, options.folderPath]);
    if (options.folderId !== undefined)
      fields.push([UPLOAD_FOLDER_ID_FIELD, options.folderId ?? ""]);
    if (options.parentId !== undefined) fields.push([UPLOAD_PARENT_ID_FIELD, options.parentId]);
    if (options.metadata !== undefined) {
      fields.push([UPLOAD_METADATA_FIELD, JSON.stringify(options.metadata)]);
    }
    const { body, contentType, streaming } = multipartBody(fields, {
      field: UPLOAD_FILE_FIELD,
      filename,
      contentType: options.contentType ?? typeOf(source) ?? "application/octet-stream",
      source,
    });
    const path = options.slug
      ? `${instancePath(type, id)}/slug/${encodeURIComponent(options.slug)}`
      : instancePath(type, id);
    return this.client.json(path, FileInfoSchema, {
      method: options.slug ? "PUT" : "POST",
      body,
      streaming,
      headers: {
        "content-type": contentType,
        [ENCRYPTION_HEADER]: options.encryption,
      },
      signal: options.signal,
      unlock: options.unlock,
      contentKey: options.contentKey,
    });
  }

  /** `PUT /files/:type/:id/slug/:slug`: `upload()` as an upsert under `slug`. */
  putSlug(
    type: string,
    id: string,
    slug: string,
    source: UploadSource,
    options: Omit<UploadOptions, "slug"> = {},
  ): Promise<FileInfo> {
    return this.upload(type, id, source, { ...options, slug });
  }

  private async fetchFile(
    path: string,
    method: "GET" | "HEAD",
    options: DownloadOptions,
  ): Promise<Response> {
    return this.client.request(path, {
      method,
      query: { [FORCE_DOWNLOAD_QUERY]: options.download },
      headers: {
        range: options.range === undefined ? undefined : rangeHeader(options.range),
        "if-none-match": options.ifNoneMatch,
      },
      ok: (status) => ok2xx(status) || status === 304,
      signal: options.signal,
      unlock: options.unlock,
      contentKey: options.contentKey,
    });
  }

  /**
   * `GET /files/:type/:id/:fileId`: the bytes as a streaming `Response` (`200`, or `206` for a
   * `range`, `304` for a matching `ifNoneMatch`) — read `response.body`, `.blob()`,
   * `.arrayBuffer()` as needed. Headers: `ETag`, `Content-Disposition`, `Content-Range`,
   * `X-Vola-Encryption` for an encrypted file.
   */
  download(
    type: string,
    id: string,
    fileId: string,
    options: DownloadOptions = {},
  ): Promise<Response> {
    return this.fetchFile(filePath(type, id, fileId), "GET", options);
  }

  /** `HEAD /files/:type/:id/:fileId`: the headers of a download without the body. */
  head(type: string, id: string, fileId: string, options: DownloadOptions = {}): Promise<Response> {
    return this.fetchFile(filePath(type, id, fileId), "HEAD", options);
  }

  /** `GET /files/:type/:id/path/*`: the newest live file of that name in that folder (`docs/q4/report.pdf`). */
  byPath(type: string, id: string, path: string, options: DownloadOptions = {}): Promise<Response> {
    return this.fetchFile(`${instancePath(type, id)}/path/${encodePath(path)}`, "GET", options);
  }

  /** `GET /files/:type/:id/slug/:slug`: the live file under `slug`. */
  bySlug(type: string, id: string, slug: string, options: DownloadOptions = {}): Promise<Response> {
    return this.fetchFile(
      `${instancePath(type, id)}/slug/${encodeURIComponent(slug)}`,
      "GET",
      options,
    );
  }

  /** `GET /public/:fileId`: an `is_global_public` file, no key needed. */
  public(
    fileId: string,
    options: Omit<DownloadOptions, "unlock" | "contentKey"> = {},
  ): Promise<Response> {
    return this.client.request(`/public/${encodeURIComponent(fileId)}`, {
      anonymous: true,
      query: { [FORCE_DOWNLOAD_QUERY]: options.download },
      headers: {
        range: options.range === undefined ? undefined : rangeHeader(options.range),
        "if-none-match": options.ifNoneMatch,
      },
      ok: (status) => ok2xx(status) || status === 304,
      signal: options.signal,
    });
  }

  /** The URL of a download — WITHOUT credentials: for a `<a href>` behind a proxy or cookie auth, or for `fetch` with `client.headers()`. */
  downloadUrl(
    type: string,
    id: string,
    fileId: string,
    options: { download?: boolean | undefined } = {},
  ): string {
    return this.client.url(filePath(type, id, fileId), {
      [FORCE_DOWNLOAD_QUERY]: options.download,
    });
  }

  /** The URL of `GET /public/:fileId` (anonymous: usable as an `<img src>` for an `is_global_public` file). */
  publicUrl(fileId: string): string {
    return this.client.url(`/public/${encodeURIComponent(fileId)}`);
  }

  /** `GET …/:fileId/info`: the metadata (never the bytes) with the aggregate processing status and the `ocr` block. */
  info(type: string, id: string, fileId: string, options: InfoOptions = {}): Promise<FileDetail> {
    return this.client.json(`${filePath(type, id, fileId)}/info`, FileDetailSchema, {
      query: {
        include_deleted: options.includeDeleted,
        [OCR_QUERY]: options.ocr === "full" ? OCR_QUERY_FULL : undefined,
      },
      signal: options.signal,
      unlock: options.unlock,
      contentKey: options.contentKey,
    });
  }

  /** `GET /files/:type/:id`: the instance's files, newest first, one page (`next_cursor` feeds `cursor`). */
  list(type: string, id: string, options: ListOptions = {}): Promise<FileList> {
    return this.client.json(instancePath(type, id), FileListSchema, {
      query: {
        cursor: options.cursor,
        limit: options.limit,
        include_deleted: options.includeDeleted,
      },
      signal: options.signal,
      unlock: options.unlock,
    });
  }

  /** Every file of the instance, page after page. */
  async *iterate(type: string, id: string, options: ListOptions = {}): AsyncGenerator<FileInfo> {
    let cursor = options.cursor ?? null;
    do {
      const page = await this.list(type, id, { ...options, cursor });
      for (const file of page.files) yield file;
      cursor = page.next_cursor;
    } while (cursor);
  }

  /** `GET …/:fileId/versions`: the whole version chain, newest first. */
  versions(
    type: string,
    id: string,
    fileId: string,
    options: VersionsOptions = {},
  ): Promise<FileVersions> {
    return this.client.json(`${filePath(type, id, fileId)}/versions`, FileVersionsSchema, {
      query: { include_deleted: options.includeDeleted },
      signal: options.signal,
      unlock: options.unlock,
    });
  }

  /** `PATCH …/:fileId`: move (`folder_path`), rename (`filename`), visibility (`is_public`, `is_global_public`). */
  patch(
    type: string,
    id: string,
    fileId: string,
    patch: FilePatch,
    options: CallOptions = {},
  ): Promise<FileInfo> {
    return this.client.json(filePath(type, id, fileId), FileInfoSchema, {
      method: "PATCH",
      json: patch,
      ...options,
    });
  }

  /** `DELETE …/:fileId`: soft delete (the bytes stay; `purge` removes them). Idempotent. */
  delete(type: string, id: string, fileId: string, options: CallOptions = {}): Promise<FileInfo> {
    return this.client.json(filePath(type, id, fileId), FileInfoSchema, {
      method: "DELETE",
      ...options,
    });
  }

  /** `DELETE …/:fileId/purge`: the row, its version chain, and every blob nothing references any more. */
  purge(type: string, id: string, fileId: string, options: CallOptions = {}): Promise<PurgeResult> {
    return this.client.json(`${filePath(type, id, fileId)}/purge`, PurgeResultSchema, {
      method: "DELETE",
      ...options,
    });
  }

  /** `…/:fileId/thumb/:size[?crop=]` as a URL — WITHOUT credentials (see `downloadUrl`). */
  thumbUrl(
    type: string,
    id: string,
    fileId: string,
    size: ThumbnailSize,
    options: { crop?: ThumbnailCrop | undefined } = {},
  ): string {
    return this.client.url(`${filePath(type, id, fileId)}/thumb/${size}`, {
      [THUMBNAIL_CROP_QUERY]: options.crop,
    });
  }

  /**
   * `GET …/:fileId/thumb/:size?crop=`: `{status: "ready", blob}` for the WebP, `{status:
   * "generating"}` while the worker renders it (a `202` — retry later, never cache),
   * `{status: "failed"}` when the file could not be rendered. `404 no_thumbnail` throws: the
   * file has none by its nature.
   */
  async thumb(
    type: string,
    id: string,
    fileId: string,
    size: ThumbnailSize,
    options: ThumbnailOptions = {},
  ): Promise<ThumbnailResult> {
    const response = await this.client.request(`${filePath(type, id, fileId)}/thumb/${size}`, {
      query: { [THUMBNAIL_CROP_QUERY]: options.crop },
      headers: { "if-none-match": options.ifNoneMatch },
      ok: (status) => ok2xx(status) || status === 304,
      signal: options.signal,
      unlock: options.unlock,
      contentKey: options.contentKey,
    });
    const etag = response.headers.get("etag");
    if (response.status === 304) return { status: "not_modified", etag, response };
    const state = response.headers.get(THUMBNAIL_STATUS_HEADER);
    if (response.status === 202 || state === "generating")
      return { status: "generating", response };
    if (state === "failed") return { status: "failed", response };
    return { status: "ready", blob: await response.blob(), etag, response };
  }
}
