/**
 * Keyrings (plan 6.2, `docs/CRYPTO.md` § keyring) — the Notes service (`service.py`) over
 * `vola_keyring`: setup, unlock, PIN change, recovery, reset, status. The crypto is in
 * `crypto/keyring.ts`, the tokens in `unlock.ts`; this file owns the rows, the brute-force
 * counter and the HTTP mapping of every refusal.
 *
 * Refusals: `400 user_required` (no `X-User-Id`), `404 keyring_not_found`, `409
 * keyring_exists`, `422 pin_invalid` with `reason`, `403 pin_wrong` with `attempts` and
 * `retry_after`, `429 too_many_attempts` with `Retry-After` (the right PIN too), `403
 * recovery_wrong` (never counted), `503 encryption_unavailable` (no Redis, no pepper file, no
 * key file). Logs carry ids and counters — never a PIN, a recovery key, a token or a name.
 */

import { randomBytes } from "node:crypto";
import {
  KEYRING_EXISTS_CODE,
  KEYRING_NOT_FOUND_CODE,
  type KeyringCreated,
  type KeyringDeletePreview,
  type KeyringResetResult,
  type KeyringStatus,
  PIN_INVALID_CODE,
  PIN_WRONG_CODE,
  RECOVERY_WRONG_CODE,
  type Recovered,
  TOO_MANY_ATTEMPTS_CODE,
  type Unlocked,
  USER_REQUIRED_CODE,
} from "@vola/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLog } from "../audit/log.js";
import type { TenantContext } from "../context.js";
import {
  attemptDelayS,
  DEFAULT_KDF_COST,
  deriveKek,
  EncryptionUnavailableError,
  freshKdf,
  hasPinShape,
  IntegrityError,
  isRecoveryKeyShaped,
  type KdfCost,
  type KeyLine,
  type KeySource,
  kdfSalt,
  LOCKOUT_AT,
  mkAad,
  newMasterKey,
  newRecoveryKey,
  normalizeRecoveryKey,
  pinInvalidReason,
  SALT_BYTES,
  unwrapMasterKey,
  wrapMasterKey,
} from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { files, type KeyringRow, keyrings } from "../db/schema.js";
import { uuidv7 } from "../db/uuid.js";
import { VolaError } from "../errors.js";
import { type FileEventBus, publishFileEvents } from "../events/bus.js";
import type { StorageBackend } from "../storage/index.js";
import { encryptionUnavailable } from "./encryption.js";
import type { UnlockPrincipal, UnlockStore } from "./unlock.js";

