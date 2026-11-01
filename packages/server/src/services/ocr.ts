import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  OCR_PAGE_SEPARATOR,
  OCR_TEXT_PREVIEW_LENGTH,
  type OcrInfo,
  ocrSupported,
  type ProcessingStatus,
} from "@vola/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { type FileMetadataRow, fileMetadata, processingJobs } from "../db/schema.js";
import { BlobNotFoundError, type StorageBackend } from "../storage/index.js";

export { isOcrEligible, ocrSupported } from "@vola/core";

/** The binaries, when not given: the ones on `PATH`. */
export const DEFAULT_TESSERACT = "tesseract";
export const DEFAULT_PDFTOPPM = "pdftoppm";
/** Most bytes one `tesseract` run may print; past it the process is killed and the pass fails. */
export const OCR_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Most bytes of stderr kept for an error message. */
const STDERR_KEEP_BYTES = 4096;
/** The resolution a PDF page is rasterised at before tesseract reads it. */
export const OCR_PDF_DPI = 200;
/** How long `tesseract --version` / `--list-langs` may take at start-up. */
const PROBE_TIMEOUT_MS = 15_000;

export type OcrErrorCode =
  | "unsupported"
  | "blob_missing"
  | "tool_missing"
  | "failed"
  | "timeout"
  | "output_too_large";

/** An OCR pass did not happen; `code` says why and `message` is safe to store (no file name). */
export class OcrError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OcrError";
  }
}

/** Thrown at the worker's start when OCR is insisted on and cannot run. */
export class OcrSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrSetupError";
  }
}

// --- commands -------------------------------------------------------------------------

/** `tesseract <input> stdout -l <langs>`: the text of one image on stdout. */
export function tesseractArgs(input: string, langs: readonly string[]): string[] {
  return [input, "stdout", "-l", langs.join("+")];
}

/** `pdftoppm -r 200 -png -f 1 -l <maxPages> <pdf> <outPrefix>`: one PNG per page, `<outPrefix>-<n>.png`. */
export function pdftoppmArgs(pdf: string, outPrefix: string, maxPages: number): string[] {
  return ["-r", String(OCR_PDF_DPI), "-png", "-f", "1", "-l", String(maxPages), pdf, outPrefix];
}

export interface RunOptions {
  /** Wall-clock limit; past it the process is killed and the run is a `timeout`. */
  timeoutMs: number;
  /** Most stdout bytes kept; past it the process is killed (`output_too_large`). Default 10 MiB. */
  maxOutputBytes?: number | undefined;
}

/**
 * Runs `bin` with `args` as a list (no shell, nothing is interpolated), collects stdout up to
 * `maxOutputBytes`, and resolves with it as UTF-8 when the process exits 0. Rejects with an
 * `OcrError`: `tool_missing` (ENOENT), `timeout`, `output_too_large`, or `failed` with the
 * exit code and the first line of stderr.
 */
