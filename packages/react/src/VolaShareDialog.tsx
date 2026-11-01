import type { ShareCreated, ShareInfo } from "@vola/core";
import { useCallback, useEffect, useId, useState } from "react";
import { useVolaContext } from "./context.js";
import { useVolaT } from "./i18n.js";
import { VolaModal } from "./VolaModal.js";

/** What the dialog needs of a file. */
export interface ShareFile {
  id: string;
  filename?: string | null | undefined;
  encryption?: string | null | undefined;
}

export interface VolaShareDialogProps {
  file: ShareFile;
  open: boolean;
  onClose: () => void;
  /** Called with every link made. */
  onCreated?: ((share: ShareCreated) => void) | undefined;
}

/** `datetime-local`'s value → ISO 8601 (UTC), or `undefined` for an empty field. */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Share links of one file: make one (password, expiry, most downloads), copy it, see the
 * existing ones and revoke them. For an encrypted file the dialog says what the link means:
 * the recipient gets plaintext, and the secret after `#` is in the link alone — the server
 * answers it once and keeps nothing of it.
 */
export function VolaShareDialog({ file, open, onClose, onCreated }: VolaShareDialogProps) {
  const { client, keyring } = useVolaContext();
  const { t, intlLocale } = useVolaT();
  const id = useId();
  const encrypted =
    file.encryption !== undefined && file.encryption !== null && file.encryption !== "none";
  const [password, setPassword] = useState("");
  const [expires, setExpires] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ShareCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<ShareInfo[] | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await client.shares.list({ fileId: file.id });
      setShares(list.shares.filter((share) => share.revoked_at === null));
    } catch (e) {
      keyring.handleError(e);
      setShares([]);
    }
  }, [client, file.id, keyring]);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setCopied(false);
    setError(null);
    void load();
  }, [open, load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const max = maxDownloads.trim() === "" ? undefined : Number(maxDownloads);
      const share = await client.shares.create({
        file_id: file.id,
        ...(password ? { password } : {}),
        ...(localToIso(expires) ? { expires_at: localToIso(expires) } : {}),
        ...(max !== undefined && Number.isInteger(max) && max > 0 ? { max_downloads: max } : {}),
      });
      setCreated(share);
      onCreated?.(share);
      void load();
    } catch (e) {
      keyring.handleError(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async (share: ShareInfo) => {
    try {
      await client.shares.revoke(share.id);
      if (created?.id === share.id) setCreated(null);
      void load();
    } catch (e) {
      keyring.handleError(e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleString(intlLocale);

  return (
    <VolaModal
      open={open}
      title={t("SHARE_TITLE", { name: file.filename ?? file.id })}
      onClose={onClose}
      dismissable={!busy}
      className="vola-share"
    >
      {encrypted ? (
        <p className="vola-warning" role="note">
          {t("SHARE_ENCRYPTED_WARNING")}
        </p>
      ) : null}
      <form
        className="vola-share__form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="vola-field" htmlFor={`${id}-password`}>
          <span>{t("PASSWORD")}</span>
          <input
            id={`${id}-password`}
            className="vola-input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="vola-field" htmlFor={`${id}-expires`}>
          <span>{t("EXPIRES")}</span>
          <input
            id={`${id}-expires`}
            className="vola-input"
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </label>
        <label className="vola-field" htmlFor={`${id}-max`}>
          <span>{t("MAX_DOWNLOADS")}</span>
          <input
            id={`${id}-max`}
            className="vola-input"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={maxDownloads}
            onChange={(event) => setMaxDownloads(event.target.value)}
          />
        </label>
        <button type="submit" className="vola-btn vola-btn--primary" disabled={busy}>
          {busy ? t("CREATING") : t("CREATE_LINK")}
        </button>
      </form>
      {error ? (
        <p className="vola-error" role="alert">
          {t("ERROR", { message: error })}
        </p>
      ) : null}
      {created ? (
        <div className="vola-share__link" role="status">
          <label className="vola-field" htmlFor={`${id}-url`}>
            <span>{t("LINK")}</span>
            <input
              id={`${id}-url`}
              className="vola-input"
              readOnly
              value={created.url}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button type="button" className="vola-btn" onClick={() => void copy()}>
            {copied ? t("COPIED") : t("COPY")}
          </button>
          <p className="vola-muted">{t("SHARE_LINK_ONCE")}</p>
        </div>
      ) : null}
      <h3 className="vola-share__heading">{t("EXISTING_SHARES")}</h3>
      {shares === null ? (
        <p className="vola-muted">{t("LOADING")}</p>
      ) : shares.length === 0 ? (
        <p className="vola-muted">{t("NO_SHARES")}</p>
      ) : (
        <ul className="vola-share__list">
          {shares.map((share) => (
            <li key={share.id} className="vola-share__item">
              <span className="vola-share__meta">
                <span>{t("CREATED_AT", { date: formatDate(share.created_at) })}</span>
                <span>
                  {t("DOWNLOADS", { count: share.download_count })}
                  {share.max_downloads !== null
                    ? ` ${t("OF_MAX", { max: share.max_downloads })}`
                    : ""}
                </span>
                {share.expires_at ? (
                  <span>{t("EXPIRES_AT", { date: formatDate(share.expires_at) })}</span>
                ) : null}
                {share.has_password ? (
                  <span className="vola-tag">{t("PASSWORD_PROTECTED")}</span>
                ) : null}
                {share.encrypted ? <span className="vola-tag">{t("ENCRYPTED")}</span> : null}
              </span>
              <button
                type="button"
                className="vola-btn vola-btn--danger"
                onClick={() => void revoke(share)}
                aria-label={`${t("REVOKE")} ${share.id}`}
              >
                {t("REVOKE")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </VolaModal>
  );
}
