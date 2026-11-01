import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  extractText,
  OcrError,
  pdftoppmArgs,
  probeTesseract,
  runCapped,
  tesseractArgs,
} from "../src/services/ocr.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { needsSqlMatch } from "../src/udc/files-source.js";
import { pdfFixture, pngFixture } from "./fixtures.js";

/**
 * The OCR building blocks WITHOUT tesseract: the command lines, the capped process runner,
 * the probe, the PDF page loop and the configuration — every tool here is a shell script.
 */
let dir: string;
let storage: FilesystemBackend;
let pngHash: string;
let pdfHash: string;
/** A `tesseract` that prints a line naming its input (and answers --version / --list-langs). */
let fakeTesseract: string;
/** A `pdftoppm` that writes `min(-l, 3)` empty pages. */
let fakePdftoppm: string;
/** The `vola-ocr-*` directories of tmpdir before the suite: a pass must not add one. */
let tempDirsBefore: string[];

const tempDirs = async () =>
  (await readdir(tmpdir())).filter(
    (n) => n.startsWith("vola-ocr-") && !n.startsWith("vola-ocr-helpers-"),
  );

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function stored(bytes: Buffer): Promise<string> {
  const staged = await storage.stage(Readable.from(bytes));
  await storage.commit(staged);
  return staged.hash;
}

