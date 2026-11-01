/**
 * The little the SDK needs to know about where it runs. It targets Node 24+ and browsers
 * alike, through the web APIs they share (`fetch`, `Blob`, `ReadableStream`, `crypto`).
 */

/** `true` in a browser page (a `window` with a `document`); `false` in Node, a worker, a test. */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

/** Bytes → base64 (standard alphabet, padded). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Bytes → base64url (no padding): the form of a share secret in a URL fragment. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64 or base64url → bytes. Throws a `TypeError` on malformed input. */
export function base64ToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("not base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `n` random bytes from the platform's CSPRNG. */
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A random hex string (a multipart boundary, a fingerprint salt). */
export function randomHex(bytes = 16): string {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `encodeURIComponent` of every segment of `a/b/c`, keeping the slashes; leading and trailing slashes dropped. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
