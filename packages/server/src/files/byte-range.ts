/**
 * RFC 9110 §14 byte ranges for downloads. A `<video>` seeks by asking for the bytes around a
 * timestamp with `Range`; without `206` answers media cannot be scrubbed.
 *
 * Rules: a malformed value, another unit, or several ranges are IGNORED (the whole file,
 * `200` — what §14.2 asks for, and multi-range bodies are something no media element needs);
 * only a well-formed range that lies outside the file is refused with `416`.
 */

/** One resolved, satisfiable range; `end` is INCLUSIVE like the header. */
export interface ByteRange {
  start: number;
  end: number;
}

/** A well-formed range the file has no bytes for (→ `416` with `Content-Range: bytes * /size`). */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super(`range not satisfiable for a file of ${size} bytes`);
    this.name = "RangeNotSatisfiableError";
  }
}

/** `bytes=<first>-<last>`, `bytes=<first>-`, or `bytes=-<suffix-length>`; nothing else. */
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolves the `Range` header against a file of `size` bytes. `null` means "the whole file":
 * no header, another unit, several ranges, or a broken value. Throws
 * `RangeNotSatisfiableError` for a well-formed range outside the file.
 */
export function parseByteRange(header: string | undefined | null, size: number): ByteRange | null {
  if (!header) return null;
  const match = RANGE_RE.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (!first && !last) return null; // "bytes=-" is meaningless

  if (!first) {
    // Suffix form: the LAST n bytes. n beyond the size means the whole file (§14.1.2).
    const suffix = Number(last);
    if (suffix === 0 || size === 0) throw new RangeNotSatisfiableError(size);
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) throw new RangeNotSatisfiableError(size); // also every range of an empty file
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  if (end < start) return null; // nonsense, not a refusal
  return { start, end };
}

/** Number of bytes of `range`. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

/** `bytes <start>-<end>/<size>` of a `206`. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
