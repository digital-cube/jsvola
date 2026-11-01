/**
 * The two failures of the crypto layer. Both are mapped to HTTP by the services, never
 * here: `IntegrityError` → `409 vola_integrity` with the FIXED sentence below (a response
 * never carries a reason, a ciphertext or a key), `EncryptionUnavailableError` →
 * `503 encryption_unavailable`.
 */

/** The one sentence every integrity failure answers with. */
export const INTEGRITY_MESSAGE = "The file could not be decrypted.";

/**
 * A blob, a wrapped key or a metadata record did not authenticate: a wrong key, a tampered
 * or truncated ciphertext, a header of a version nobody knows, a blob transplanted onto
 * another file id. `reason` is for the server log only.
 */
export class IntegrityError extends Error {
  constructor(readonly reason: string) {
    super(INTEGRITY_MESSAGE);
    this.name = "IntegrityError";
  }
}

/** The key material a provider needs is not there (the `VOLA_KEY_FILE` is missing or unreadable). */
export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}