beforeAll(async () => {
  tempDirsBefore = await tempDirs();
  dir = await mkdtemp(join(tmpdir(), "vola-ocr-helpers-"));
  storage = new FilesystemBackend(join(dir, "storage"));
  pngHash = await stored(await pngFixture());
  pdfHash = await stored(pdfFixture());
  fakeTesseract = await script(
    "tesseract",
    `case "$1" in
  --version) echo "tesseract 9.9-fake"; echo "leptonica-1.84"; exit 0;;
  --list-langs) echo "List of available languages in /x/tessdata/ (4):"; echo deu; echo eng; echo osd; echo srp; exit 0;;
esac
echo "Estimating resolution as 300" >&2
echo "TEXT OF $(basename "$1") with $4"
printf '\\f'`,
  );
  fakePdftoppm = await script(
    "pdftoppm",
    `# -r DPI -png -f 1 -l MAX pdf prefix
max=$7; [ "$max" -gt 3 ] && max=3
i=1
while [ "$i" -le "$max" ]; do : > "$9-$i.png"; i=$((i+1)); done`,
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OCR command lines", () => {
  it("tesseract reads the file, prints to stdout, -l joins the languages with +", () => {
    expect(tesseractArgs("/tmp/x/in", ["eng", "srp", "deu"])).toEqual([
      "/tmp/x/in",
      "stdout",
      "-l",
      "eng+srp+deu",
    ]);
    expect(tesseractArgs("page-1.png", ["eng"])).toEqual(["page-1.png", "stdout", "-l", "eng"]);
  });
  it("pdftoppm rasterises at 200 dpi as PNG from the first page up to the limit", () => {
    expect(pdftoppmArgs("/tmp/x/in.pdf", "/tmp/x/page", 20)).toEqual([
      "-r",
      "200",
      "-png",
      "-f",
      "1",
      "-l",
      "20",
      "/tmp/x/in.pdf",
      "/tmp/x/page",
    ]);
  });
});

describe("runCapped", () => {
  it("resolves with stdout of a process that exits 0 (arguments as a list, no shell)", async () => {
    const echo = await script("echo-args", 'printf "%s|" "$@"');
    expect(await runCapped(echo, ["a b", "$HOME", "; ls"], { timeoutMs: 5000 })).toBe(
      "a b|$HOME|; ls|",
    );
  });
  it("is tool_missing for a binary that is not there (the error never carries the path)", async () => {
    const error = await runCapped(join(dir, "no-such-tool"), ["x"], { timeoutMs: 1000 }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(OcrError);
    expect(error.code).toBe("tool_missing");
    expect(error.message).toBe("no-such-tool is not installed");
  });
  it("is failed with the exit code and the first useful stderr line", async () => {
    const bad = await script(
      "bad",
      'echo "Estimating resolution as 300" >&2; echo "Error in pixReadMem: no pix returned" >&2; exit 1',
    );
    const error = await runCapped(bad, [], { timeoutMs: 1000 }).catch((e) => e);
    expect(error.code).toBe("failed");
    expect(error.message).toBe("bad failed (exit 1): Error in pixReadMem: no pix returned");
  });
  it("kills a process past the time limit: timeout", async () => {
    const slow = await script("slow", "sleep 30");
    const started = Date.now();
    const error = await runCapped(slow, [], { timeoutMs: 200 }).catch((e) => e);
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("slow exceeded 200 ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it("kills a process that prints more than the cap: output_too_large", async () => {
    const chatty = await script("chatty", "yes | head -c 200000");
    const error = await runCapped(chatty, [], { timeoutMs: 5000, maxOutputBytes: 1024 }).catch(
      (e) => e,
    );
    expect(error.code).toBe("output_too_large");
    expect(error.message).toBe("chatty printed more than 1024 bytes");
  });
});

describe("probeTesseract", () => {
  it("reports the version and the installed languages", async () => {
    expect(await probeTesseract(fakeTesseract)).toEqual({
      version: "tesseract 9.9-fake",
      langs: ["deu", "eng", "osd", "srp"],
    });
  });
  it("is null when the binary is missing, throws on a broken one", async () => {
    expect(await probeTesseract(join(dir, "tesseract-missing"))).toBeNull();
    const broken = await script("tesseract-broken", 'echo "boom" >&2; exit 2');
    await expect(probeTesseract(broken)).rejects.toMatchObject({ code: "failed" });
  });
});

describe("extractText", () => {
  it("runs tesseract once on an image, tidies the text, pages = 1", async () => {
    const result = await extractText(
      storage,
      { hash: pngHash, mimeType: "image/png" },
      { langs: ["eng", "srp"], maxPages: 20, timeoutMs: 5000, tesseract: fakeTesseract },
    );
    expect(result).toEqual({ text: "TEXT OF in with eng+srp", pages: 1, lang: "eng+srp" });
  });
  it("rasterises a PDF, reads at most maxPages pages and joins them with \\f", async () => {
    const run = (maxPages: number) =>
      extractText(
        storage,
        { hash: pdfHash, mimeType: "application/pdf" },
        {
          langs: ["eng"],
          maxPages,
          timeoutMs: 5000,
          tesseract: fakeTesseract,
          pdftoppm: fakePdftoppm,
        },
      );
    expect(await run(20)).toEqual({
      text: "TEXT OF page-1.png with eng\fTEXT OF page-2.png with eng\fTEXT OF page-3.png with eng",
      pages: 3,
      lang: "eng",
    });
    expect(await run(2)).toMatchObject({ pages: 2 });
    // The temporary directories are gone.
    expect(await tempDirs()).toEqual(tempDirsBefore);
  });
  it("refuses an unsupported type, a missing blob, a missing tool, a page past the time limit", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "ok").catch((e: OcrError) => e.code);
    const base = { langs: ["eng"], maxPages: 20, timeoutMs: 5000, tesseract: fakeTesseract };
    expect(
      await code(extractText(storage, { hash: pngHash, mimeType: "image/svg+xml" }, base)),
    ).toBe("unsupported");
    expect(
      await code(extractText(storage, { hash: "0".repeat(64), mimeType: "image/png" }, base)),
    ).toBe("blob_missing");
    expect(
      await code(
        extractText(
          storage,
          { hash: pngHash, mimeType: "image/png" },
          { ...base, tesseract: join(dir, "nope") },
        ),
      ),
    ).toBe("tool_missing");
    expect(
      await code(
        extractText(
          storage,
          { hash: pdfHash, mimeType: "application/pdf" },
          { ...base, pdftoppm: join(dir, "nope") },
        ),
      ),
    ).toBe("tool_missing");
    const slow = await script("tesseract-slow", "sleep 30");
    expect(
      await code(
        extractText(
          storage,
          { hash: pngHash, mimeType: "image/png" },
          { ...base, tesseract: slow, timeoutMs: 200 },
        ),
      ),
    ).toBe("timeout");
    const nothing = await script("pdftoppm-nothing", "exit 0");
    expect(
      await code(
        extractText(
          storage,
          { hash: pdfHash, mimeType: "application/pdf" },
          { ...base, pdftoppm: nothing },
        ),
      ),
    ).toBe("failed");
    expect(await tempDirs()).toEqual(tempDirsBefore);
  });
});

describe("OCR configuration", () => {
  it("defaults: auto, eng+srp+deu, 20 pages, 120 s", () => {
    expect(loadConfig({}).ocr).toEqual({
      enabled: "auto",
      langs: ["eng", "srp", "deu"],
      maxPages: 20,
      timeoutS: 120,
    });
  });
  it("reads VOLA_OCR_*", () => {
    expect(
      loadConfig({
        VOLA_OCR_ENABLED: "0",
        VOLA_OCR_LANGS: "deu+eng",
        VOLA_OCR_MAX_PAGES: "5",
        VOLA_OCR_TIMEOUT_S: "30",
      }).ocr,
    ).toEqual({ enabled: false, langs: ["deu", "eng"], maxPages: 5, timeoutS: 30 });
    expect(loadConfig({ VOLA_OCR_ENABLED: "true" }).ocr.enabled).toBe(true);
    expect(loadConfig({ VOLA_OCR_ENABLED: "auto" }).ocr.enabled).toBe("auto");
  });
  it("names an unknown language and a bad limit clearly", () => {
    expect(() => loadConfig({ VOLA_OCR_LANGS: "eng+fra" })).toThrow(
      /VOLA_OCR_LANGS: unknown OCR language "fra" \(OcrLanguages: eng, srp, deu\)/,
    );
    expect(() => loadConfig({ VOLA_OCR_ENABLED: "maybe" })).toThrow(ConfigError);
    expect(() => loadConfig({ VOLA_OCR_MAX_PAGES: "0" })).toThrow(/VOLA_OCR_MAX_PAGES/);
    expect(() => loadConfig({ VOLA_OCR_TIMEOUT_S: "0" })).toThrow(/VOLA_OCR_TIMEOUT_S/);
  });
});

describe("needsSqlMatch", () => {
  it("is true only for a search of the OCR text", () => {
    expect(needsSqlMatch(undefined)).toBe(false);
    expect(needsSqlMatch({ field: "filename", op: "contains", value: "x" })).toBe(false);
    expect(needsSqlMatch({ field: "ocr", op: "eq", value: true })).toBe(false);
    expect(needsSqlMatch({ field: "ocr", op: "is_not_null", value: null })).toBe(false);
    expect(needsSqlMatch({ field: "ocr", op: "contains", value: "invoice" })).toBe(true);
    expect(needsSqlMatch({ field: "ocr", op: "eq", value: "invoice" })).toBe(true);
    expect(
      needsSqlMatch({
        and: [
          { field: "instance_type", op: "eq", value: "tickets" },
          { or: [{ field: "ocr", op: "neq", value: "invoice" }] },
        ],
      }),
    ).toBe(true);
    expect(needsSqlMatch({ not: { field: "ocr", op: "eq", value: "false" } })).toBe(false);
  });
});
