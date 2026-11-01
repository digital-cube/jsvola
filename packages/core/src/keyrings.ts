import { z } from "zod";
import { TimestampSchema } from "./apikey.js";

/**
 * Keyrings (plan 6.2, `docs/CRYPTO.md` § keyring): a principal of the host application
 * (`X-User-Id`) owns ONE keyring per tenant, locked by a PIN. The master key of the keyring
 * wraps the file keys of that principal's `keyring`-encrypted files; the PIN (Argon2id +
 * pepper) and a recovery key each wrap the master key. An unlock is a short-lived token the
 * client sends in `X-Vola-Unlock` — never in a URL.
 */

/** The unlock token travels in this header only (never a query parameter, never a path). */
export const UNLOCK_HEADER = "x-vola-unlock";
/** Seconds an unlock token lives without a request (`VOLA_UNLOCK_TTL_S`); every request that carries it starts the count again. */
export const DEFAULT_UNLOCK_TTL_S = 150;
/** The length of a PIN, in digits — one constant, so a caller who wants more changes one place. */
export const PIN_LENGTH = 6;
/** Bits of a recovery key: 20 random bytes, shown as 8 groups of 4 base32 characters. */
export const RECOVERY_KEY_BYTES = 20;
export const RECOVERY_KEY_GROUPS = 8;
export const RECOVERY_KEY_GROUP_LENGTH = 4;

/** `423`: no usable unlock token for the keyring the request needs — one code, no detail of which part was wrong. */
export const LOCKED_CODE = "vola_locked";
/** `422`: the PIN is not six digits, or is trivial (`reason`: `length` | `digits` | `trivial`). */
export const PIN_INVALID_CODE = "pin_invalid";
/** `403`: a wrong PIN (`attempts`, `retry_after`). */
export const PIN_WRONG_CODE = "pin_wrong";
/** `403`: a wrong recovery key (never counted as a PIN attempt). */
export const RECOVERY_WRONG_CODE = "recovery_wrong";
/** `429`: the keyring is locked out after too many wrong PINs; `Retry-After` says for how long — even for the right PIN. */
export const TOO_MANY_ATTEMPTS_CODE = "too_many_attempts";
/** `409`: the principal already has a keyring. */
export const KEYRING_EXISTS_CODE = "keyring_exists";
/** `404`: the principal has no keyring. */
export const KEYRING_NOT_FOUND_CODE = "keyring_not_found";
/** `400`: a keyring route without `X-User-Id`. */
export const USER_REQUIRED_CODE = "user_required";
/** What `POST …/reset` must carry to go ahead. */
export const RESET_CONFIRMATION = "RESET";

export const PIN_INVALID_REASONS = ["length", "digits", "trivial"] as const;
export type PinInvalidReason = (typeof PIN_INVALID_REASONS)[number];

/** A PIN as a client sends it: a string (digits keep their leading zeros). */
export const PinSchema = z.string().min(1).max(64);

/** `GET /keyrings/me/status`. */
export const KeyringStatusSchema = z.object({
  /** `null` until a keyring exists. */
  keyring_id: z.uuid().nullable(),
  has_pin: z.boolean(),
  /** `true` when the request carried no usable unlock token (or there is no keyring). */
  locked: z.boolean(),
  /** Seconds the token of the request still lives; `null` without a usable one. Reading it does not extend it. */
  unlock_expires_in: z.number().int().nonnegative().nullable(),
  /** When a lock-out ends; `null` when there is none. */
  locked_until: TimestampSchema.nullable(),
  /** Wrong PINs in a row. */
  attempts: z.number().int().nonnegative(),
  pin_set_at: TimestampSchema.nullable(),
});
export type KeyringStatus = z.infer<typeof KeyringStatusSchema>;

/** `POST /keyrings/me` body. */
export const KeyringCreateSchema = z.object({ pin: PinSchema }).strict();
export type KeyringCreate = z.infer<typeof KeyringCreateSchema>;

/** `POST /keyrings/me` → `201`: the recovery key, shown this once. */
export const KeyringCreatedSchema = z.object({
  keyring_id: z.uuid(),
  /** `XXXX-XXXX-…` (8 groups of 4 base32 characters). Nowhere else, ever. */
  recovery_key: z.string(),
});
export type KeyringCreated = z.infer<typeof KeyringCreatedSchema>;

/** `PUT /keyrings/me/pin` body. */
export const PinChangeSchema = z.object({ current_pin: PinSchema, new_pin: PinSchema }).strict();
export type PinChange = z.infer<typeof PinChangeSchema>;

/** `POST /keyrings/me/recover` body. */
export const RecoverSchema = z
  .object({ recovery_key: z.string().min(1).max(128), new_pin: PinSchema })
  .strict();
export type Recover = z.infer<typeof RecoverSchema>;

/** `POST /keyrings/me/recover` → a NEW recovery key (the old one is retired). */
export const RecoveredSchema = z.object({ keyring_id: z.uuid(), recovery_key: z.string() });
export type Recovered = z.infer<typeof RecoveredSchema>;

/** `POST /keyrings/me/unlock` body. */
export const UnlockSchema = z.object({ pin: PinSchema }).strict();

/** `POST /keyrings/me/unlock` → the token for `X-Vola-Unlock` and its initial life in seconds. */
export const UnlockedSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number().int().positive(),
});
export type Unlocked = z.infer<typeof UnlockedSchema>;

/** `POST /keyrings/me/unlock/close` body (the `sendBeacon` alias; `text/plain` with the bare token works too). */
export const UnlockCloseSchema = z.object({ token: z.string().min(1) }).strict();

/** `POST /keyrings/me/reset` body: the caller re-authenticated its user and says so. */
export const KeyringResetSchema = z.object({ confirm: z.literal(RESET_CONFIRMATION) }).strict();

/** `POST /keyrings/me/reset` → what the crypto-shred removed. */
export const KeyringResetResultSchema = z.object({
  keyring_id: z.uuid(),
  /** Rows removed (every version, soft-deleted ones included). */
  files: z.number().int().nonnegative(),
  /** Blobs removed from disk. */
  blobs: z.number().int().nonnegative(),
});
export type KeyringResetResult = z.infer<typeof KeyringResetResultSchema>;

/** `GET /keyrings/me/delete-preview` → the counts a reset would remove, without decrypting anything. */
export const KeyringDeletePreviewSchema = z.object({
  keyring_id: z.uuid(),
  /** Files under the keyring, soft-deleted ones included (they hold a wrapped key too). */
  files: z.number().int().nonnegative(),
  /** Live files only. */
  live_files: z.number().int().nonnegative(),
  /** The sum of their plaintext sizes. */
  bytes: z.number().int().nonnegative(),
});
export type KeyringDeletePreview = z.infer<typeof KeyringDeletePreviewSchema>;

/** `PATCH /folders/…` `{default_keyring: "me" | null}`: the folder's encryption policy. */
export const FOLDER_KEYRING_ME = "me";
