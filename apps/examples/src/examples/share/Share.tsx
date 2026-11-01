import { useI18n } from "@jsudc/react";
import type { ShareCreated } from "@vola/core";
import { VolaShareDialog } from "@vola/react";
import { useEffect, useState } from "react";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import {
  Code,
  FilePicker,
  Loaded,
  Note,
  PageHeader,
  SeedHint,
  useDemoFiles,
  WriteNotice,
} from "../shared.js";

/**
 * `/examples/share`: `VolaShareDialog` over a demo file — password, expiry, most downloads,
 * the link shown once, the list and revoke — through the write proxy, and the last link to
 * open in a new tab.
 */
export function SharePage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <PageHeader title={t("SHARE", "TITLE")} subtitle={t("SHARE", "SUBTITLE")} />
      <Note>{t("SHARE", "HOW", { hours: connection.demo?.limits.ttl_hours ?? 24 })}</Note>
      <WriteNotice />
      <Connected>
        <Sharing />
      </Connected>
    </div>
  );
}

function Sharing() {
  const { t } = useI18n();
  const { files, isLoading, error } = useDemoFiles();
  const shareable = files.filter((f) => f.encryption !== "client");
  const [picked, setPicked] = useState("");
  const file = shareable.find((f) => f.id === picked) ?? shareable[0];
  useEffect(() => {
    if (file && picked !== file.id) setPicked(file.id);
  }, [file, picked]);
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<ShareCreated | null>(null);
  return (
    <Loaded isLoading={isLoading} error={error}>
      {!file ? (
        <SeedHint>{t("SHARE", "NONE")}</SeedHint>
      ) : (
        <section className="share" data-testid="share">
          <div className="toolbar">
            <FilePicker
              files={shareable}
              value={file.id}
              onChange={setPicked}
              label={t("SHARE", "PICK")}
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setOpen(true)}
              data-testid="share-open"
            >
              {t("SHARE", "OPEN")}
            </button>
          </div>
          <VolaShareDialog
            key={file.id}
            file={file}
            open={open}
            onClose={() => setOpen(false)}
            onCreated={(share) => setLast(share)}
          />
          {last ? (
            <div className="share__last" data-testid="share-last">
              <h2>{t("SHARE", "LAST")}</h2>
              <Code text={last.url} />
              <a className="btn" href={last.url} target="_blank" rel="noreferrer">
                {t("SHARE", "OPEN_LINK")}
              </a>
              <Code
                label="curl"
                text={`curl -sS -D - -o shared.bin "${last.url.split("#")[0]}"${last.has_password ? ' \\\n  -H "X-Share-Password: …"' : ""}`}
              />
            </div>
          ) : null}
        </section>
      )}
    </Loaded>
  );
}
