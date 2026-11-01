import { describe, expect, it } from "vitest";
import {
  aggregateProcessingStatus,
  DEFAULT_THUMBNAIL_CROP,
  PROCESSING_KINDS,
  PROCESSING_STATUSES,
  THUMBNAIL_CROPS,
  THUMBNAIL_SIZES,
  thumbnailDerivedName,
  thumbnailSupported,
} from "../src/index.js";

describe("aggregateProcessingStatus", () => {
  it("is null for no jobs", () => {
    expect(aggregateProcessingStatus([])).toBeNull();
  });
  it("lets the worst status win: FAILED > RUNNING > PENDING > DONE", () => {
    expect(aggregateProcessingStatus(["DONE", "DONE"])).toBe("DONE");
    expect(aggregateProcessingStatus(["DONE", "PENDING"])).toBe("PENDING");
    expect(aggregateProcessingStatus(["PENDING", "RUNNING", "DONE"])).toBe("RUNNING");
    expect(aggregateProcessingStatus(["DONE", "RUNNING", "FAILED", "PENDING"])).toBe("FAILED");
  });
  it("ignores SKIPPED and unknown values", () => {
    expect(aggregateProcessingStatus(["SKIPPED"])).toBeNull();
    expect(aggregateProcessingStatus(["SKIPPED", "DONE"])).toBe("DONE");
    expect(aggregateProcessingStatus(["WHATEVER", "PENDING"])).toBe("PENDING");
  });
});

describe("thumbnail vocabulary", () => {
  it("names the sizes, crops, kinds and statuses", () => {
    expect(THUMBNAIL_SIZES).toEqual([64, 128, 256, 512]);
    expect(THUMBNAIL_CROPS).toEqual(["cover", "fit", "attention"]);
    expect(DEFAULT_THUMBNAIL_CROP).toBe("cover");
    expect(PROCESSING_KINDS).toEqual(["THUMBNAIL", "OCR"]);
    expect(PROCESSING_STATUSES).toEqual(["PENDING", "RUNNING", "DONE", "FAILED", "SKIPPED"]);
    expect(thumbnailDerivedName(128, "cover")).toBe("thumb-128-cover.webp");
  });
  it("supports raster images and PDF, not SVG or anything else", () => {
    expect(thumbnailSupported("image/png")).toBe(true);
    expect(thumbnailSupported("image/jpeg")).toBe(true);
    expect(thumbnailSupported("application/pdf")).toBe(true);
    expect(thumbnailSupported("image/svg+xml")).toBe(false);
    expect(thumbnailSupported("text/plain")).toBe(false);
    expect(thumbnailSupported("video/mp4")).toBe(false);
  });
});
