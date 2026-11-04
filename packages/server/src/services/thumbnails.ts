import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  DEFAULT_THUMBNAIL_CROP,
  THUMBNAIL_CROPS,
  THUMBNAIL_SIZES,
  THUMBNAIL_WEBP_QUALITY,
  type ThumbnailCrop,
  type ThumbnailSize,
  thumbnailDerivedName,
  thumbnailSupported,
} from "@vol-a/core";
import sharp, { type ResizeOptions } from "sharp";
import { VolaError } from "../errors.js";
import { BlobNotFoundError, type BlobStat, type StorageBackend } from "../storage/index.js";
import { PdfPageError, pdfPageFromBuffer } from "./pdf-pages.js";

export { thumbnailDerivedName, thumbnailSupported };

const execFileAsync = promisify(execFile);

/** How long one rendition may take before it counts as failed. */
export const DEFAULT_THUMBNAIL_TIMEOUT_MS = 30_000;
/** The grey of the placeholder (vola-spp's `#cccccc`). */
const PLACEHOLDER_GREY = { r: 204, g: 204, b: 204 };

/** What a thumbnail is rendered from: the blob and what it is. */
export interface ThumbnailSource {
  hash: string;
  mimeType: string;
}

export interface RenderOptions {
  /** Wall-clock limit of the rendition. Default 30 s. */
  timeoutMs?: number | undefined;
  /** The `pdftoppm` binary (poppler-utils). Default: the one on `PATH`. */
  pdftoppm?: string | undefined;
}

export type ThumbnailErrorCode = "unsupported" | "blob_missing" | "render_failed" | "timeout";

/** A rendition did not happen; `code` says why and `message` is safe to store (no file name). */
export class ThumbnailError extends Error {
  constructor(
    readonly code: ThumbnailErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ThumbnailError";
  }
}

/** `:size` of the route → one of `THUMBNAIL_SIZES`; `400 invalid_size` otherwise. */
export function parseThumbnailSize(raw: string | number): ThumbnailSize {
  const size = Number(raw);
  if (!(THUMBNAIL_SIZES as readonly number[]).includes(size)) {
    throw new VolaError(
      "invalid_size",
      400,
      `size: one of ${THUMBNAIL_SIZES.join(", ")} (got ${JSON.stringify(String(raw))})`,
    );
  }
  return size as ThumbnailSize;
}

