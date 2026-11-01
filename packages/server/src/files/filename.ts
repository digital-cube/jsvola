/** Filenames: sanitising what a client sent, the extension, and the collision rename. */

export const MAX_FILENAME_LENGTH = 255;

const CONTROL_RE = /\p{Cc}/gu;
const EXTENSION_RE = /^[a-z0-9]{1,50}$/;

/**
 * The name a multipart part declared, made safe: only the last path segment (browsers and
 * some clients send `C:\…\x.pdf` or `dir/x.pdf`), no control characters, trimmed, at most 255
 * characters (the extension survives the cut), never empty, `.` or `..`.
 */
export function sanitizeFilename(raw: string | undefined | null, fallback = "unnamed"): string {
  const segment = (raw ?? "").split(/[/\\]/).pop() ?? "";
  let name = segment.replace(CONTROL_RE, "").trim();
  if (!name || name === "." || name === "..") name = fallback;
  if (name.length > MAX_FILENAME_LENGTH) {
    const { base, ext } = splitFilename(name);
    const room = Math.max(1, MAX_FILENAME_LENGTH - ext.length);
    name = base.slice(0, room) + ext.slice(0, MAX_FILENAME_LENGTH - Math.min(base.length, room));
  }
  return name;
}

/**
 * `report.pdf` → `{ base: "report", ext: ".pdf" }`; `archive.tar.gz` → `archive.tar` + `.gz`;
 * `README` and `.bashrc` → no extension.
 */
export function splitFilename(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, dot), ext: filename.slice(dot) };
}

/** The lowercase extension without the dot (`^[a-z0-9]{1,50}$`), or `null`. */
export function extensionOf(filename: string): string | null {
  const ext = splitFilename(filename).ext.slice(1).toLowerCase();
  return EXTENSION_RE.test(ext) ? ext : null;
}

/**
 * The first free name: `a.pdf` → `a (1).pdf` → `a (2).pdf` … `taken` are the names already
 * live in the same (tenant, instance, folder); the comparison is exact (case-sensitive).
 */
export function nextCollisionFilename(filename: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(filename)) return filename;
  const { base, ext } = splitFilename(filename);
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!set.has(candidate)) return candidate;
  }
}
