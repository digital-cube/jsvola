import { useI18n } from "@jsudc/react";
import {
  THUMBNAIL_CROPS,
  THUMBNAIL_SIZES,
  type ThumbnailCrop,
  type ThumbnailSize,
} from "@vol-a/core";
import { type ThumbState, useVola, useVolaContext, VolaThumb } from "@vol-a/react";
import { useEffect, useState } from "react";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import { Code, FilePicker, Loaded, Note, PageHeader, SeedHint, useDemoFiles } from "../shared.js";

/** The types a thumbnail is rendered of (raster images and PDF; the server says the same). */
export const THUMBABLE = /^(image\/(jpeg|png|webp|gif|avif|tiff)|application\/pdf)$/;

/**
 * `/examples/thumbnails`: every size × every crop of one file, the state of each tile
 * (`generating` is the `202`), and a Regenerate button that drops the renditions so the
 * `202 → 200` sequence can be watched again.
 */
export function ThumbnailsPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <PageHeader title={t("THUMBS", "TITLE")} subtitle={t("THUMBS", "SUBTITLE")} />
      <Note>{t("THUMBS", "HOW")}</Note>
      <Connected>
        <ThumbGrid />
      </Connected>
    </div>
  );
}

function ThumbGrid() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const client = useVola();
  const { blobs } = useVolaContext();
  const { files, isLoading, error } = useDemoFiles();
  const candidates = files.filter(
    (f) => f.encryption !== "client" && THUMBABLE.test(f.mime_type ?? ""),
  );
  const [picked, setPicked] = useState("");
  const file = candidates.find((f) => f.id === picked) ?? candidates[0];
  useEffect(() => {
    if (file && picked !== file.id) setPicked(file.id);
  }, [file, picked]);
  const [generation, setGeneration] = useState(0);
  const [states, setStates] = useState<Record<string, ThumbState>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const regenerate = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(t("THUMBS", "REGENERATING"));
    try {
      const response = await client.rawFetch(
        `${connection.baseUrl}/examples/regenerate/${encodeURIComponent(file.id)}`,
        { method: "POST", headers: { "x-user-id": connection.visitor } },
      );
      const body = (await response.json()) as { removed?: number; error?: { message: string } };
      if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      setMessage(t("THUMBS", "REGENERATED", { count: body.removed ?? 0 }));
      setStates({});
      // Every cached blob: URL goes (a new generation), so every tile asks the server again.
      blobs.forget();
      setGeneration((g) => g + 1);
    } catch (e) {
      setMessage(t("APP", "ERROR", { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Loaded isLoading={isLoading} error={error}>
      {!file ? (
        <SeedHint>{t("THUMBS", "NONE")}</SeedHint>
      ) : (
        <section className="thumbs" data-testid="thumbnails">
          <div className="toolbar">
            <FilePicker
              files={candidates}
              value={file.id}
              onChange={setPicked}
              label={t("THUMBS", "PICK")}
            />
            {connection.proxied ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={regenerate}
                disabled={busy}
                data-testid="regenerate"
              >
                {t("THUMBS", "REGENERATE")}
              </button>
            ) : null}
            {message ? (
              <span className="muted" data-testid="regenerate-message">
                {message}
              </span>
            ) : null}
            {connection.demo && !connection.demo.features.worker ? (
              <span className="muted">{t("THUMBS", "NO_WORKER")}</span>
            ) : null}
          </div>
          <table className="thumbs__grid">
            <thead>
              <tr>
                <th />
                {THUMBNAIL_CROPS.map((crop) => (
                  <th key={crop}>
                    <code>?crop={crop}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {THUMBNAIL_SIZES.map((size) => (
                <tr key={size}>
                  <th>
                    <code>/thumb/{size}</code>
                  </th>
                  {THUMBNAIL_CROPS.map((crop) => {
                    const key = `${size}/${crop}`;
                    return (
                      <td key={crop}>
                        <Tile
                          key={`${file.id}/${key}/${generation}`}
                          file={file}
                          size={size}
                          crop={crop}
                          state={states[key] ?? "loading"}
                          onState={(s) => setStates((all) => ({ ...all, [key]: s }))}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <Code
            label="curl"
            text={`curl -sS -D - -o thumb.webp \\\n  -H "Authorization: Bearer ${connection.apiKey}" \\\n  "${absolute(connection.baseUrl)}/files/${connection.instanceType}/${connection.instanceId}/${file.id}/thumb/256?crop=fit"`}
          />
        </section>
      )}
    </Loaded>
  );
}

function Tile({
  file,
  size,
  crop,
  state,
  onState,
}: {
  file: {
    id: string;
    instance_type: string;
    instance_id: string;
    filename: string;
    encryption: string;
    kind: string;
    processing_status: string | null;
  };
  size: ThumbnailSize;
  crop: ThumbnailCrop;
  state: ThumbState;
  onState: (state: ThumbState) => void;
}) {
  const { t } = useI18n();
  const status = {
    loading: "…",
    ready: "200",
    generating: "202",
    failed: "failed",
    none: "404",
    locked: "423",
    error: "error",
  }[state];
  return (
    <figure className="tile" data-state={state} data-testid="tile">
      <VolaThumb file={file} size={size} crop={crop} onState={onState} />
      <figcaption>
        <span className="tile__state">{status}</span>
        <span className="muted">
          {" "}
          · {t("THUMBS", "STATE")}: {state}
        </span>
      </figcaption>
    </figure>
  );
}

/** `baseUrl` as an absolute URL (for the curl examples). */
export function absolute(baseUrl: string): string {
  try {
    return new URL(
      baseUrl,
      typeof location !== "undefined" ? location.href : "http://localhost/",
    ).href.replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}
