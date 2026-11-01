import { VolaError } from "@vola/client";
import {
  PIN_INVALID_CODE,
  PIN_LENGTH,
  PIN_WRONG_CODE,
  RECOVERY_WRONG_CODE,
  TOO_MANY_ATTEMPTS_CODE,
} from "@vola/core";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useVolaT } from "./i18n.js";
import { useVolaKeyring, type VolaKeyring } from "./useVolaKeyring.js";
import { VolaModal } from "./VolaModal.js";

// --- the PIN input ----------------------------------------------------------------------------

export interface VolaPinInputProps {
  /** Called with the whole PIN once every digit is in. */
  onComplete: (pin: string) => void;
  disabled?: boolean | undefined;
  /** Clears the digits whenever it changes (after a wrong PIN). */
  resetKey?: unknown;
  autoFocus?: boolean | undefined;
  label?: string | undefined;
  length?: number | undefined;
}

/** `PIN_LENGTH` one-digit fields: typing advances, Backspace goes back, a paste fills them all. */
export function VolaPinInput({
  onComplete,
  disabled,
  resetKey,
  autoFocus = true,
  label,
  length = PIN_LENGTH,
}: VolaPinInputProps) {
  const { t } = useVolaT();
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length }, () => ""));
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger.
  useEffect(() => {
    setDigits(Array.from({ length }, () => ""));
    if (autoFocus) inputs.current[0]?.focus();
  }, [resetKey, length]);

  const commit = useCallback(
    (next: string[]) => {
      setDigits(next);
      if (next.every((d) => d !== "")) onComplete(next.join(""));
    },
    [onComplete],
  );

  const setDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = digit;
    commit(next);
    if (digit && index < length - 1) inputs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = [...digits];
      next[index - 1] = "";
      setDigits(next);
      inputs.current[index - 1]?.focus();
    } else if (event.key === "ArrowLeft" && index > 0) {
      inputs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < length - 1) {
      inputs.current[index + 1]?.focus();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").replace(/\D/g, "");
    if (!text) return;
    event.preventDefault();
    const next = Array.from({ length }, (_, i) => text[i] ?? "");
    commit(next);
    inputs.current[Math.min(text.length, length) - 1]?.focus();
  };

  return (
    <fieldset className="vola-pin">
      <legend className="vola-pin__label">{label ?? t("PIN_INPUT")}</legend>
      <div className="vola-pin__digits">
        {digits.map((digit, index) => (
          <input
            // biome-ignore lint/suspicious/noArrayIndexKey: the fields are positional by nature.
            key={index}
            ref={(el) => {
              inputs.current[index] = el;
            }}
            className="vola-pin__digit"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={1}
            value={digit}
            disabled={disabled}
            aria-label={t("PIN_DIGIT", { n: index + 1 })}
            onChange={(event) => setDigit(index, event.target.value)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={onPaste}
            onFocus={(event) => event.target.select()}
          />
        ))}
      </div>
    </fieldset>
  );
}

// --- errors → sentences -----------------------------------------------------------------------

