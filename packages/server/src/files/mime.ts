import type { FileKind } from "@vola/core";
import { fileTypeFromBuffer } from "file-type";
import { normalizeMime } from "./content-disposition.js";
import { extensionOf } from "./filename.js";

/** Bytes of the head of a file `file-type` needs to recognise it. */
export const SNIFF_BYTES = 4100;

/** Types `file-type` reports for containers it cannot see into; the extension knows better. */
const GENERIC_SNIFFED = new Set(["application/x-cfb", "application/octet-stream"]);

/** Extension → MIME, for what magic bytes cannot tell (text formats) and as the fallback. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: "text/plain",
  log: "text/plain",
  ini: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  sql: "application/sql",
  sh: "application/x-sh",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java-source",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  php: "text/x-php",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/vnd.microsoft.icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
};

/** `type/subtype` with the RFC 7231 token alphabet. */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** MIME of `filename` by its extension, or `null`. */
export function mimeForExtension(filename: string): string | null {
  const ext = extensionOf(filename);
  return ext ? (BY_EXTENSION[ext] ?? null) : null;
}

export interface DetectMimeInput {
  /** The first bytes of the file (up to `SNIFF_BYTES`). */
  head: Uint8Array;
  filename: string;
  /** What the client declared (`Content-Type` of the part), if anything. */
  declared?: string | null | undefined;
}

/**
 * The MIME type of an upload: magic bytes first (`file-type`), then the extension, then what
 * the client declared, else `application/octet-stream`. A sniffed generic container type
 * (`application/x-cfb` of an old `.doc`) defers to the extension.
 */
export async function detectMime(input: DetectMimeInput): Promise<string> {
  const byExtension = mimeForExtension(input.filename);
  if (input.head.length > 0) {
    const sniffed = await fileTypeFromBuffer(input.head).catch(() => undefined);
    if (sniffed && !(GENERIC_SNIFFED.has(sniffed.mime) && byExtension)) return sniffed.mime;
  }
  if (byExtension) return byExtension;
  const declared = normalizeMime(input.declared);
  return MIME_RE.test(declared) ? declared : "application/octet-stream";
}

const KIND_EXACT: Readonly<Record<string, FileKind>> = {
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/rtf": "document",
  "application/epub+zip": "document",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet": "spreadsheet",
  "text/csv": "spreadsheet",
  "text/tab-separated-values": "spreadsheet",
  "application/vnd.ms-powerpoint": "presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/vnd.oasis.opendocument.presentation": "presentation",
  "application/zip": "archive",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/x-7z-compressed": "archive",
  "application/vnd.rar": "archive",
  "application/x-rar-compressed": "archive",
  "application/x-bzip2": "archive",
  "application/x-xz": "archive",
  "application/zstd": "archive",
  "application/json": "code",
  "application/xml": "code",
  "application/yaml": "code",
  "application/toml": "code",
  "application/sql": "code",
  "application/x-sh": "code",
  "application/javascript": "code",
  "text/javascript": "code",
  "text/typescript": "code",
  "text/html": "code",
  "text/css": "code",
  "text/x-python": "code",
  "text/x-ruby": "code",
  "text/x-go": "code",
  "text/x-rust": "code",
  "text/x-java-source": "code",
  "text/x-c": "code",
  "text/x-c++": "code",
  "text/x-php": "code",
};

/** The `FileKind` of a MIME type (`image/*` → `image`, PDF → `document`, …, else `other`). */
export function kindForMime(mime: string | null | undefined): FileKind {
  const type = normalizeMime(mime);
  const exact = KIND_EXACT[type];
  if (exact) return exact;
  const major = type.split("/", 1)[0];
  switch (major) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "text":
      return "text";
    default:
      return "other";
  }
}
