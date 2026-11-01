/**
 * `Content-Disposition` (RFC 6266) for downloads, with the non-ASCII name in `filename*`
 * (RFC 5987/8187) so the header is pure latin-1 on the wire and the browser still sees the real
 * name — e.g. the U+202F narrow no-break space macOS puts into screenshot names.
 */

export type DispositionType = "inline" | "attachment";

/** MIME types a browser may render inline; everything else is a download. */
const INLINE_MAJOR = new Set(["image", "video", "audio"]);
const INLINE_EXACT = new Set(["application/pdf"]);

/** The bare, lowercase media type: `Image/PNG; q=1` → `image/png`. */
export function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * `inline` for images (NOT SVG: it is an "image" that carries `<script>` and shown inline it
 * would run on the API's origin), video, audio and PDF; `attachment` for everything else and
 * whenever the caller forces a download (`?download=1`).
 */
export function dispositionFor(
  mime: string | null | undefined,
  forceDownload = false,
): DispositionType {
  if (forceDownload) return "attachment";
  const type = normalizeMime(mime);
  if (type === "image/svg+xml") return "attachment";
  if (INLINE_EXACT.has(type)) return "inline";
  const major = type.split("/", 1)[0] ?? "";
  return INLINE_MAJOR.has(major) ? "inline" : "attachment";
}

/** Percent-encodes `value` as an RFC 8187 `ext-value` (`attr-char` kept, the rest `%XX`). */
export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const CONTROL_RE = /\p{Cc}/gu;
const NON_ASCII_RE = /[^\x20-\x7e]/g;

/**
 * `attachment; filename="report.pdf"` for an ASCII name;
 * `attachment; filename="Ra_port.pdf"; filename*=UTF-8''Ra%C4%8Dport.pdf` otherwise (the
 * ASCII fallback for old clients, the real name for everyone else).
 */
export function contentDisposition(filename: string, type: DispositionType): string {
  const clean = filename.replace(CONTROL_RE, "");
  const quote = (name: string) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (!NON_ASCII_RE.test(clean)) return `${type}; filename=${quote(clean)}`;
  const fallback = clean.replace(NON_ASCII_RE, "_");
  return `${type}; filename=${quote(fallback)}; filename*=UTF-8''${encodeRfc5987(clean)}`;
}
