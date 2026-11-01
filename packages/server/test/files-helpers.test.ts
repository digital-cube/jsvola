import { describe, expect, it } from "vitest";
import {
  contentRange,
  parseByteRange,
  RangeNotSatisfiableError,
  rangeLength,
} from "../src/files/byte-range.js";
import {
  contentDisposition,
  dispositionFor,
  encodeRfc5987,
  normalizeMime,
} from "../src/files/content-disposition.js";
import {
  extensionOf,
  nextCollisionFilename,
  sanitizeFilename,
  splitFilename,
} from "../src/files/filename.js";
import { detectMime, kindForMime, mimeForExtension } from "../src/files/mime.js";

describe("parseByteRange", () => {
  const size = 1000;

  it("ignores a missing, foreign, multi-range or broken header (whole file)", () => {
    for (const header of [
      undefined,
      null,
      "",
      "items=0-10",
      "bytes=0-99,200-299",
      "bytes=abc",
      "bytes=-",
      "bytes= 0-10",
      "bytes=10-5",
    ]) {
      expect(parseByteRange(header, size), String(header)).toBeNull();
    }
  });

  it("resolves start, start-end, open end and suffix forms", () => {
    expect(parseByteRange("bytes=0-", size)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=500-599", size)).toEqual({ start: 500, end: 599 });
    expect(parseByteRange("bytes=900-", size)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-500", size)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange(" bytes=5-5 ", size)).toEqual({ start: 5, end: 5 });
  });

  it("clamps an end beyond the file", () => {
    expect(parseByteRange("bytes=990-5000", size)).toEqual({ start: 990, end: 999 });
  });

  it("refuses a well-formed range outside the file with 416", () => {
    expect(() => parseByteRange("bytes=1000-", size)).toThrow(RangeNotSatisfiableError);
    expect(() => parseByteRange("bytes=5000-6000", size)).toThrow(RangeNotSatisfiableError);
    expect(() => parseByteRange("bytes=-0", size)).toThrow(RangeNotSatisfiableError);
    expect(() => parseByteRange("bytes=0-", 0)).toThrow(RangeNotSatisfiableError);
    expect(() => parseByteRange("bytes=-10", 0)).toThrow(RangeNotSatisfiableError);
    try {
      parseByteRange("bytes=1000-", size);
    } catch (error) {
      expect((error as RangeNotSatisfiableError).size).toBe(size);
    }
  });

  it("formats Content-Range and the length", () => {
    const range = { start: 500, end: 999 };
    expect(rangeLength(range)).toBe(500);
    expect(contentRange(range, size)).toBe("bytes 500-999/1000");
  });
});

describe("content disposition", () => {
  it("renders images (not SVG), video, audio and PDF inline; everything else is an attachment", () => {
    expect(dispositionFor("image/png")).toBe("inline");
    expect(dispositionFor("Image/JPEG; q=0.9")).toBe("inline");
    expect(dispositionFor("video/mp4")).toBe("inline");
    expect(dispositionFor("audio/mpeg")).toBe("inline");
    expect(dispositionFor("application/pdf")).toBe("inline");
    expect(dispositionFor("image/svg+xml")).toBe("attachment");
    expect(dispositionFor("text/html")).toBe("attachment");
    expect(dispositionFor("application/octet-stream")).toBe("attachment");
    expect(dispositionFor(null)).toBe("attachment");
    expect(dispositionFor("image/png", true)).toBe("attachment");
  });

  it("quotes ASCII names and escapes quotes and backslashes", () => {
    expect(contentDisposition("report.pdf", "attachment")).toBe(
      'attachment; filename="report.pdf"',
    );
    expect(contentDisposition('we"ird\\name.txt', "inline")).toBe(
      'inline; filename="we\\"ird\\\\name.txt"',
    );
  });

  it("adds filename* (RFC 5987) with an ASCII fallback for non-ASCII names", () => {
    expect(contentDisposition("Račun 2026.pdf", "attachment")).toBe(
      "attachment; filename=\"Ra_un 2026.pdf\"; filename*=UTF-8''Ra%C4%8Dun%202026.pdf",
    );
    // macOS screenshot: U+202F narrow no-break space before "AM".
    const mac = "Screenshot 2026-02-11 at 1.48.02\u202fAM.png";
    const header = contentDisposition(mac, "inline");
    expect(header).toMatch(
      /^inline; filename="Screenshot 2026-02-11 at 1\.48\.02_AM\.png"; filename\*=UTF-8''/,
    );
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeURIComponent(header.split("UTF-8''")[1] as string)).toBe(mac);
  });

  it("strips control characters (header injection) and encodes RFC 5987 specials", () => {
    expect(contentDisposition("evil\r\nX-Injected: 1.txt", "attachment")).toBe(
      'attachment; filename="evilX-Injected: 1.txt"',
    );
    expect(encodeRfc5987("a'b(c)*d é")).toBe("a%27b%28c%29%2Ad%20%C3%A9");
    expect(normalizeMime(" Text/Plain ; charset=utf-8")).toBe("text/plain");
    expect(normalizeMime(undefined)).toBe("");
  });
});

describe("filenames", () => {
  it("sanitizes what the client sent", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("C:\\Users\\igor\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("  spaced.txt  ")).toBe("spaced.txt");
    expect(sanitizeFilename("bad\u0000\u0007name.txt")).toBe("badname.txt");
    expect(sanitizeFilename("")).toBe("unnamed");
    expect(sanitizeFilename(undefined)).toBe("unnamed");
    expect(sanitizeFilename("..")).toBe("unnamed");
    expect(sanitizeFilename("dir/")).toBe("unnamed");
    expect(sanitizeFilename("", "avatar")).toBe("avatar");
    const long = sanitizeFilename(`${"x".repeat(300)}.jpeg`);
    expect(long).toHaveLength(255);
    expect(long.endsWith(".jpeg")).toBe(true);
    expect(sanitizeFilename("y".repeat(300))).toBe("y".repeat(255));
  });

  it("splits base and extension and reads the extension", () => {
    expect(splitFilename("report.pdf")).toEqual({ base: "report", ext: ".pdf" });
    expect(splitFilename("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
    expect(splitFilename("README")).toEqual({ base: "README", ext: "" });
    expect(splitFilename(".bashrc")).toEqual({ base: ".bashrc", ext: "" });
    expect(extensionOf("Photo.JPG")).toBe("jpg");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("README")).toBeNull();
    expect(extensionOf(".bashrc")).toBeNull();
    expect(extensionOf("weird.ex-t")).toBeNull();
    expect(extensionOf(`f.${"a".repeat(51)}`)).toBeNull();
  });

  it("renames collisions a.pdf → a (1).pdf → a (2).pdf", () => {
    expect(nextCollisionFilename("a.pdf", [])).toBe("a.pdf");
    expect(nextCollisionFilename("a.pdf", ["a.pdf"])).toBe("a (1).pdf");
    expect(nextCollisionFilename("a.pdf", ["a.pdf", "a (1).pdf"])).toBe("a (2).pdf");
    expect(nextCollisionFilename("a.pdf", new Set(["a.pdf", "a (2).pdf"]))).toBe("a (1).pdf");
    expect(nextCollisionFilename("README", ["README"])).toBe("README (1)");
    expect(nextCollisionFilename("a (1).pdf", ["a (1).pdf"])).toBe("a (1) (1).pdf");
    expect(nextCollisionFilename("A.pdf", ["a.pdf"])).toBe("A.pdf");
  });
});

describe("MIME and kind detection", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n", "latin1");
  const ZIP = Buffer.from("504b0304140000000800", "hex");

  it("trusts magic bytes over the extension and the declared type", async () => {
    expect(await detectMime({ head: PNG, filename: "notes.txt", declared: "text/plain" })).toBe(
      "image/png",
    );
    expect(await detectMime({ head: PDF, filename: "scan", declared: null })).toBe(
      "application/pdf",
    );
    expect(await detectMime({ head: ZIP, filename: "bundle.bin" })).toBe("application/zip");
  });

  it("falls back to the extension, then to the declared type, then to octet-stream", async () => {
    const text = Buffer.from("hello, world\n");
    expect(await detectMime({ head: text, filename: "notes.txt", declared: "x" })).toBe(
      "text/plain",
    );
    expect(await detectMime({ head: text, filename: "data.JSON" })).toBe("application/json");
    expect(await detectMime({ head: text, filename: "logo.svg" })).toBe("image/svg+xml");
    expect(
      await detectMime({ head: text, filename: "blob", declared: "Application/X-Custom; v=1" }),
    ).toBe("application/x-custom");
    expect(await detectMime({ head: text, filename: "blob", declared: "not a mime" })).toBe(
      "application/octet-stream",
    );
    expect(await detectMime({ head: Buffer.alloc(0), filename: "empty" })).toBe(
      "application/octet-stream",
    );
    expect(mimeForExtension("x.docx")).toMatch(/wordprocessingml/);
    expect(mimeForExtension("x.unknownext")).toBeNull();
  });

  it("lets the extension refine a generic sniffed container (old Office CFB)", async () => {
    // Compound File Binary header: what every .doc/.xls/.ppt of Office 97–2003 starts with.
    const cfb = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(512)]);
    expect(await detectMime({ head: cfb, filename: "budget.xls" })).toBe(
      "application/vnd.ms-excel",
    );
    expect(await detectMime({ head: cfb, filename: "unknown" })).toBe("application/x-cfb");
  });

  it("maps MIME types to kinds", () => {
    expect(kindForMime("image/png")).toBe("image");
    expect(kindForMime("image/svg+xml")).toBe("image");
    expect(kindForMime("video/mp4")).toBe("video");
    expect(kindForMime("audio/ogg")).toBe("audio");
    expect(kindForMime("application/pdf")).toBe("document");
    expect(kindForMime("application/vnd.ms-excel")).toBe("spreadsheet");
    expect(kindForMime("text/csv")).toBe("spreadsheet");
    expect(kindForMime("application/vnd.ms-powerpoint")).toBe("presentation");
    expect(kindForMime("application/zip")).toBe("archive");
    expect(kindForMime("text/plain; charset=utf-8")).toBe("text");
    expect(kindForMime("application/json")).toBe("code");
    expect(kindForMime("text/html")).toBe("code");
    expect(kindForMime("application/octet-stream")).toBe("other");
    expect(kindForMime(undefined)).toBe("other");
  });
});
