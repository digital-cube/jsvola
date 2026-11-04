import { type VolaClient, type VolaError, VolaLockedError } from "@vol-a/client";
import type {
  KeyringCreated,
  KeyringDeletePreview,
  KeyringResetResult,
  KeyringStatus,
  Recovered,
  Unlocked,
} from "@vol-a/core";
import type { BlobCache } from "./blobs.js";
import type { LockPhase } from "./lockPolicy.js";

/** What `useVolaKeyring()` sees. */
export interface KeyringState {
  /** `GET /keyrings/me/status` as last read; `null` before the first answer. */
  status: KeyringStatus | null;
  /** A status read is in flight. */
  loading: boolean;
  /** The last status read failed (no `X-User-Id`, no `keyrings` scope, network). */
  error: VolaError | Error | null;
  /** `true` while this page holds a live unlock token. */
  unlocked: boolean;
  /** The principal has a keyring (`status.has_pin`); `null` until known. */
  hasPin: boolean | null;
  /** The auto-lock phase: `live`, `countdown` (a lock is seconds away) or `locked`. */
  lockPhase: LockPhase;
  /** Milliseconds until the auto-lock, during the countdown. */
  lockRemainingMs: number | null;
}

/**
 * The keyring of the provider's `userId`, shared by every component under one
 * `VolaProvider`: the status, the unlock the client holds, the auto-lock phase, and every
 * operation. The unlock token lives in the `VolaClient` (memory), never in storage; a lock
 * — explicit, automatic, on `pagehide`, or a `423` from the server — revokes every `blob:`
 * URL of the `BlobCache` and starts a new generation before anything else.
 */
export class KeyringStore {
  private state: KeyringState = {
    status: null,
    loading: false,
    error: null,
    unlocked: false,
    hasPin: null,
    lockPhase: "locked",
    lockRemainingMs: null,
  };
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<KeyringStatus | null> | null = null;
  /** When the person last did something (`touch()`); what the auto-lock measures idleness from. */
  lastActivityAt: number = Date.now();

  constructor(
    readonly client: VolaClient,
    readonly blobs: BlobCache,
  ) {
    if (client.unlocked) this.state = { ...this.state, unlocked: true, lockPhase: "live" };
  }

  getSnapshot = (): KeyringState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<KeyringState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** `GET /keyrings/me/status` (does not extend the token). One read at a time. */
  refresh(): Promise<KeyringStatus | null> {
    if (this.inflight) return this.inflight;
    this.set({ loading: true });
    this.inflight = this.client.keyrings
      .status()
      .then((status) => {
        const wasUnlocked = this.state.unlocked;
        const unlocked = wasUnlocked && !status.locked;
        // The token died on the server (its TTL ran out): nothing decrypted may stay on the page.
        if (wasUnlocked && !unlocked) this.markLocked();
        this.set({ status, hasPin: status.has_pin, loading: false, error: null });
        return status;
      })
      .catch((error: unknown) => {
        this.set({
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** `POST /keyrings/me {pin}`: the recovery key comes back this once. The keyring starts locked. */
  async setup(pin: string): Promise<KeyringCreated> {
    const created = await this.client.keyrings.setup(pin);
    this.set({ hasPin: true, error: null });
    void this.refresh();
    return created;
  }

  /** `POST /keyrings/me/unlock {pin}`: the client keeps the token; the page is `live`. */
  async unlock(pin: string): Promise<Unlocked> {
    const unlocked = await this.client.keyrings.unlock(pin);
    this.lastActivityAt = Date.now();
    this.set({ unlocked: true, lockPhase: "live", lockRemainingMs: null, error: null });
    void this.refresh();
    return unlocked;
  }

  /**
   * Locks: every `blob:` URL is revoked and the generation bumped FIRST (synchronously —
   * nothing decrypted stays on the page), then the server is told to end the token. Idempotent.
   */
  lock(): Promise<void> {
    const ending = this.client.lock().catch(() => undefined);
    this.markLocked();
    return ending;
  }

  /**
   * The local side of a lock (a `423` from the server, `pagehide`): forget everything, keep no
   * token. A `423` while already locked is nothing new (nothing decrypted could have been
   * fetched since), so it does not start another generation — a locked thumbnail asking again
   * would otherwise never settle.
   */
  markLocked(): void {
    if (!this.state.unlocked && !this.client.unlocked && this.state.lockPhase === "locked") return;
    this.client.setUnlock(null);
    this.blobs.forget();
    this.set({ unlocked: false, lockPhase: "locked", lockRemainingMs: null });
  }

  /** Activity: the idle clock starts again, and a running countdown is cancelled (`live`). */
  touch(now: number = Date.now()): void {
    this.lastActivityAt = now;
    if (this.state.lockPhase === "countdown") this.setLockPhase("live", null);
  }

  /** The auto-lock reports where it stands; `locked` goes through `lock()`. */
  setLockPhase(phase: Exclude<LockPhase, "locked">, remainingMs: number | null): void {
    if (!this.state.unlocked) return;
    if (this.state.lockPhase === phase && this.state.lockRemainingMs === remainingMs) return;
    this.set({ lockPhase: phase, lockRemainingMs: remainingMs });
  }

  /** `PUT /keyrings/me/pin`: every token of the principal dies, so the page is locked afterwards. */
  async changePin(currentPin: string, newPin: string): Promise<void> {
    await this.client.keyrings.changePin(currentPin, newPin);
    this.markLocked();
    void this.refresh();
  }

  /** `POST /keyrings/me/recover`: a new PIN and a NEW recovery key; locked afterwards. */
  async recover(recoveryKey: string, newPin: string): Promise<Recovered> {
    const recovered = await this.client.keyrings.recover(recoveryKey, newPin);
    this.markLocked();
    void this.refresh();
    return recovered;
  }

  /** `GET /keyrings/me/delete-preview`: what a reset would shred. */
  deletePreview(): Promise<KeyringDeletePreview> {
    return this.client.keyrings.deletePreview();
  }

  /** `POST /keyrings/me/reset`: the crypto-shred. The keyring is gone; `hasPin` is `false`. */
  async reset(): Promise<KeyringResetResult> {
    const result = await this.client.keyrings.reset();
    this.markLocked();
    this.set({ hasPin: false, status: null });
    void this.refresh();
    return result;
  }

  /** `true` for the `423` that means "lock now": marks the page locked and says so. */
  handleError(error: unknown): boolean {
    if (error instanceof VolaLockedError) {
      this.markLocked();
      return true;
    }
    return false;
  }
}
