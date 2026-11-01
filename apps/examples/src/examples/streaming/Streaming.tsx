import { useI18n } from "@jsudc/react";
import type { FileInfo } from "@vola/core";
import { useVola } from "@vola/react";
import { useEffect, useState } from "react";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import { Code, FilePicker, Loaded, Note, PageHeader, SeedHint, useDemoFiles } from "../shared.js";
import { absolute } from "../thumbnails/Thumbnails.js";

const MEDIA = /^(video|audio)\//;

export interface ProbeResult {
  method: string;
  range: string | null;
  status: number;
  headers: [string, string][];
  received: number;
}

/**
 * `/examples/streaming`: `<video>` and `<audio>` on the public URL of the seeded media (the
 * browser seeks with `Range`), and a probe that makes the same request from the page and
 * shows the `206`, `Content-Range` and `Accept-Ranges` it got.
 */
export function StreamingPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <PageHeader title={t("STREAM", "TITLE")} subtitle={t("STREAM", "SUBTITLE")} />
      <Note>{t("STREAM", "HOW")}</Note>
      <Connected>
        <Players />
      </Connected>
    </div>
  );
}

function Players() {
  const { t } = useI18n();
  const { files, isLoading, error } = useDemoFiles();
  const media = files.filter((f) => f.is_global_public && MEDIA.test(f.mime_type ?? ""));
  const [picked, setPicked] = useState("");
  const file = media.find((f) => f.id === picked) ?? media[0];
  useEffect(() => {
    if (file && picked !== file.id) setPicked(file.id);
  }, [file, picked]);
  return (
    <Loaded isLoading={isLoading} error={error}>
      {!file ? (
        <SeedHint>{t("STREAM", "NONE")}</SeedHint>
      ) : (
        <section className="stream" data-testid="streaming">
          <FilePicker files={media} value={file.id} onChange={setPicked} label={t("APP", "FILE")} />
          <Player key={file.id} file={file} />
          <Probe key={`probe-${file.id}`} file={file} />
        </section>
      )}
    </Loaded>
  );
}

function Player({ file }: { file: FileInfo }) {
  const client = useVola();
  const src = client.files.publicUrl(file.id);
  const video = (file.mime_type ?? "").startsWith("video/");
  return (
    <figure className="player">
      {video ? (
        // biome-ignore lint/a11y/useMediaCaption: a synthetic test pattern without speech
        <video controls preload="metadata" src={src} data-testid="video" />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: a synthetic tone without speech
        <audio controls preload="metadata" src={src} data-testid="audio" />
      )}
      <figcaption>
        <code>{src}</code> · {file.mime_type} · {file.size} B
      </figcaption>
    </figure>
  );
}

function Probe({ file }: { file: FileInfo }) {
  const { t } = useI18n();
  const client = useVola();
  const { connection } = useSettings();
  const [from, setFrom] = useState("0");
  const [to, setTo] = useState("1023");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (method: "GET" | "HEAD", range: string | null) => {
    setBusy(true);
    try {
      const response = await client.rawFetch(client.files.publicUrl(file.id), {
        method,
        headers: range ? { range } : {},
      });
      const body = method === "GET" ? await response.arrayBuffer() : new ArrayBuffer(0);
      setResult({
        method,
        range,
        status: response.status,
        headers: [...response.headers.entries()].filter(([name]) =>
          [
            "content-range",
            "content-length",
            "accept-ranges",
            "content-type",
            "etag",
            "cache-control",
          ].includes(name),
        ),
        received: body.byteLength,
      });
    } catch (e) {
      setResult({
        method,
        range,
        status: 0,
        headers: [["error", (e as Error).message]],
        received: 0,
      });
    } finally {
      setBusy(false);
    }
  };
  // The page shows a 206 by itself, before anyone touches a control.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one probe per picked file
  useEffect(() => {
    void run("GET", "bytes=0-1023");
  }, [file.id]);

  const rangeHeader = `bytes=${from.trim()}-${to.trim()}`;
  return (
    <section className="probe" data-testid="probe">
      <h2>{t("STREAM", "PROBE")}</h2>
      <div className="toolbar">
        <label>
          {t("STREAM", "FROM")}{" "}
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            size={8}
            inputMode="numeric"
          />
        </label>
        <label>
          {t("STREAM", "TO")}{" "}
          <input value={to} onChange={(e) => setTo(e.target.value)} size={8} inputMode="numeric" />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => run("GET", rangeHeader)}
          data-testid="probe-send"
        >
          {t("STREAM", "SEND")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => run("HEAD", null)}>
          {t("STREAM", "HEAD")}
        </button>
      </div>
      {result ? (
        <dl className="probe__result" data-testid="probe-result" data-status={result.status}>
          <dt>{t("STREAM", "LAST")}</dt>
          <dd>
            <code>
              {result.method} {client.files.publicUrl(file.id)}
              {result.range ? ` · Range: ${result.range}` : ""}
            </code>
          </dd>
          <dt>{t("STREAM", "STATUS")}</dt>
          <dd>
            <strong className="probe__status">{result.status}</strong>
          </dd>
          {result.headers.map(([name, value]) => (
            <div key={name} className="probe__header">
              <dt>{name}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
          <dt>{t("STREAM", "RECEIVED")}</dt>
          <dd className="num">{result.received}</dd>
        </dl>
      ) : null}
      <Code
        label="curl"
        text={`curl -sS -D - -o /dev/null -H "Range: ${rangeHeader}" "${absolute(connection.baseUrl)}/public/${file.id}"`}
      />
    </section>
  );
}
