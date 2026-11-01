import { useI18n } from "@jsudc/react";
import { useVolaUpload, VolaUploadButton, VolaUploadList } from "@vola/react";
import { type DragEvent, useState } from "react";
import { CHUNK_SIZE, RESUMABLE_THRESHOLD } from "../../App.js";
import { useSettings } from "../../connection.js";
import { formatBytes } from "../../settings.js";
import { Connected } from "../../shell/AppShell.js";
import { BrowseLink, Note, PageHeader, WriteNotice } from "../shared.js";

/** Where the visitors' uploads of this page land. */
export const UPLOAD_FOLDER = "uploads";

/**
 * `/examples/upload`: a plain multipart `POST` under the threshold, the resumable protocol
 * above it — progress, cancel, resume — through the server's write proxy, within the demo's
 * limits (size, type, TTL, rate).
 */
export function UploadPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const limits = connection.demo?.limits;
  const vars = {
    threshold: formatBytes(RESUMABLE_THRESHOLD),
    chunk: formatBytes(CHUNK_SIZE),
    max: formatBytes(limits?.max_upload_bytes ?? 5 * 1024 * 1024),
    hours: limits?.ttl_hours ?? 24,
    count: limits?.rate_limit ?? 60,
    minutes: Math.round((limits?.rate_window_s ?? 600) / 60),
  };
  return (
    <div className="page">
      <PageHeader title={t("UPLOAD", "TITLE")} subtitle={t("UPLOAD", "SUBTITLE", vars)} />
      <Note>{t("UPLOAD", "HOW", vars)}</Note>
      <WriteNotice />
      <Connected>
        <section className="upload" data-testid="upload">
          <dl className="limits" aria-label={t("UPLOAD", "LIMITS")}>
            <dt>{t("UPLOAD", "LIMITS")}</dt>
            <dd>{t("UPLOAD", "LIMIT_SIZE", vars)}</dd>
            <dd>{t("UPLOAD", "LIMIT_TYPES")}</dd>
            <dd>{t("UPLOAD", "LIMIT_TTL", vars)}</dd>
            <dd>{t("UPLOAD", "LIMIT_RATE", vars)}</dd>
          </dl>
          <Uploader />
        </section>
      </Connected>
    </div>
  );
}

function Uploader() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const uploads = useVolaUpload();
  const [over, setOver] = useState(false);
  const options = {
    instanceType: connection.instanceType,
    instanceId: connection.instanceId,
    folderPath: UPLOAD_FOLDER,
    chunkSize: CHUNK_SIZE,
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (event.dataTransfer.files.length > 0) void uploads.upload(event.dataTransfer.files, options);
  };
  const done = uploads.uploads.filter((u) => u.status === "done");
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard path */}
      <div
        className={over ? "drop drop--over" : "drop"}
        data-testid="drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p>{t("UPLOAD", "DROP")}</p>
        <VolaUploadButton {...options} uploads={uploads} showList={false} />
        <p className="muted">
          {t("UPLOAD", "FOLDER")} <code>{UPLOAD_FOLDER}/</code>
        </p>
      </div>
      <VolaUploadList uploads={uploads} />
      {done.length > 0 ? (
        <p className="muted" data-testid="uploaded">
          {t("UPLOAD", "DONE")}: {done.map((u) => u.name).join(", ")} ·{" "}
          <BrowseLink folder={UPLOAD_FOLDER} />
        </p>
      ) : null}
    </>
  );
}