/** `?crop=` of the route → one of `THUMBNAIL_CROPS` (default `cover`); `400 invalid_crop` otherwise. */
export function parseThumbnailCrop(raw: string | undefined | null): ThumbnailCrop {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_THUMBNAIL_CROP;
  if (!(THUMBNAIL_CROPS as readonly string[]).includes(raw)) {
    throw new VolaError(
      "invalid_crop",
      400,
      `crop: one of ${THUMBNAIL_CROPS.join(", ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as ThumbnailCrop;
}

/** The thumbnail on disk, or `null` when it was not rendered (yet). */
export function statThumbnail(
  storage: StorageBackend,
  hash: string,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
): Promise<BlobStat | null> {
  return storage.statDerived(hash, thumbnailDerivedName(size, crop));
}

/** sharp's resize options for a crop mode. */
function resizeOptions(crop: ThumbnailCrop): ResizeOptions {
  switch (crop) {
    case "fit":
      return { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } };
    case "attention":
      return { fit: "cover", position: sharp.strategy.attention };
    default:
      return { fit: "cover", position: "centre" };
  }
}

/** The WebP of `input` (a path or the bytes of an image) at `size` with `crop`; EXIF rotation applied. */
async function encode(
  input: string | Buffer,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
  timeoutMs: number,
): Promise<Buffer> {
  return sharp(input, { animated: false })
    .timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) })
    .rotate()
    .resize(size, size, resizeOptions(crop))
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer();
}

/** The bytes of the blob (an image fits in memory once it is going through libvips anyway). */
async function readBlob(storage: StorageBackend, hash: string): Promise<Buffer> {
  const stream = await storage.open(hash);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The first page of the PDF as a PNG: the blob goes to a temporary directory, `pdftoppm -f 1
 * -l 1 -r 72 -png` renders it there, and the directory is removed afterwards.
 */
async function firstPdfPage(
  storage: StorageBackend,
  hash: string,
  options: { timeoutMs: number; pdftoppm: string },
  run: (dir: string, png: string) => Promise<Buffer>,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vola-thumb-"));
  try {
    const pdf = join(dir, "in.pdf");
    const out = join(dir, "page");
    await pipeline(await storage.open(hash), createWriteStream(pdf));
    try {
      await execFileAsync(
        options.pdftoppm,
        ["-f", "1", "-l", "1", "-r", "72", "-png", "-singlefile", pdf, out],
        { timeout: options.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      );
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
      if (e.killed) throw new ThumbnailError("timeout", "pdftoppm exceeded the time limit");
      if (e.code === "ENOENT") {
        throw new ThumbnailError("render_failed", "pdftoppm is not installed", { cause: error });
      }
      throw new ThumbnailError("render_failed", `pdftoppm failed (exit ${String(e.code)})`, {
        cause: error,
      });
    }
    // Awaited HERE: the finally below removes the directory the PNG sits in.
    return await run(dir, `${out}.png`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Renders the thumbnail of `source` — a raster image (EXIF orientation applied) or the first
 * page of a PDF — as a `size × size` WebP (quality 80) in `crop` mode, within `timeoutMs`.
 * Throws `ThumbnailError`: `unsupported` (SVG, text, video, …), `blob_missing`,
 * `render_failed` (a broken file, a tool missing), `timeout`.
 */
export async function renderThumbnail(
  storage: StorageBackend,
  source: ThumbnailSource,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
  options: RenderOptions = {},
): Promise<Buffer> {
  if (!thumbnailSupported(source.mimeType)) {
    throw new ThumbnailError("unsupported", `no thumbnail for ${source.mimeType}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_THUMBNAIL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    if (source.mimeType === "application/pdf") {
      return await firstPdfPage(
        storage,
        source.hash,
        { timeoutMs, pdftoppm: options.pdftoppm ?? "pdftoppm" },
        (_dir, png) => encode(png, size, crop, Math.max(1000, deadline - Date.now())),
      );
    }
    return await encode(await readBlob(storage, source.hash), size, crop, timeoutMs);
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    if (error instanceof BlobNotFoundError) {
      throw new ThumbnailError("blob_missing", "the stored bytes are missing", { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      throw new ThumbnailError("timeout", "rendering exceeded the time limit", { cause: error });
    }
    throw new ThumbnailError("render_failed", `rendering failed: ${message}`, { cause: error });
  }
}

/**
 * The first page of a PDF held IN MEMORY as a PNG, through `pdftoppm`'s stdin and stdout
 * (`pdfPageFromBuffer`): nothing of the document or the page touches the disk — what an
 * ENCRYPTED PDF needs (`docs/CRYPTO.md` § 11): its plaintext is never a file.
 */
export async function pdfFirstPageFromBuffer(
  pdf: Buffer,
  options: { timeoutMs: number; pdftoppm: string },
): Promise<Buffer> {
  try {
    const png = await pdfPageFromBuffer(pdf, 1, { ...options, dpi: 72 });
    if (!png) throw new ThumbnailError("render_failed", "pdftoppm rendered no page");
    return png;
  } catch (error) {
    if (error instanceof PdfPageError) {
      throw new ThumbnailError(
        error.code === "timeout" ? "timeout" : "render_failed",
        error.message,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

/**
 * `renderThumbnail` for bytes held in memory (the decrypted plaintext of an encrypted file):
 * a raster image goes to sharp as a buffer, a PDF through `pdfFirstPageFromBuffer`. Nothing
 * is written to disk. The same `ThumbnailError`s as `renderThumbnail`.
 */
export async function renderThumbnailFromBuffer(
  plain: Buffer,
  mimeType: string,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
  options: RenderOptions = {},
): Promise<Buffer> {
  if (!thumbnailSupported(mimeType)) {
    throw new ThumbnailError("unsupported", `no thumbnail for ${mimeType}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_THUMBNAIL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    const input =
      mimeType === "application/pdf"
        ? await pdfFirstPageFromBuffer(plain, {
            timeoutMs,
            pdftoppm: options.pdftoppm ?? "pdftoppm",
          })
        : plain;
    return await encode(input, size, crop, Math.max(1000, deadline - Date.now()));
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      throw new ThumbnailError("timeout", "rendering exceeded the time limit", { cause: error });
    }
    throw new ThumbnailError("render_failed", `rendering failed: ${message}`, { cause: error });
  }
}

/**
 * `renderThumbnail` + `putDerived`: the rendition is stored next to its blob as
 * `thumb-<size>-<crop>.webp`, shared by every file (of any tenant) with that hash and removed
 * with the blob. Returns the derived name.
 */
export async function generateThumbnail(
  storage: StorageBackend,
  source: ThumbnailSource,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
  options: RenderOptions = {},
): Promise<string> {
  const bytes = await renderThumbnail(storage, source, size, crop, options);
  const name = thumbnailDerivedName(size, crop);
  try {
    await storage.putDerived(source.hash, name, bytes);
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      throw new ThumbnailError("blob_missing", "the stored bytes are missing", { cause: error });
    }
    throw error;
  }
  return name;
}

const placeholders = new Map<number, Promise<Buffer>>();

/** A flat grey `size × size` WebP (under 60 bytes): the body of a `202` and of a `failed` answer. Cached per size. */
export function thumbnailPlaceholder(size: ThumbnailSize): Promise<Buffer> {
  let cached = placeholders.get(size);
  if (!cached) {
    cached = sharp({
      create: { width: size, height: size, channels: 3, background: PLACEHOLDER_GREY },
    })
      .webp({ lossless: true })
      .toBuffer();
    placeholders.set(size, cached);
  }
  return cached;
}
