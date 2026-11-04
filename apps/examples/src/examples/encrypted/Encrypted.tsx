import { useI18n } from "@jsudc/react";
import type { FileInfo } from "@vol-a/core";
import {
  useVola,
  useVolaKeyring,
  VolaFileBrowser,
  VolaKeyringStatus,
  VolaPinGate,
  VolaThumb,
} from "@vol-a/react";
import { useEffect, useState } from "react";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import { BROWSE_COLUMNS } from "../browse/Browse.js";
import { Loaded, Note, PageHeader, SeedHint, useDemoFiles, WriteNotice } from "../shared.js";

/** The default unlock TTL of a server (`VOLA_UNLOCK_TTL_S`), for the explanation. */
export const DEFAULT_UNLOCK_TTL_S = 150;

/**
 * `/examples/encrypted`: the `tenant` mode (seeded files, transparent: thumbnail and download
 * work like any other) and the `keyring` mode — `VolaPinGate` over the visitor's private
 * folder, the unlock token counting down, a lock that empties the view.
 */
export function EncryptedPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <PageHeader title={t("ENC", "TITLE")} subtitle={t("ENC", "SUBTITLE")} />
      <Connected>
        <TenantSection />
        <KeyringSection />
      </Connected>
    </div>
  );
}

function TenantSection() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const { files, isLoading, error } = useDemoFiles();
  const encrypted = files.filter((f) => f.encryption === "tenant");
  return (
    <section className="enc" data-testid="tenant-section">
      <h2>{t("ENC", "TENANT_TITLE")}</h2>
      <Note>{t("ENC", "TENANT_HOW")}</Note>
      {connection.demo && !connection.demo.features.tenant_encryption ? (
        <p className="notice">{t("ENC", "TENANT_OFF")}</p>
      ) : null}
      <Loaded isLoading={isLoading} error={error}>
        {encrypted.length === 0 ? (
          <SeedHint>{t("ENC", "TENANT_NONE")}</SeedHint>
        ) : (
          <ul className="enc__files">
            {encrypted.map((file) => (
              <EncryptedFile key={file.id} file={file} />
            ))}
          </ul>
        )}
      </Loaded>
    </section>
  );
}

function EncryptedFile({ file }: { file: FileInfo }) {
  const { t } = useI18n();
  const client = useVola();
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    try {
      const response = await client.files.download(file.instance_type, file.instance_id, file.id);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <li className="enc__file" data-testid="tenant-file">
      <VolaThumb file={file} size={128} />
      <div>
        <strong>{file.filename}</strong>
        <div className="muted">
          <code>encryption: {file.encryption}</code> · <code>enc_format: {file.enc_format}</code> ·{" "}
          {file.mime_type} · {file.size} B
        </div>
        <button type="button" className="btn" onClick={download}>
          {t("ENC", "DOWNLOAD")}
        </button>
        {error ? <span className="error"> {error}</span> : null}
      </div>
    </li>
  );
}

function KeyringSection() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const off = connection.demo ? !connection.demo.features.keyring : false;
  return (
    <section className="enc" data-testid="keyring-section">
      <h2>{t("ENC", "KEYRING_TITLE")}</h2>
      <Note>
        {t("ENC", "KEYRING_HOW", {
          visitor: connection.visitor,
          ttl: DEFAULT_UNLOCK_TTL_S,
          hours: connection.demo?.limits.ttl_hours ?? 24,
        })}
      </Note>
      <WriteNotice />
      {off ? (
        <p className="notice" data-testid="keyring-off">
          {t("ENC", "KEYRING_OFF")}
        </p>
      ) : (
        <VolaPinGate title={t("ENC", "KEYRING_TITLE")}>
          <div className="toolbar">
            <VolaKeyringStatus />
            <UnlockCountdown />
          </div>
          <PrivateFolder />
          <h3>
            {t("ENC", "PRIVATE")}: <code>private/{connection.visitor}</code>
          </h3>
          <div className="view">
            <VolaFileBrowser
              key={connection.visitor}
              instanceType={connection.instanceType}
              instanceId={connection.instanceId}
              folderPath={`private/${connection.visitor}`}
              encryption="keyring"
              keyringStatus={false}
              columns={BROWSE_COLUMNS}
              actions={["download", "rename", "delete", "versions"]}
            />
          </div>
        </VolaPinGate>
      )}
    </section>
  );
}

/**
 * Makes sure the visitor's private folder exists once the gate is open (through the write
 * proxy; a folder that is already there is fine), so the browser below opens on a folder and
 * not on a 404.
 */
function PrivateFolder() {
  const client = useVola();
  const { connection } = useSettings();
  const { instanceType, instanceId, visitor } = connection;
  useEffect(() => {
    client.folders.create(instanceType, instanceId, `private/${visitor}`).catch(() => undefined);
  }, [client, instanceType, instanceId, visitor]);
  return null;
}

/** `unlock_expires_in` of the last status read, counted down on the page, refreshed every 15 s. */
export function UnlockCountdown() {
  const { t } = useI18n();
  const keyring = useVolaKeyring();
  const expiresIn = keyring.status?.unlock_expires_in ?? null;
  const [left, setLeft] = useState<number | null>(expiresIn);
  useEffect(() => setLeft(expiresIn), [expiresIn]);
  useEffect(() => {
    if (!keyring.unlocked) return;
    const tick = setInterval(() => setLeft((s) => (s === null ? null : Math.max(0, s - 1))), 1000);
    const refresh = setInterval(() => void keyring.refresh(), 15_000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [keyring.unlocked, keyring.refresh]);
  if (!keyring.unlocked || left === null) {
    return (
      <span className="badge" data-testid="unlock-left">
        {t("ENC", "UNLOCK_NONE")}
      </span>
    );
  }
  return (
    <span className="badge badge--live num" data-testid="unlock-left">
      {t("ENC", "UNLOCK_LEFT", { seconds: left })}
    </span>
  );
}