export interface KeyringsDeps {
  db: Database;
  /** The token store; `null` (no Redis) makes every keyring route `503`. */
  unlocks: UnlockStore | null;
  /** `VOLA_PEPPER_FILE`: the Argon2 `secret` lines, the first active. */
  peppers: KeySource;
  /** The blob store a reset removes the files from. */
  storage: StorageBackend;
  /** The Argon2 cost of NEW wraps (tests lower it); default 64 MiB / 3 / 1. */
  kdfCost?: KdfCost | undefined;
  events?: FileEventBus | undefined;
  audit?: AuditLog | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

/** The `X-User-Id` of the request, or `400 user_required`. */
export function requirePrincipal(context: Pick<TenantContext, "userId">): string {
  if (!context.userId) {
    throw new VolaError(
      USER_REQUIRED_CODE,
      400,
      "a keyring belongs to a principal: send X-User-Id",
    );
  }
  return context.userId;
}

export function keyringNotFound(): VolaError {
  return new VolaError(KEYRING_NOT_FOUND_CODE, 404, "this principal has no keyring");
}

/** `422 pin_invalid` with `reason`; `null` when `pin` is acceptable. */
export function assertPinAcceptable(pin: unknown): string {
  const reason = pinInvalidReason(typeof pin === "string" ? pin : "");
  if (reason) {
    throw new VolaError(PIN_INVALID_CODE, 422, pinMessage(reason), { reason });
  }
  return pin as string;
}

function pinMessage(reason: string): string {
  switch (reason) {
    case "length":
      return "the PIN must be exactly 6 digits";
    case "digits":
      return "the PIN must be digits only";
    default:
      return "the PIN is too easy: not all the same digit and not a run";
  }
}

/** Only the shape: what an unlock requires of the PIN typed (it is compared, not judged). */
function assertPinShape(pin: unknown): string {
  if (!hasPinShape(pin)) {
    throw new VolaError(PIN_INVALID_CODE, 422, "the PIN must be exactly 6 digits", {
      reason: typeof pin === "string" && pin.length === 6 ? "digits" : "length",
    });
  }
  return pin;
}

const clock = (deps: KeyringsDeps) => (deps.now ?? (() => new Date()))();

/** The store, or `503` when there is none. */
function unlocksOf(deps: KeyringsDeps): UnlockStore {
  if (!deps.unlocks) throw encryptionUnavailable("keyring");
  return deps.unlocks;
}

/** The pepper lines, or `503` when the file cannot be read. */
async function peppersOf(deps: KeyringsDeps): Promise<KeyLine[]> {
  try {
    return await deps.peppers.lines();
  } catch (error) {
    throw translate(deps, error);
  }
}

function translate(deps: KeyringsDeps, error: unknown): unknown {
  if (error instanceof EncryptionUnavailableError) {
    deps.logger?.warn({ reason: error.message }, "keyring provider unavailable");
    return encryptionUnavailable("keyring");
  }
  return error;
}

// --- lookup ------------------------------------------------------------------------------

/** The live keyring of `who`, or `null`. */
export async function findKeyring(
  deps: Pick<KeyringsDeps, "db">,
  who: UnlockPrincipal,
): Promise<KeyringRow | null> {
  const [row] = await deps.db
    .select()
    .from(keyrings)
    .where(
      and(
        eq(keyrings.tenantId, who.tenantId),
        eq(keyrings.principal, who.principal),
        isNull(keyrings.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function requireKeyring(deps: KeyringsDeps, who: UnlockPrincipal): Promise<KeyringRow> {
  const row = await findKeyring(deps, who);
  if (!row) throw keyringNotFound();
  return row;
}

/** The live keyring `keyringId` of the tenant, or `null` (the folder policy checks it). */
export async function findKeyringById(
  deps: Pick<KeyringsDeps, "db">,
  tenantId: string,
  keyringId: string,
): Promise<KeyringRow | null> {
  const [row] = await deps.db
    .select()
    .from(keyrings)
    .where(
      and(eq(keyrings.tenantId, tenantId), eq(keyrings.id, keyringId), isNull(keyrings.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

// --- status ------------------------------------------------------------------------------

/**
 * `{has_pin, locked, unlock_expires_in, locked_until, …}` for `who` with the request's
 * `token`: reads the remaining life of the token WITHOUT sliding it, so a "still open?"
 * poll does not keep the keyring open. `503` without Redis.
 */
export async function keyringStatus(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
  token: string | null,
): Promise<KeyringStatus> {
  const unlocks = unlocksOf(deps);
  const row = await findKeyring(deps, who);
  const now = clock(deps);
  let expiresIn: number | null = null;
  if (row && token) {
    try {
      expiresIn = await unlocks.expiresIn(token, who);
    } catch (error) {
      throw translate(deps, error);
    }
  }
  const lockedUntil = row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
  return {
    keyring_id: row?.id ?? null,
    has_pin: row !== null,
    locked: expiresIn === null,
    unlock_expires_in: expiresIn,
    locked_until: lockedUntil?.toISOString() ?? null,
    attempts: row?.attempts ?? 0,
    pin_set_at: row?.pinSetAt.toISOString() ?? null,
  };
}

// --- setup -------------------------------------------------------------------------------

/** PostgreSQL error code of a unique violation. */
const UNIQUE_VIOLATION = "23505";
const pgCode = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code ??
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** The two wraps of a master key for a NEW PIN and a NEW recovery key. */
async function wrapBoth(
  deps: KeyringsDeps,
  keyringId: string,
  mk: Buffer,
  pin: string,
  pepper: KeyLine,
): Promise<{
  kdf: KeyringRow["kdf"];
  mkPinCt: Buffer;
  mkRecoveryCt: Buffer;
  recoverySalt: Buffer;
  recoveryKey: string;
}> {
  const pinWrap = await wrapPin(deps, keyringId, mk, pin, pepper);
  const recovery = await wrapRecovery(keyringId, mk, pepper, pinWrap.kdf);
  return { ...pinWrap, ...recovery };
}

/** `mk_pin_ct` + a fresh `kdf` (new salt) for `pin` under `pepper`. */
async function wrapPin(
  deps: KeyringsDeps,
  keyringId: string,
  mk: Buffer,
  pin: string,
  pepper: KeyLine,
): Promise<{ kdf: KeyringRow["kdf"]; mkPinCt: Buffer }> {
  const kdf = freshKdf(pepper, deps.kdfCost ?? DEFAULT_KDF_COST);
  const kek = await deriveKek(pin, kdfSalt(kdf), pepper.key, kdf);
  try {
    return { kdf, mkPinCt: wrapMasterKey(kek, mk, mkAad(keyringId, "pin")) };
  } finally {
    kek.fill(0);
  }
}

/** A NEW recovery key, its own salt and `mk_recovery_ct` (same cost as `kdf`). */
async function wrapRecovery(
  keyringId: string,
  mk: Buffer,
  pepper: KeyLine,
  kdf: KeyringRow["kdf"],
): Promise<{ mkRecoveryCt: Buffer; recoverySalt: Buffer; recoveryKey: string }> {
  const recoveryKey = newRecoveryKey();
  const recoverySalt = freshSalt();
  const kek = await deriveKek(normalizeRecoveryKey(recoveryKey), recoverySalt, pepper.key, kdf);
  try {
    return {
      recoveryKey,
      recoverySalt,
      mkRecoveryCt: wrapMasterKey(kek, mk, mkAad(keyringId, "recovery")),
    };
  } finally {
    kek.fill(0);
  }
}

function freshSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * `POST /keyrings/me {pin}`: a new master key, a new recovery key, both wraps, the row.
 * `409 keyring_exists` when the principal has one (a concurrent setup too, through the
 * partial unique index). The recovery key is returned once and kept nowhere.
 */
export async function createKeyring(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
  pin: unknown,
): Promise<KeyringCreated> {
  unlocksOf(deps);
  const accepted = assertPinAcceptable(pin);
  if (await findKeyring(deps, who)) {
    throw new VolaError(KEYRING_EXISTS_CODE, 409, "this principal already has a keyring");
  }
  const [pepper] = await peppersOf(deps);
  if (!pepper) throw encryptionUnavailable("keyring");
  const id = uuidv7();
  const mk = newMasterKey();
  try {
    const wraps = await wrapBoth(deps, id, mk, accepted, pepper);
    const now = clock(deps);
    try {
      await deps.db.insert(keyrings).values({
        id,
        tenantId: who.tenantId,
        principal: who.principal,
        kdf: wraps.kdf,
        mkPinCt: wraps.mkPinCt,
        mkRecoveryCt: wraps.mkRecoveryCt,
        recoverySalt: wraps.recoverySalt,
        attempts: 0,
        lockedUntil: null,
        pinSetAt: now,
        createdAt: now,
      });
    } catch (error) {
      if (pgCode(error) === UNIQUE_VIOLATION) {
        throw new VolaError(KEYRING_EXISTS_CODE, 409, "this principal already has a keyring");
      }
      throw error;
    }
    deps.logger?.info({ keyring: id }, "keyring created");
    deps.audit?.emit({
      event_type: "VOLA_KEYRING_CREATED",
      instance_type: "vola_keyring",
      instance_id: id,
      payload: { keyring_id: id, kdf: { m: wraps.kdf.m, t: wraps.kdf.t, p: wraps.kdf.p } },
    });
    return { keyring_id: id, recovery_key: wraps.recoveryKey };
  } finally {
    mk.fill(0);
  }
}

// --- the PIN check (brute force) ---------------------------------------------------------

/** What a right PIN yields: the master key (zero it when done) and the keyring as it is now. */
interface Opened {
  mk: Buffer;
  row: KeyringRow;
}

function tooManyAttempts(retryAfterS: number, lockedUntil: Date | null): VolaError {
  return new VolaError(
    TOO_MANY_ATTEMPTS_CODE,
    429,
    `too many wrong PINs: try again in ${retryAfterS} s`,
    { retry_after: retryAfterS, locked_until: lockedUntil?.toISOString() ?? null },
  );
}

/**
 * The Notes `_check_pin`: one attempt per principal at a time (Redis `SET NX`, 15 s;
 * another one in flight is `429` for 1 s), a lock-out in force is `429` with `Retry-After`
 * whatever the PIN, then the wrap is tried under every pepper line (the hinted one first).
 * Wrong: `attempts + 1`, `locked_until = now + attemptDelayS(attempts)`, `403 pin_wrong`
 * with `attempts` and `retry_after`; from the tenth, `vola_locked_out` and an audit event.
 * Right: the counter is cleared and, when an older pepper line opened it, the PIN wrap is
 * re-made under the active line.
 */
async function checkPin(deps: KeyringsDeps, who: UnlockPrincipal, pin: unknown): Promise<Opened> {
  const unlocks = unlocksOf(deps);
  const typed = assertPinShape(pin);
  let held: boolean;
  try {
    held = await unlocks.acquireAttemptLock(who);
  } catch (error) {
    throw translate(deps, error);
  }
  if (!held) throw tooManyAttempts(1, null);
  try {
    const row = await requireKeyring(deps, who);
    const now = clock(deps);
    if (row.lockedUntil && row.lockedUntil > now) {
      throw tooManyAttempts(retryAfter(row.lockedUntil, now), row.lockedUntil);
    }
    const peppers = await peppersOf(deps);
    const opened = await tryUnwrap(
      typed,
      kdfSalt(row.kdf),
      row.kdf,
      row.mkPinCt,
      mkAad(row.id, "pin"),
      orderedPeppers(peppers, row.kdf.pepper_line),
    );
    if (!opened) {
      const attempts = row.attempts + 1;
      const delay = attemptDelayS(attempts);
      const lockedUntil = delay > 0 ? new Date(now.getTime() + delay * 1000) : null;
      await deps.db.update(keyrings).set({ attempts, lockedUntil }).where(eq(keyrings.id, row.id));
      deps.logger?.warn({ keyring: row.id, attempts, retry_after: delay }, "vola_unlock_failed");
      if (attempts >= LOCKOUT_AT) {
        deps.logger?.warn({ keyring: row.id, attempts, retry_after: delay }, "vola_locked_out");
        deps.audit?.emit({
          event_type: "VOLA_KEYRING_LOCKED_OUT",
          instance_type: "vola_keyring",
          instance_id: row.id,
          payload: { keyring_id: row.id, attempts, retry_after: delay },
        });
      }
      throw new VolaError(PIN_WRONG_CODE, 403, "wrong PIN", { attempts, retry_after: delay });
    }
    let current = row;
    const changed: Partial<typeof keyrings.$inferInsert> = {};
    if (row.attempts !== 0 || row.lockedUntil !== null) {
      changed.attempts = 0;
      changed.lockedUntil = null;
    }
    if (opened.line.index !== 0) {
      // Lazy pepper rotation: the active line takes over this keyring now.
      const active = peppers[0] as KeyLine;
      const rewrap = await wrapPin(deps, row.id, opened.mk, typed, active);
      changed.kdf = rewrap.kdf;
      changed.mkPinCt = rewrap.mkPinCt;
      deps.logger?.info({ keyring: row.id }, "keyring PIN wrap moved to the active pepper line");
    }
    if (Object.keys(changed).length > 0) {
      const [updated] = await deps.db
        .update(keyrings)
        .set(changed)
        .where(eq(keyrings.id, row.id))
        .returning();
      if (updated) current = updated;
    }
    return { mk: opened.mk, row: current };
  } finally {
    await unlocks.releaseAttemptLock(who).catch(() => undefined);
  }
}

/** Seconds until `until`, at least 1. */
function retryAfter(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/** The hinted line first, then every other one (a hint is tried first, never trusted). */
function orderedPeppers(lines: KeyLine[], hint: string | undefined): KeyLine[] {
  return [
    ...lines.filter((l) => l.kid.toString("hex") === hint),
    ...lines.filter((l) => l.kid.toString("hex") !== hint),
  ];
}

/** `mk` and the line that opened it; `null` when no line does (a wrong secret). */
async function tryUnwrap(
  secret: string,
  salt: Buffer,
  cost: KdfCost,
  ct: Buffer,
  aad: Buffer,
  lines: KeyLine[],
): Promise<{ mk: Buffer; line: KeyLine } | null> {
  for (const line of lines) {
    const kek = await deriveKek(secret, salt, line.key, cost);
    try {
      return { mk: unwrapMasterKey(kek, ct, aad), line };
    } catch (error) {
      if (!(error instanceof IntegrityError)) throw error;
    } finally {
      kek.fill(0);
    }
  }
  return null;
}

// --- unlock / lock -----------------------------------------------------------------------

/** `POST /keyrings/me/unlock {pin}` → `{token, expires_in}`. */
export async function unlockKeyring(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
  pin: unknown,
): Promise<Unlocked> {
  const unlocks = unlocksOf(deps);
  const { mk, row } = await checkPin(deps, who, pin);
  try {
    const opened = await unlocks.open({ ...who, keyringId: row.id, mk });
    return { token: opened.token, expires_in: opened.expiresIn };
  } catch (error) {
    throw translate(deps, error);
  } finally {
    mk.fill(0);
  }
}

/** `DELETE /keyrings/me/unlock` and the beacon alias: forgets the token; idempotent. */
export async function lockKeyring(deps: KeyringsDeps, token: string | null): Promise<void> {
  const unlocks = unlocksOf(deps);
  try {
    await unlocks.drop(token);
  } catch (error) {
    throw translate(deps, error);
  }
}

async function dropAll(deps: KeyringsDeps, who: UnlockPrincipal): Promise<void> {
  try {
    await unlocksOf(deps).dropAll(who);
  } catch (error) {
    throw translate(deps, error);
  }
}

// --- PIN change --------------------------------------------------------------------------

/**
 * `PUT /keyrings/me/pin {current_pin, new_pin}`: the master key is re-wrapped under the new
 * PIN (fresh salt); no file is touched (`fk_ct` stays as it was); every live token of the
 * principal is dropped. The current PIN is checked like an unlock (attempts count).
 */
export async function changePin(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
  input: { current_pin: unknown; new_pin: unknown },
): Promise<void> {
  unlocksOf(deps);
  const newPin = assertPinAcceptable(input.new_pin);
  const { mk, row } = await checkPin(deps, who, input.current_pin);
  try {
    const [pepper] = await peppersOf(deps);
    if (!pepper) throw encryptionUnavailable("keyring");
    const rewrap = await wrapPin(deps, row.id, mk, newPin, pepper);
    await deps.db
      .update(keyrings)
      .set({ kdf: rewrap.kdf, mkPinCt: rewrap.mkPinCt, pinSetAt: clock(deps) })
      .where(eq(keyrings.id, row.id));
  } finally {
    mk.fill(0);
  }
  await dropAll(deps, who);
  deps.logger?.info({ keyring: row.id }, "keyring PIN changed");
  deps.audit?.emit({
    event_type: "VOLA_KEYRING_PIN_CHANGED",
    instance_type: "vola_keyring",
    instance_id: row.id,
    payload: { keyring_id: row.id },
  });
}

// --- recovery ----------------------------------------------------------------------------

/**
 * `POST /keyrings/me/recover {recovery_key, new_pin}`: the recovery key (normalised) opens
 * the master key under its own salt; a wrong one is `403 recovery_wrong` and does NOT count
 * as a PIN attempt (160 bits are not guessable, and counting would let PIN guessing lock
 * the owner out of recovery too). Success re-wraps under the new PIN, issues a NEW recovery
 * key (the old one has been typed somewhere), clears the counter and drops every token.
 */
export async function recoverKeyring(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
  input: { recovery_key: unknown; new_pin: unknown },
): Promise<Recovered> {
  unlocksOf(deps);
  const newPin = assertPinAcceptable(input.new_pin);
  const typed = normalizeRecoveryKey(
    typeof input.recovery_key === "string" ? input.recovery_key : "",
  );
  const row = await requireKeyring(deps, who);
  const wrong = () => {
    deps.logger?.warn({ keyring: row.id }, "vola_recovery_failed");
    return new VolaError(RECOVERY_WRONG_CODE, 403, "wrong recovery key");
  };
  if (!isRecoveryKeyShaped(typed)) throw wrong();
  const peppers = await peppersOf(deps);
  const opened = await tryUnwrap(
    typed,
    row.recoverySalt,
    row.kdf,
    row.mkRecoveryCt,
    mkAad(row.id, "recovery"),
    orderedPeppers(peppers, row.kdf.pepper_line),
  );
  if (!opened) throw wrong();
  try {
    const active = peppers[0] as KeyLine;
    const pinWrap = await wrapPin(deps, row.id, opened.mk, newPin, active);
    const recovery = await wrapRecovery(row.id, opened.mk, active, pinWrap.kdf);
    await deps.db
      .update(keyrings)
      .set({
        kdf: pinWrap.kdf,
        mkPinCt: pinWrap.mkPinCt,
        mkRecoveryCt: recovery.mkRecoveryCt,
        recoverySalt: recovery.recoverySalt,
        attempts: 0,
        lockedUntil: null,
        pinSetAt: clock(deps),
      })
      .where(eq(keyrings.id, row.id));
    await dropAll(deps, who);
    deps.logger?.info({ keyring: row.id }, "keyring recovered");
    deps.audit?.emit({
      event_type: "VOLA_KEYRING_RECOVERED",
      instance_type: "vola_keyring",
      instance_id: row.id,
      payload: { keyring_id: row.id },
    });
    return { keyring_id: row.id, recovery_key: recovery.recoveryKey };
  } finally {
    opened.mk.fill(0);
  }
}

// --- reset (crypto-shred) ----------------------------------------------------------------

/** `GET /keyrings/me/delete-preview`: the counts a reset would remove, from the rows alone. */
export async function keyringDeletePreview(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
): Promise<KeyringDeletePreview> {
  const row = await requireKeyring(deps, who);
  return { keyring_id: row.id, ...(await countFiles(deps, row.id)) };
}

async function countFiles(
  deps: KeyringsDeps,
  keyringId: string,
): Promise<{ files: number; live_files: number; bytes: number }> {
  const [counts] = await deps.db
    .select({
      files: sql<number>`count(*)`,
      live: sql<number>`count(*) filter (where ${files.deletedAt} is null)`,
      bytes: sql<number>`coalesce(sum(${files.size}), 0)`,
    })
    .from(files)
    .where(eq(files.keyringId, keyringId));
  return {
    files: Number(counts?.files ?? 0),
    live_files: Number(counts?.live ?? 0),
    bytes: Number(counts?.bytes ?? 0),
  };
}

/**
 * `POST /keyrings/me/reset {confirm: "RESET"}` — the crypto-shred: every file under the
 * keyring (every version, soft-deleted rows included: they hold a wrapped key too) goes,
 * STORAGE FIRST, then the rows, then the keyring itself (soft-deleted, so a new setup can
 * follow) and every token. Re-authenticating the person is the caller's job (the scope and
 * the confirmation say it did). A blob that cannot be removed keeps its row (nothing is left
 * on disk without a trace) and the call ends in `500 blob_not_removed` after the others.
 */
export async function resetKeyring(
  deps: KeyringsDeps,
  who: UnlockPrincipal,
): Promise<KeyringResetResult> {
  unlocksOf(deps);
  const row = await requireKeyring(deps, who);
  const rows = await deps.db.select().from(files).where(eq(files.keyringId, row.id));
  let blobs = 0;
  let removedRows = 0;
  const failed: string[] = [];
  const byInstance = new Map<
    string,
    {
      scope: { tenantId: string; instanceType: string; instanceId: string };
      rows: { id: string; folderId: string | null }[];
    }
  >();
  for (const file of rows) {
    try {
      // Under the lock uploads commit under; an encrypted blob is never shared (random key
      // and nonce), the check is for the one row of another file that could still cite it.
      const removed = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${file.hash}, 0))`);
        const [other] = await tx
          .select({ id: files.id })
          .from(files)
          .where(and(eq(files.hash, file.hash), sql`${files.id} <> ${file.id}`))
          .limit(1);
        const gone = other ? false : await deps.storage.remove(file.hash);
        await tx.delete(files).where(eq(files.id, file.id));
        return gone;
      });
      if (removed) blobs++;
      removedRows++;
      const key = `${file.instanceType}/${file.instanceId}`;
      const group = byInstance.get(key) ?? {
        scope: {
          tenantId: file.tenantId,
          instanceType: file.instanceType,
          instanceId: file.instanceId,
        },
        rows: [],
      };
      group.rows.push({ id: file.id, folderId: file.folderId });
      byInstance.set(key, group);
    } catch (error) {
      deps.logger?.error(
        { err: error, file: file.id, keyring: row.id },
        "file not removed in reset",
      );
      failed.push(file.id);
    }
  }
  for (const group of byInstance.values()) {
    await publishFileEvents(deps, { ...group.scope, kind: "purged" }, group.rows);
  }
  if (failed.length > 0) {
    throw new VolaError(
      "blob_not_removed",
      500,
      `${failed.length} file(s) of the keyring could not be removed; the keyring stays`,
      { files: removedRows, blobs, failed: failed.length },
    );
  }
  await deps.db
    .update(keyrings)
    .set({ deletedAt: clock(deps) })
    .where(and(eq(keyrings.id, row.id), isNull(keyrings.deletedAt)));
  await dropAll(deps, who);
  deps.logger?.info({ keyring: row.id, files: removedRows, blobs }, "keyring reset");
  deps.audit?.emit({
    event_type: "VOLA_KEYRING_RESET",
    instance_type: "vola_keyring",
    instance_id: row.id,
    payload: { keyring_id: row.id, files: removedRows, blobs },
  });
  return { keyring_id: row.id, files: removedRows, blobs };
}

// --- pepper-status -----------------------------------------------------------------------

/** What `pepper-status` reports: how many keyrings' PIN wraps depend on which pepper line. */
export interface PepperUsage {
  /** The line (0 = active), or `null` for a hint no line of the file has (a removed pepper!). */
  line: number | null;
  kid: string;
  keyrings: number;
}

/**
 * Counts live keyrings by the `pepper_line` hint of their `kdf` and maps each to a line of
 * `lines`. A hint without a line means keyrings nobody can unlock any more (the recovery
 * wrap depends on the same pepper) — what an operator must see before deleting a line.
 */
export async function keyringPepperUsage(
  db: Database,
  lines: readonly KeyLine[],
): Promise<PepperUsage[]> {
  const rows = await db
    .select({
      kid: sql<string>`coalesce(${keyrings.kdf} ->> 'pepper_line', '')`,
      n: sql<number>`count(*)`,
    })
    .from(keyrings)
    .where(isNull(keyrings.deletedAt))
    .groupBy(sql`1`);
  const byKid = new Map(lines.map((l) => [l.kid.toString("hex"), l.index]));
  return rows
    .map((row) => ({ line: byKid.get(row.kid) ?? null, kid: row.kid, keyrings: Number(row.n) }))
    .sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9) || a.kid.localeCompare(b.kid));
}
