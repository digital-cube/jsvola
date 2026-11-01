/**
 * One page of a PDF held in memory as a PNG, through `pdftoppm`'s stdin (`-`) and stdout
 * (no output root, `-singlefile`): the document and the page never touch the disk, which is
 * what the OCR and the thumbnail of an ENCRYPTED file need (`docs/CRYPTO.md` § 11). Shared by
 * `thumbnails.ts` (page 1) and `ocr.ts` (page after page).
 */
import { spawn } from "node:child_process";

export interface PdfPageOptions {
  timeoutMs: number;
  pdftoppm: string;
  /** Rasterisation resolution. Default 72 (a thumbnail); OCR uses 200. */
  dpi?: number | undefined;
  /** Most PNG bytes accepted. Default 64 MiB. */
  maxOutputBytes?: number | undefined;
}

export type PdfPageErrorCode = "timeout" | "tool_missing" | "failed" | "output_too_large";

export class PdfPageError extends Error {
  constructor(
    readonly code: PdfPageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PdfPageError";
  }
}

/**
 * Page `page` (1-based) of `pdf` as a PNG; `null` when the document has no such page
 * (pdftoppm exits 99 with nothing on stdout past the last page). Throws `PdfPageError`.
 */
export function pdfPageFromBuffer(
  pdf: Buffer,
  page: number,
  options: PdfPageOptions,
): Promise<Buffer | null> {
  const max = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const args = [
    "-f",
    String(page),
    "-l",
    String(page),
    "-r",
    String(options.dpi ?? 72),
    "-png",
    "-singlefile",
    "-",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(options.pdftoppm, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    let failure: PdfPageError | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (error: PdfPageError) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      settle(() => reject(error));
    };
    const timer = setTimeout(
      () => fail(new PdfPageError("timeout", `pdftoppm exceeded ${options.timeoutMs} ms`)),
      options.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outBytes += chunk.length;
      if (outBytes > max) {
        fail(new PdfPageError("output_too_large", `pdftoppm printed more than ${max} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          error.code === "ENOENT"
            ? new PdfPageError("tool_missing", "pdftoppm is not installed", { cause: error })
            : new PdfPageError("failed", `pdftoppm could not start: ${error.message}`, {
                cause: error,
              }),
        ),
      );
    });
    child.once("close", (code, signal) => {
      settle(() => {
        if (code === 0 && outBytes > 0) return resolve(Buffer.concat(out));
        // Past the last page pdftoppm prints nothing (and exits 99 or 0, by version).
        if (outBytes === 0 && (code === 0 || code === 99) && page > 1) return resolve(null);
        reject(
          new PdfPageError(
            "failed",
            `pdftoppm failed (${code === null ? `signal ${signal}` : `exit ${code}`})`,
          ),
        );
      });
    });
    child.stdin.on("error", () => undefined); // EPIPE when pdftoppm gives up early: `close` reports
    child.stdin.end(pdf);
  });
}
