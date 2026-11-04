import { useI18n } from "@jsudc/react";
import { VolaFileBrowser } from "@vol-a/react";
import { useSearchParams } from "react-router";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import { Note, PageHeader, WriteNotice } from "../shared.js";

/** The columns the page shows (the `files` view has every field; a demo wants the readable ones). */
export const BROWSE_COLUMNS = [
  "thumb_url",
  "filename",
  "kind",
  "size",
  "folder_path",
  "encryption",
  "processing_status",
  "created_at",
] as const;

/**
 * `/examples/browse`: `VolaFileBrowser` over the demo instance — folders, the `files` UDC
 * data view, thumbnails, the row menu, a drop zone — kept live through `/udc/subscribe`.
 * The folder is in the URL (`?folder=images`), so a link opens the browser inside it.
 */
export function BrowsePage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder") ?? "";
  const hours = connection.demo?.limits.ttl_hours ?? 24;
  return (
    <div className="page">
      <PageHeader title={t("BROWSE", "TITLE")} subtitle={t("BROWSE", "SUBTITLE")} />
      <Note>{t("BROWSE", "NOTE", { hours })}</Note>
      <WriteNotice />
      <Connected>
        <section className="view" data-testid="browse">
          <VolaFileBrowser
            key={`${connection.instanceType}/${connection.instanceId}`}
            instanceType={connection.instanceType}
            instanceId={connection.instanceId}
            folderPath={folder}
            onFolderChange={(path) => {
              const next = new URLSearchParams(params);
              if (path) next.set("folder", path);
              else next.delete("folder");
              setParams(next, { replace: true });
            }}
            encryptionChoices={
              connection.demo?.features.tenant_encryption === false ? ["none"] : ["none", "tenant"]
            }
            columns={BROWSE_COLUMNS}
            urlState="window"
          />
        </section>
      </Connected>
    </div>
  );
}
