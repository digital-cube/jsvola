import { z } from "zod";

/** The jobs the worker runs on a file (the `ProcessingKinds` vocabulary). */
export const PROCESSING_KINDS = ["THUMBNAIL", "OCR"] as const;
export const ProcessingKindSchema = z.enum(PROCESSING_KINDS);
export type ProcessingKind = z.infer<typeof ProcessingKindSchema>;

/** The states of one job (the `ProcessingStatuses` vocabulary). */
export const PROCESSING_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED", "SKIPPED"] as const;
export const ProcessingStatusSchema = z.enum(PROCESSING_STATUSES);
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;

/**
 * The aggregate of a file's jobs, worst first: `FAILED` > `RUNNING` > `PENDING` > `DONE`.
 * `SKIPPED` never counts.
 */
const AGGREGATE_RANK: readonly ProcessingStatus[] = ["FAILED", "RUNNING", "PENDING", "DONE"];

/**
 * The `processing_status` of a file from the statuses of its jobs: the worst one wins
 * (`FAILED` > `RUNNING` > `PENDING` > `DONE`), `SKIPPED` is ignored, and a file with no
 * (counted) job has `null` — nothing was ever asked of the worker.
 */
export function aggregateProcessingStatus(statuses: Iterable<string>): ProcessingStatus | null {
  let worst = -1;
  for (const status of statuses) {
    const rank = AGGREGATE_RANK.indexOf(status as ProcessingStatus);
    if (rank === -1) continue; // SKIPPED, or a value this version does not know
    if (worst === -1 || rank < worst) worst = rank;
    if (worst === 0) break;
  }
  return worst === -1 ? null : (AGGREGATE_RANK[worst] as ProcessingStatus);
}

/** The edge, in pixels, a thumbnail may be asked in (`…/thumb/:size`). */
export const THUMBNAIL_SIZES = [64, 128, 256, 512] as const;
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];
export const ThumbnailSizeSchema = z.union([
  z.literal(64),
  z.literal(128),
  z.literal(256),
  z.literal(512),
]);

/**
 * How a thumbnail fits its `size × size` box (`?crop=`): `cover` crops to the centre square,
 * `fit` contains the whole image (padded, transparent), `attention` crops to the region
 * sharp's attention strategy finds most interesting.
 */
export const THUMBNAIL_CROPS = ["cover", "fit", "attention"] as const;
export type ThumbnailCrop = (typeof THUMBNAIL_CROPS)[number];
export const ThumbnailCropSchema = z.enum(THUMBNAIL_CROPS);
export const DEFAULT_THUMBNAIL_CROP: ThumbnailCrop = "cover";
/** The query parameter selecting the crop of `…/thumb/:size`. */
export const THUMBNAIL_CROP_QUERY = "crop";

/** The WebP quality thumbnails are encoded with. */
export const THUMBNAIL_WEBP_QUALITY = 80;
/** The MIME type of every thumbnail (and of the placeholder). */
export const THUMBNAIL_MIME = "image/webp";

/**
 * `X-Thumbnail-Status` on every `…/thumb/:size` answer: `ready` (200, the thumbnail),
 * `generating` (202, a grey placeholder — retry; never cache it under a content key),
 * `failed` (200, a placeholder: the file could not be rendered).
 */
export const THUMBNAIL_STATUS_HEADER = "x-thumbnail-status";
export const THUMBNAIL_STATUSES = ["ready", "generating", "failed"] as const;
export type ThumbnailStatus = (typeof THUMBNAIL_STATUSES)[number];

/** The derived-file name a thumbnail is stored under, next to its blob. */
export function thumbnailDerivedName(size: ThumbnailSize | number, crop: ThumbnailCrop): string {
  return `thumb-${size}-${crop}.webp`;
}

/** `true` for a MIME type the worker renders a thumbnail of: raster images (not SVG) and PDF. */
export function thumbnailSupported(mimeType: string): boolean {
  if (mimeType === "application/pdf") return true;
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}