export function runCapped(
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<string> {
  const max = options.maxOutputBytes ?? OCR_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    // Its own process group, so a kill reaches whatever the tool started (and holds the pipe).
    const child = spawn(bin, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let failure: OcrError | null = null;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = (error: OcrError) => {
      if (failure) return;
      failure = error;
      kill();
      // Do not wait for the pipes: a grandchild may keep them open.
      child.stdout.destroy();
      child.stderr.destroy();
      settle(() => reject(error));
    };
    const timer = setTimeout(
      () => fail(new OcrError("timeout", `${describe(bin)} exceeded ${options.timeoutMs} ms`)),
      options.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outBytes += chunk.length;
      if (outBytes > max) {
        fail(new OcrError("output_too_large", `${describe(bin)} printed more than ${max} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < STDERR_KEEP_BYTES) err += chunk.toString("utf8", 0, STDERR_KEEP_BYTES);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(() => {
        if (error.code === "ENOENT") {
          reject(
            new OcrError("tool_missing", `${describe(bin)} is not installed`, { cause: error }),
          );
        } else {
          reject(
            new OcrError("failed", `${describe(bin)} could not start: ${error.message}`, {
              cause: error,
            }),
          );
        }
      });
    });
    // `close`: the process exited AND its pipes are closed, so every byte of stdout is in.
    child.once("close", (code, signal) => {
      settle(() => {
        if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
        const reason = firstLine(err);
        reject(
          new OcrError(
            "failed",
            `${describe(bin)} failed (${code === null ? `signal ${signal}` : `exit ${code}`})${reason ? `: ${reason}` : ""}`,
          ),
        );
      });
    });
  });
}

/** The tool by its base name only — never a path in an error that is stored. */
function describe(bin: string): string {
  return bin.split(/[\\/]/).pop() || bin;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "" && !/^(Estimating resolution|Warning)/i.test(l)) ?? ""
  );
}

// --- probe ------------------------------------------------------------------------------

export interface TesseractProbe {
  /** The first line of `tesseract --version` (`tesseract 5.3.4`). */
  version: string;
  /** The language codes `--list-langs` reports (`deu`, `eng`, `osd`, `srp`). */
  langs: string[];
}

/**
 * `tesseract --version` (and `--list-langs`): what is installed, or `null` when the binary
 * is not there. Any other failure (a broken installation) is thrown as an `OcrError`.
 */
export async function probeTesseract(
  bin: string = DEFAULT_TESSERACT,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<TesseractProbe | null> {
  let version: string;
  try {
    version = await runCapped(bin, ["--version"], { timeoutMs, maxOutputBytes: 64 * 1024 });
  } catch (error) {
    if (error instanceof OcrError && error.code === "tool_missing") return null;
    throw error;
  }
  // tesseract prints the language list on stdout (5.x) — or stderr (4.x), which runCapped
  // does not keep; an empty list is then "unknown", and the start-up check lets it pass.
  const listed = await runCapped(bin, ["--list-langs"], { timeoutMs, maxOutputBytes: 64 * 1024 });
  const langs = listed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^List of/i.test(l) && /^[a-z_]+$/i.test(l));
  return { version: firstLine(version) || "tesseract", langs };
}

// --- the pass ---------------------------------------------------------------------------

/** What is OCRed: the blob and what it is. */
export interface OcrSource {
  hash: string;
  mimeType: string;
}

export interface OcrRunOptions {
  /** tesseract's `-l`: `["eng", "srp", "deu"]`. */
  langs: readonly string[];
  /** Pages of a PDF read, from the first. */
  maxPages: number;
  /** Per page (and per image): the limit of one tesseract run, and of the rasterisation. */
  timeoutMs: number;
  tesseract?: string | undefined;
  pdftoppm?: string | undefined;
  /** Most stdout bytes of one tesseract run. Default 10 MiB. */
  maxOutputBytes?: number | undefined;
}

export interface OcrResult {
  /** The text; the pages of a PDF joined with `\f`. Empty when nothing was recognised. */
  text: string;
  /** Pages read: 1 for an image. */
  pages: number;
  /** The `-l` the pass ran with. */
  lang: string;
}

/** One tesseract run's text, tidied: no trailing form feed, no trailing blank lines. */
function tidy(text: string): string {
  return text
    .replace(/\f/g, "")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

/**
 * Reads the text of `source`: an image goes to `tesseract <file> stdout -l <langs>` as it is;
 * a PDF is rasterised with `pdftoppm -r 200 -png` (at most `maxPages` pages) into a temporary
 * directory and tesseract reads page after page, each under `timeoutMs`; the pages are joined
 * with `\f`. The temporary directory is removed whatever happens. Throws `OcrError`:
 * `unsupported`, `blob_missing`, `tool_missing`, `failed`, `timeout`, `output_too_large`.
 */
export async function extractText(
  storage: StorageBackend,
  source: OcrSource,
  options: OcrRunOptions,
): Promise<OcrResult> {
  if (!ocrSupported(source.mimeType)) {
    throw new OcrError("unsupported", `no OCR for ${source.mimeType}`);
  }
  const tesseract = options.tesseract ?? DEFAULT_TESSERACT;
  const pdftoppm = options.pdftoppm ?? DEFAULT_PDFTOPPM;
  const lang = options.langs.join("+");
  const run: RunOptions = { timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes };
  const dir = await mkdtemp(join(tmpdir(), "vola-ocr-"));
  try {
    const input = join(dir, source.mimeType === "application/pdf" ? "in.pdf" : "in");
    try {
      await pipeline(await storage.open(source.hash), createWriteStream(input));
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        throw new OcrError("blob_missing", "the stored bytes are missing", { cause: error });
      }
      throw error;
    }
    if (source.mimeType !== "application/pdf") {
      const text = await runCapped(tesseract, tesseractArgs(input, options.langs), run);
      return { text: tidy(text), pages: 1, lang };
    }
    const prefix = join(dir, "page");
    await runCapped(pdftoppm, pdftoppmArgs(input, prefix, options.maxPages), {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    const pages = (await readdir(dir))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => pageNumber(a) - pageNumber(b));
    if (pages.length === 0) throw new OcrError("failed", "pdftoppm rendered no page");
    const texts: string[] = [];
    for (const page of pages) {
      texts.push(
        tidy(await runCapped(tesseract, tesseractArgs(join(dir, page), options.langs), run)),
      );
    }
    return { text: texts.join(OCR_PAGE_SEPARATOR), pages: pages.length, lang };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function pageNumber(name: string): number {
  return Number(/(\d+)\.png$/.exec(name)?.[1] ?? 0);
}

// --- the sidecar row --------------------------------------------------------------------

export interface OcrSave {
  fileId: string;
  tenantId: string;
  text: string;
  lang: string;
  pages: number;
  at: Date;
}

/** Stores the result of a pass: one row per file, replaced on a second pass. */
export async function saveOcrResult(db: Database, save: OcrSave): Promise<FileMetadataRow> {
  const values = {
    fileId: save.fileId,
    tenantId: save.tenantId,
    ocrText: save.text,
    ocrLang: save.lang,
    ocrPages: save.pages,
    ocrAt: save.at,
  };
  const [row] = await db
    .insert(fileMetadata)
    .values(values)
    .onConflictDoUpdate({
      target: fileMetadata.fileId,
      set: {
        ocrText: values.ocrText,
        ocrLang: values.ocrLang,
        ocrPages: values.ocrPages,
        ocrAt: values.ocrAt,
      },
    })
    .returning();
  return row as FileMetadataRow;
}

/** The sidecar row of a file, or `null` before any pass stored something. */
export async function findFileMetadata(
  db: Database,
  fileId: string,
): Promise<FileMetadataRow | null> {
  const [row] = await db
    .select()
    .from(fileMetadata)
    .where(eq(fileMetadata.fileId, fileId))
    .limit(1);
  return row ?? null;
}

/** The status of the file's `OCR` job (`null`: none was created). */
export async function ocrJobStatus(db: Database, fileId: string): Promise<ProcessingStatus | null> {
  const [row] = await db
    .select({ status: processingJobs.status })
    .from(processingJobs)
    .where(and(eq(processingJobs.fileId, fileId), eq(processingJobs.kind, "OCR")))
    .limit(1);
  return (row?.status as ProcessingStatus | undefined) ?? null;
}

/**
 * The `ocr` block of `…/info`: the job's status and, once a pass stored its text, the
 * language, the page count and the first 500 characters; `full` adds the whole text.
 */
export async function ocrInfoOf(
  db: Database,
  fileId: string,
  options: { full?: boolean | undefined } = {},
): Promise<OcrInfo> {
  const [status, meta] = await Promise.all([
    ocrJobStatus(db, fileId),
    findFileMetadata(db, fileId),
  ]);
  const text = meta?.ocrText ?? null;
  return {
    status,
    lang: meta?.ocrLang ?? null,
    pages: meta?.ocrPages ?? null,
    text_preview: text === null ? null : text.slice(0, OCR_TEXT_PREVIEW_LENGTH),
    ...(options.full ? { text } : {}),
  };
}
