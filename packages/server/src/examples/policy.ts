/**
 * What a visitor of the examples site may do through the write proxy (`/examples/write/*`),
 * decided from the method and the path alone — the pure part of the demo routes, tested
 * on its own. Everything the proxy forwards runs under the server's write key, so this list
 * IS the visitor's authority: nothing not named here goes through.
 */

/** A visitor principal: `demo-` and 6–32 lowercase letters or digits (what the site generates per session). */
export const DEMO_USER_RE = /^demo-[a-z0-9]{6,32}$/;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The MIME types a visitor may upload: images, PDF, short video and audio, plain text, Markdown. */
export const DEMO_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "text/plain",
  "text/markdown",
];

const UUID_RE = new RegExp(`^${UUID}$`, "i");

export type DemoAction =
  /** `POST /files/<demo instance>`: a plain upload (size and type checked around it). */
  | { kind: "upload" }
  /** `PATCH|DELETE /files/<demo instance>/:fileId[/purge]`: only a visitor's own file. */
  | { kind: "file-write"; fileId: string }
  /** `POST /folders/<demo instance>/<path>`: a new folder. */
  | { kind: "folder-create"; path: string }
  /** `PATCH|DELETE /folders/<demo instance>/<path>`: only a visitor's own folder. */
  | { kind: "folder-write"; path: string }
  /** `POST /uploads`: a resumable upload's creation (length and instance checked around it). */
  | { kind: "upload-create" }
  /** `HEAD|PATCH|DELETE /uploads/:id`: only a visitor's own upload. */
  | { kind: "upload-continue"; uploadId: string }
  /** `POST /shares`: expiry capped around it. */
  | { kind: "share-create" }
  /** `GET /shares`: a visitor's own shares. */
  | { kind: "share-list" }
  /** `GET|DELETE /shares/:id`: only a visitor's own share. */
  | { kind: "share-item"; shareId: string }
  /** `/keyrings/me/*` of the visitor's own principal. */
  | { kind: "keyring" };

export interface DemoScope {
  instanceType: string;
  instanceId: string;
}

/**
 * The action a request to the proxy stands for, or `null` when the visitor may not make it.
 * `path` is the part after `/examples/write/`, without a query string and without a leading
 * slash (`files/demo/<id>`).
 */
export function demoAction(method: string, path: string, scope: DemoScope): DemoAction | null {
  const m = method.toUpperCase();
  const instance = `${scope.instanceType}/${scope.instanceId}`;
  const segments = path.replace(/\/+$/, "").split("/");
  const [root, type, id, ...rest] = segments;

  if (root === "files" && type === scope.instanceType && id === scope.instanceId) {
    if (rest.length === 0) return m === "POST" ? { kind: "upload" } : null;
    const fileId = rest[0] ?? "";
    if (!UUID_RE.test(fileId)) return null;
    if (rest.length === 1 && (m === "PATCH" || m === "DELETE"))
      return { kind: "file-write", fileId };
    if (rest.length === 2 && rest[1] === "purge" && m === "DELETE")
      return { kind: "file-write", fileId };
    return null;
  }
  if (root === "folders" && type === scope.instanceType && id === scope.instanceId) {
    const folderPath = rest.join("/");
    if (!folderPath) return null;
    if (m === "POST") return { kind: "folder-create", path: folderPath };
    if (m === "PATCH" || m === "DELETE") return { kind: "folder-write", path: folderPath };
    return null;
  }
  if (root === "uploads") {
    if (segments.length === 1) return m === "POST" ? { kind: "upload-create" } : null;
    // An id in its plain form only: the real route decodes `%2D`, the ownership check must see what it sees.
    if (
      segments.length === 2 &&
      UUID_RE.test(type ?? "") &&
      ["HEAD", "PATCH", "DELETE"].includes(m)
    ) {
      return { kind: "upload-continue", uploadId: type as string };
    }
    return null;
  }
  if (root === "shares") {
    if (segments.length === 1 && m === "POST") return { kind: "share-create" };
    if (segments.length === 1 && m === "GET") return { kind: "share-list" };
    if (segments.length === 2 && UUID_RE.test(type ?? "") && (m === "GET" || m === "DELETE")) {
      return { kind: "share-item", shareId: type as string };
    }
    return null;
  }
  if (root === "keyrings" && type === "me") {
    const tail = [id, ...rest].filter((s) => s !== undefined).join("/");
    const allowed: Record<string, string[]> = {
      "": ["POST"],
      status: ["GET"],
      pin: ["PUT"],
      unlock: ["POST", "DELETE"],
      recover: ["POST"],
      reset: ["POST"],
      "delete-preview": ["GET"],
    };
    return allowed[tail]?.includes(m) ? { kind: "keyring" } : null;
  }
  void instance;
  return null;
}

/** `true` for the actions the per-IP rate limit counts: everything that changes something. */
export function isCountedWrite(method: string, action: DemoAction): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  // Every PATCH of one resumable upload would exhaust the limit on its own: creation counts.
  return action.kind !== "upload-continue";
}

/** `mime` with its parameters dropped, lowercase. */
export function bareMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function mimeAllowed(mime: string | null | undefined): boolean {
  return DEMO_MIME_TYPES.includes(bareMime(mime));
}