/** A ticking "retry in N s" from an error's `retryAfter` (or a `retry_after` in its details). */
function useRetryCountdown(error: VolaError | null): number {
  const seconds =
    error?.retryAfter ??
    (typeof error?.details.retry_after === "number" ? error.details.retry_after : 0);
  const [left, setLeft] = useState(seconds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new error restarts the countdown.
  useEffect(() => {
    setLeft(seconds);
    if (seconds <= 0) return;
    const timer = setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(timer);
  }, [error, seconds]);
  return left;
}

/** The sentence for an error of the keyring routes; `null` for no error. */
export function keyringErrorMessage(
  t: (term: string, vars?: Record<string, string | number>) => string,
  error: Error | null,
  secondsLeft: number,
): string | null {
  if (!error) return null;
  if (error instanceof VolaError) {
    const attempts = typeof error.details.attempts === "number" ? error.details.attempts : 0;
    switch (error.code) {
      case PIN_WRONG_CODE:
        return secondsLeft > 0
          ? t("PIN_WRONG_WAIT", { attempts, seconds: secondsLeft })
          : t("PIN_WRONG", { attempts });
      case TOO_MANY_ATTEMPTS_CODE:
        return t("PIN_LOCKED_OUT", { seconds: secondsLeft });
      case RECOVERY_WRONG_CODE:
        return t("RECOVERY_WRONG");
      case PIN_INVALID_CODE: {
        const reason = String(error.details.reason ?? "length").toUpperCase();
        return t(`PIN_INVALID_${reason}`);
      }
      default:
        return t("ERROR", { message: error.message });
    }
  }
  return t("ERROR", { message: error.message });
}

/** The sentence and the countdown of the last keyring error. */
function ErrorLine({ error }: { error: Error | null }) {
  const { t } = useVolaT();
  const left = useRetryCountdown(error instanceof VolaError ? error : null);
  const message = keyringErrorMessage(t, error, left);
  if (!message) return null;
  return (
    <p className="vola-error" role="alert">
      {message}
    </p>
  );
}

/** `true` while a lock-out (or a wrong-PIN delay) still runs. */
function blockedBy(error: Error | null, left: number): boolean {
  return (
    error instanceof VolaError &&
    left > 0 &&
    (error.code === TOO_MANY_ATTEMPTS_CODE || error.code === PIN_WRONG_CODE)
  );
}

// --- the screens ------------------------------------------------------------------------------

/** The recovery key, shown once, with the confirmation that it was saved. */
function RecoveryScreen({
  title,
  text,
  recoveryKey,
  onDone,
}: {
  title: string;
  text: string;
  recoveryKey: string;
  onDone: () => void;
}) {
  const { t } = useVolaT();
  const [saved, setSaved] = useState(false);
  const id = useId();
  return (
    <div className="vola-gate__screen" data-screen="recovery">
      <h2 className="vola-gate__title">{title}</h2>
      <p>{text}</p>
      <output className="vola-recovery-key" htmlFor={`${id}-saved`}>
        {recoveryKey}
      </output>
      <label className="vola-check">
        <input
          id={`${id}-saved`}
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        <span>{t("RECOVERY_SAVED")}</span>
      </label>
      <button
        type="button"
        className="vola-btn vola-btn--primary"
        disabled={!saved}
        onClick={onDone}
      >
        {t("CONTINUE")}
      </button>
    </div>
  );
}

function SetupScreen({
  keyring,
  onRecovery,
}: {
  keyring: VolaKeyring;
  onRecovery: (key: string) => void;
}) {
  const { t } = useVolaT();
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const onComplete = async (pin: string) => {
    if (first === null) {
      setFirst(pin);
      setRound((n) => n + 1);
      return;
    }
    if (pin !== first) {
      setError(new Error(t("PIN_MISMATCH")));
      setFirst(null);
      setRound((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await keyring.setup(pin);
      onRecovery(created.recovery_key);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setFirst(null);
      setRound((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vola-gate__screen" data-screen="setup">
      <h2 className="vola-gate__title">
        {first === null ? t("PIN_SETUP_TITLE") : t("PIN_CONFIRM_TITLE")}
      </h2>
      <p>{t("PIN_SETUP_TEXT")}</p>
      <VolaPinInput onComplete={(pin) => void onComplete(pin)} disabled={busy} resetKey={round} />
      {error && !(error instanceof VolaError) ? (
        <p className="vola-error" role="alert">
          {error.message}
        </p>
      ) : (
        <ErrorLine error={error} />
      )}
    </div>
  );
}

function UnlockScreen({
  keyring,
  onForgot,
  onReset,
  title,
}: {
  keyring: VolaKeyring;
  onForgot: () => void;
  onReset: (() => void) | null;
  title: string | undefined;
}) {
  const { t } = useVolaT();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const left = useRetryCountdown(error instanceof VolaError ? error : null);
  const lockedOut = blockedBy(error, left);
  const onComplete = async (pin: string) => {
    setBusy(true);
    try {
      await keyring.unlock(pin);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setRound((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vola-gate__screen" data-screen="unlock">
      <h2 className="vola-gate__title">{title ?? t("PIN_TITLE")}</h2>
      <VolaPinInput
        onComplete={(pin) => void onComplete(pin)}
        disabled={busy || lockedOut}
        resetKey={round}
      />
      {busy ? <p className="vola-muted">{t("UNLOCKING")}</p> : null}
      <ErrorLine error={error} />
      <div className="vola-gate__links">
        <button type="button" className="vola-link" onClick={onForgot}>
          {t("FORGOT_PIN")}
        </button>
        {onReset ? (
          <button type="button" className="vola-link vola-link--danger" onClick={onReset}>
            {t("RESET")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RecoverScreen({
  keyring,
  onRecovered,
  onBack,
}: {
  keyring: VolaKeyring;
  onRecovered: (newKey: string) => void;
  onBack: () => void;
}) {
  const { t } = useVolaT();
  const [key, setKey] = useState("");
  const [pin, setPin] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async () => {
    if (!key.trim() || !pin) return;
    setBusy(true);
    try {
      const recovered = await keyring.recover(key.trim(), pin);
      onRecovered(recovered.recovery_key);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="vola-gate__screen"
      data-screen="recover"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="vola-gate__title">{t("RECOVER_TITLE")}</h2>
      <label className="vola-field" htmlFor={`${id}-key`}>
        <span>{t("RECOVERY_KEY")}</span>
        <input
          id={`${id}-key`}
          className="vola-input"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <VolaPinInput label={t("NEW_PIN")} onComplete={setPin} autoFocus={false} />
      <ErrorLine error={error} />
      <div className="vola-actions">
        <button type="button" className="vola-btn" onClick={onBack}>
          {t("BACK")}
        </button>
        <button
          type="submit"
          className="vola-btn vola-btn--primary"
          disabled={busy || !key.trim() || !pin}
        >
          {t("RECOVER")}
        </button>
      </div>
    </form>
  );
}

/** The "Change PIN" dialog: current PIN, new PIN; every token dies, so the page locks after. */
export function VolaChangePinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useVolaT();
  const keyring = useVolaKeyring();
  const [current, setCurrent] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!current || !next) return;
    setBusy(true);
    try {
      await keyring.changePin(current, next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VolaModal
      open={open}
      title={t("CHANGE_PIN")}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <button type="button" className="vola-btn" onClick={onClose}>
            {t("CANCEL")}
          </button>
          <button
            type="button"
            className="vola-btn vola-btn--primary"
            disabled={busy || !current || !next}
            onClick={() => void submit()}
          >
            {t("SAVE")}
          </button>
        </>
      }
    >
      <VolaPinInput label={t("CURRENT_PIN")} onComplete={setCurrent} />
      <VolaPinInput label={t("NEW_PIN")} onComplete={setNext} autoFocus={false} />
      <ErrorLine error={error} />
    </VolaModal>
  );
}

/** The reset dialog: the counts a reset would shred, the sentence about permanence, and "RESET" typed to confirm. */
export function VolaResetDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: ((files: number) => void) | undefined;
}) {
  const { t } = useVolaT();
  const keyring = useVolaKeyring();
  const [preview, setPreview] = useState<{
    files: number;
    live_files: number;
    bytes: number;
  } | null>(null);
  const [word, setWord] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const store = keyring.store;
  useEffect(() => {
    if (!open) return;
    setWord("");
    setError(null);
    store
      .deletePreview()
      .then((p) => setPreview({ files: p.files, live_files: p.live_files, bytes: p.bytes }))
      .catch(() => setPreview(null));
  }, [open, store]);
  const submit = async () => {
    setBusy(true);
    try {
      const result = await keyring.reset();
      onDone?.(result.files);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VolaModal
      open={open}
      role="alertdialog"
      title={t("RESET_TITLE")}
      description={t("RESET_TEXT")}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <button type="button" className="vola-btn" onClick={onClose}>
            {t("CANCEL")}
          </button>
          <button
            type="button"
            className="vola-btn vola-btn--danger"
            disabled={busy || word !== "RESET"}
            onClick={() => void submit()}
          >
            {t("RESET")}
          </button>
        </>
      }
    >
      {preview ? (
        <p className="vola-muted">
          {t("RESET_PREVIEW", {
            files: preview.files,
            live: preview.live_files,
            bytes: formatBytes(preview.bytes),
          })}
        </p>
      ) : null}
      <label className="vola-field" htmlFor={`${id}-word`}>
        <span>{t("RESET_TYPE")}</span>
        <input
          id={`${id}-word`}
          className="vola-input"
          value={word}
          onChange={(event) => setWord(event.target.value)}
          autoComplete="off"
        />
      </label>
      <ErrorLine error={error} />
    </VolaModal>
  );
}

/** `1234` → `1.2 KB`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

// --- the gate ---------------------------------------------------------------------------------

export interface VolaPinGateProps {
  /** What is shown once unlocked. */
  children?: ReactNode;
  title?: string | undefined;
  /** Offer the PIN setup when the principal has no keyring. Default `true`. */
  allowSetup?: boolean | undefined;
  /** Offer the reset (crypto-shred) on the unlock screen. Default `true`. */
  allowReset?: boolean | undefined;
  /** Show the "locking in N s" banner during the auto-lock countdown. Default `true`. */
  showCountdown?: boolean | undefined;
  /** Rendered while the status is being read. */
  fallback?: ReactNode;
  onUnlocked?: (() => void) | undefined;
}

type Screen =
  | { kind: "auto" }
  | { kind: "recovery"; title: string; text: string; key: string }
  | { kind: "recover" }
  | { kind: "reset" };

/**
 * Shows `children` while the keyring is unlocked; otherwise the PIN screen — setup (with the
 * recovery key shown once and the confirmation it was saved), unlock (wrong PIN with the
 * attempts, lock-out with a `retry_after` countdown), recover, reset with its sentence about
 * permanence — and, during the auto-lock countdown, the "locking in N s" banner with "stay".
 */
export function VolaPinGate({
  children,
  title,
  allowSetup = true,
  allowReset = true,
  showCountdown = true,
  fallback,
  onUnlocked,
}: VolaPinGateProps) {
  const { t } = useVolaT();
  const keyring = useVolaKeyring();
  const [screen, setScreen] = useState<Screen>({ kind: "auto" });
  const [notice, setNotice] = useState<string | null>(null);
  const wasUnlocked = useRef(keyring.unlocked);
  useEffect(() => {
    if (keyring.unlocked && !wasUnlocked.current) {
      onUnlocked?.();
      setNotice(null);
    }
    wasUnlocked.current = keyring.unlocked;
  }, [keyring.unlocked, onUnlocked]);

  if (keyring.unlocked) {
    return (
      <>
        {showCountdown && keyring.lockPhase === "countdown" ? (
          <div className="vola vola-lock-banner" role="status">
            <span>
              {t("LOCK_COUNTDOWN", { seconds: Math.ceil((keyring.lockRemainingMs ?? 0) / 1000) })}
            </span>
            <button type="button" className="vola-btn vola-btn--primary" onClick={keyring.stay}>
              {t("STAY")}
            </button>
          </div>
        ) : null}
        {children}
      </>
    );
  }

  let body: ReactNode;
  if (screen.kind === "recovery") {
    body = (
      <RecoveryScreen
        title={screen.title}
        text={screen.text}
        recoveryKey={screen.key}
        onDone={() => setScreen({ kind: "auto" })}
      />
    );
  } else if (screen.kind === "recover") {
    body = (
      <RecoverScreen
        keyring={keyring}
        onBack={() => setScreen({ kind: "auto" })}
        onRecovered={(key) =>
          setScreen({
            kind: "recovery",
            title: t("NEW_RECOVERY_TITLE"),
            text: t("NEW_RECOVERY_TEXT"),
            key,
          })
        }
      />
    );
  } else if (keyring.hasPin === null) {
    body = keyring.error ? (
      <div className="vola-gate__screen">
        <ErrorLine error={keyring.error} />
        <button type="button" className="vola-btn" onClick={() => void keyring.refresh()}>
          {t("RETRY")}
        </button>
      </div>
    ) : (
      (fallback ?? <p className="vola-muted">{t("LOADING")}</p>)
    );
  } else if (!keyring.hasPin) {
    body = allowSetup ? (
      <SetupScreen
        keyring={keyring}
        onRecovery={(key) =>
          setScreen({ kind: "recovery", title: t("RECOVERY_TITLE"), text: t("RECOVERY_TEXT"), key })
        }
      />
    ) : (
      <p className="vola-muted">{t("LOCKED")}</p>
    );
  } else {
    body = (
      <UnlockScreen
        keyring={keyring}
        title={title}
        onForgot={() => setScreen({ kind: "recover" })}
        onReset={allowReset ? () => setScreen({ kind: "reset" }) : null}
      />
    );
  }

  return (
    <div className="vola vola-gate">
      {notice ? (
        <p className="vola-notice" role="status">
          {notice}
        </p>
      ) : null}
      {body}
      <VolaResetDialog
        open={screen.kind === "reset"}
        onClose={() => setScreen({ kind: "auto" })}
        onDone={(files) => setNotice(t("RESET_DONE", { files }))}
      />
    </div>
  );
}

/** A small status line: locked / unlocked (with the seconds left), lock, change PIN. For a toolbar. */
export function VolaKeyringStatus() {
  const { t } = useVolaT();
  const keyring = useVolaKeyring();
  const [changing, setChanging] = useState(false);
  if (keyring.hasPin === false || keyring.hasPin === null) return null;
  return (
    <span className="vola-keyring-status" data-unlocked={keyring.unlocked}>
      <span className="vola-keyring-status__dot" aria-hidden="true" />
      <span>{keyring.unlocked ? t("UNLOCKED") : t("LOCKED")}</span>
      {keyring.unlocked ? (
        <>
          <button
            type="button"
            className="vola-btn vola-btn--ghost"
            onClick={() => void keyring.lock()}
          >
            {t("LOCK")}
          </button>
          <button
            type="button"
            className="vola-btn vola-btn--ghost"
            onClick={() => setChanging(true)}
          >
            {t("CHANGE_PIN")}
          </button>
          <VolaChangePinDialog open={changing} onClose={() => setChanging(false)} />
        </>
      ) : null}
    </span>
  );
}
