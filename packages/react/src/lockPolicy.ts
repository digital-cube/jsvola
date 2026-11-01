/**
 * The client-side lock policy of `docs/notes-crypto-for-vola.md` § 3 („Zaključavanje na
 * klijentu“): `idleMs` without a pointer, key, touch or scroll → a `countdownMs` countdown →
 * lock. Activity during the countdown goes back to `live`. A tab that slept through the
 * whole countdown locks at once. Pure, so it is testable without timers.
 */
export type LockPhase = "live" | "countdown" | "locked";

export interface LockPolicy {
  /** Milliseconds of inactivity before the countdown starts. Default 120 s. */
  idleMs: number;
  /** The countdown's length. Default 10 s. */
  countdownMs: number;
}

export const DEFAULT_LOCK_POLICY: LockPolicy = { idleMs: 120_000, countdownMs: 10_000 };

export interface LockDecision {
  phase: LockPhase;
  /** Milliseconds until the lock, during the countdown; `0` once locked, `null` while live. */
  remainingMs: number | null;
}

/** The phase for `idleMs` milliseconds since the last activity. */
export function decideLock(idle: number, policy: LockPolicy = DEFAULT_LOCK_POLICY): LockDecision {
  const lockAt = policy.idleMs + policy.countdownMs;
  if (idle >= lockAt) return { phase: "locked", remainingMs: 0 };
  if (idle >= policy.idleMs) return { phase: "countdown", remainingMs: lockAt - idle };
  return { phase: "live", remainingMs: null };
}

/** The DOM events that count as activity. */
export const ACTIVITY_EVENTS: readonly (keyof WindowEventMap)[] = [
  "pointerdown",
  "pointermove",
  "keydown",
  "touchstart",
  "wheel",
  "scroll",
];
