import { describe, expect, it } from "vitest";
import {
  aggregateProcessingStatus,
  DEFAULT_OCR_LANGS,
  DEFAULT_OCR_MAX_PAGES,
  DEFAULT_OCR_TIMEOUT_S,
  DEFAULT_THUMBNAIL_CROP,
  isOcrEligible,
  OCR_LANGUAGES,
  OCR_PAGE_SEPARATOR,
  OCR_TEXT_PREVIEW_LENGTH,
  OcrInfoSchema,
  ocrSupported,
  PROCESSING_KINDS,
  PROCESSING_STATUSES,
  parseOcrLangs,
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

describe("OCR vocabulary (plan 4.2)", () => {
  it.each([
    ["image/png", "none", true],
    ["image/jpeg", "none", true],
    ["image/webp", "none", true],
    ["image/tiff", "none", true],
    ["application/pdf", "none", true],
    ["image/gif", "none", false],
    ["image/svg+xml", "none", false],
    ["text/plain", "none", false],
    ["application/json", "none", false],
    ["video/mp4", "none", false],
    ["audio/mpeg", "none", false],
    ["application/zip", "none", false],
    ["", "none", false],
    ["image/png", "tenant", true], // the worker holds the key file (6.3)
    ["image/gif", "tenant", false],
    ["application/pdf", "keyring", false],
    ["application/pdf", "caller", false],
    ["application/pdf", "client", false],
  ])("isOcrEligible(%s, %s) is %s", (mimeType, encryption, expected) => {
    expect(isOcrEligible({ mimeType, encryption })).toBe(expected);
    expect(ocrSupported(mimeType)).toBe(
      expected || (encryption !== "none" && encryption !== "tenant"),
    );
  });

  it("parses VOLA_OCR_LANGS against OcrLanguages", () => {
    expect(OCR_LANGUAGES).toEqual(["eng", "srp", "deu"]);
    expect(DEFAULT_OCR_LANGS).toBe("eng+srp+deu");
    expect(parseOcrLangs("eng+srp+deu")).toEqual(["eng", "srp", "deu"]);
    expect(parseOcrLangs(" ENG + deu+eng ")).toEqual(["eng", "deu"]);
    expect(() => parseOcrLangs("eng+fra")).toThrow(/unknown OCR language "fra".*eng, srp, deu/);
    expect(() => parseOcrLangs("")).toThrow(/no language/);
    expect(() => parseOcrLangs("+")).toThrow(/no language/);
  });

  it("names the defaults and the info shape", () => {
    expect(DEFAULT_OCR_MAX_PAGES).toBe(20);
    expect(DEFAULT_OCR_TIMEOUT_S).toBe(120);
    expect(OCR_TEXT_PREVIEW_LENGTH).toBe(500);
    expect(OCR_PAGE_SEPARATOR).toBe("\f");
    expect(
      OcrInfoSchema.parse({ status: "DONE", lang: "eng+srp+deu", pages: 2, text_preview: "x" }),
    ).toEqual({ status: "DONE", lang: "eng+srp+deu", pages: 2, text_preview: "x" });
    expect(
      OcrInfoSchema.parse({ status: null, lang: null, pages: null, text_preview: null }),
    ).toMatchObject({ status: null });
    expect(() =>
      OcrInfoSchema.parse({ status: "NOPE", lang: null, pages: null, text_preview: null }),
    ).toThrow();
  });
});
