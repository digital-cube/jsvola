import { useI18n } from "@jsudc/react";
import { Settings2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type Connection, useSettings } from "../connection.js";

/** The badge of the key in use: demo / own / none. */
export function KeyBadge({ connection }: { connection: Connection }) {
  const { t } = useI18n();
  const label = {
    demo: t("APP", "KEY_DEMO"),
    own: t("APP", "KEY_OWN"),
    pending: t("APP", "KEY_PENDING"),
    none: t("APP", "KEY_NONE"),
  }[connection.source];
  return (
    <span className="badge" data-key-source={connection.source} data-testid="key-badge">
      {label}
      {connection.source === "demo" && connection.demo ? (
        <span className="badge__sub">{t("APP", "TENANT", { tenant: connection.demo.tenant })}</span>
      ) : null}
    </span>
  );
}

/**
 * Base URL, API key, instance and the visitor id. Shows the key in use — the demo key too,
 * badged — and lets the visitor replace it; submitting the demo key unchanged keeps following
 * the demo key, and "Use the demo key" forgets the visitor's own.
 */
export function ConnectionForm({ onDone }: { onDone?: () => void }) {
  const { t } = useI18n();
  const { settings, connection, apply, newVisitor } = useSettings();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [apiKey, setApiKey] = useState(connection.apiKey);
  const [instanceType, setInstanceType] = useState(settings.instanceType);
  const [instanceId, setInstanceId] = useState(settings.instanceId);
  useEffect(() => setBaseUrl(settings.baseUrl), [settings.baseUrl]);
  useEffect(() => setApiKey(connection.apiKey), [connection.apiKey]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    const own = connection.source === "demo" && key === connection.apiKey ? "" : key;
    apply({
      ...settings,
      baseUrl: baseUrl.trim() || settings.baseUrl,
      apiKey: own,
      instanceType: instanceType.trim(),
      instanceId: instanceId.trim(),
    });
    onDone?.();
  };
  const forget = () => {
    apply({ ...settings, apiKey: "" });
    onDone?.();
  };

  return (
    <form className="connect" onSubmit={submit} data-testid="connection-form">
      <label>
        {t("APP", "BASE_URL")}
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
      </label>
      <label className="connect__key">
        <span className="connect__label">
          {t("APP", "API_KEY")}
          {connection.source === "demo" && apiKey === connection.apiKey ? (
            <KeyBadge connection={connection} />
          ) : null}
        </span>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="vola_live_…"
          type="password"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      {connection.source === "demo" ? (
        <p className="connect__hint">{t("APP", "DEMO_HINT")}</p>
      ) : null}
      <div className="connect__row">
        <label>
          {t("APP", "INSTANCE")}
          <input
            value={instanceType}
            onChange={(e) => setInstanceType(e.target.value)}
            placeholder={connection.instanceType}
            spellCheck={false}
          />
        </label>
        <label>
          <span className="connect__label">&nbsp;</span>
          <input
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            placeholder={connection.instanceId}
            spellCheck={false}
          />
        </label>
      </div>
      <p className="connect__hint">{t("APP", "INSTANCE_HINT")}</p>
      <div className="connect__visitor">
        <span className="connect__label">{t("APP", "VISITOR")}</span>
        <code data-testid="visitor-id">{connection.visitor}</code>
        <button type="button" className="btn btn--ghost" onClick={newVisitor}>
          {t("APP", "NEW_VISITOR")}
        </button>
      </div>
      <p className="connect__hint">
        {t("APP", "VISITOR_HINT", { hours: connection.demo?.limits.ttl_hours ?? 24 })}
      </p>
      <div className="connect__actions">
        <button type="submit" className="btn btn--primary">
          {t("APP", "CONNECT")}
        </button>
        {connection.source === "own" ? (
          <button type="button" className="btn" onClick={forget}>
            {t("APP", "FORGET_KEY")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** A button in the header with the connection form under it; Escape or a click outside closes it. */
export function SettingsPopover() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="popover" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="settings-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings2 aria-hidden className="btn__icon" />
        {t("APP", "SETTINGS")}
      </button>
      {open ? (
        <Panel label={t("APP", "SETTINGS")}>
          <ConnectionForm onDone={() => setOpen(false)} />
        </Panel>
      ) : null}
    </div>
  );
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="popover__panel" role="dialog" aria-label={label}>
      {children}
    </div>
  );
}
