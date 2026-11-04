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
 * open in a new tab (an encrypted file's through `X-Share-Secret`: a plain tab cannot send it).
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

/**
 * Opens an encrypted file's share in a new tab. A plain tab never sends the part of the link after
 * `#`, so it would answer `401 share_secret_required`: the page sends the secret as
 * `X-Share-Secret` and shows the answer. The tab opens first, or the browser blocks it as a popup.
 */
async function openWithSecret(url: string): Promise<void> {
  const [link, secret = ""] = url.split("#");
  const tab = window.open("", "_blank");
  try {
    const response = await fetch(link as string, { headers: { "x-share-secret": secret } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = URL.createObjectURL(await response.blob());
    if (tab) tab.location.href = blob;
    setTimeout(() => URL.revokeObjectURL(blob), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** The `curl` of a share: the headers a client has to send, the secret after `#` among them. */
function curlOf(share: ShareCreated): string {
  const [link, secret] = share.url.split("#");
  const headers = [
    ...(share.has_password ? ['-H "X-Share-Password: …"'] : []),
    ...(secret ? [`-H "X-Share-Secret: ${secret}"`] : []),
  ];
  return [`curl -sS -D - -o shared.bin "${link}"`, ...headers].join(" \\\n  ");
}

function LastLink({ share }: { share: ShareCreated }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const encrypted = share.url.includes("#");
  return (
    <div className="share__last" data-testid="share-last">
      <h2>{t("SHARE", "LAST")}</h2>
      <Code text={share.url} />
      {!encrypted ? (
        <a className="btn" href={share.url} target="_blank" rel="noreferrer">
          {t("SHARE", "OPEN_LINK")}
        </a>
      ) : share.has_password ? null : (
        <button
          type="button"
          className="btn"
          data-testid="share-open-secret"
          onClick={() => {
            setFailed(false);
            openWithSecret(share.url).catch(() => setFailed(true));
          }}
        >
          {t("SHARE", "OPEN_LINK")}
        </button>
      )}
      {failed ? <p role="alert">{t("SHARE", "OPEN_FAILED")}</p> : null}
      {encrypted ? <Note>{t("SHARE", "SECRET_NOTE")}</Note> : null}
      <Code label="curl" text={curlOf(share)} />
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
          {last ? <LastLink key={last.id} share={last} /> : null}
        </section>
      )}
    </Loaded>
  );
}
