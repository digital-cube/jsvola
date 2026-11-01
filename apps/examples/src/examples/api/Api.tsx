import { useI18n } from "@jsudc/react";
import { useSettings } from "../../connection.js";
import { Code, Note, PageHeader } from "../shared.js";
import { absolute } from "../thumbnails/Thumbnails.js";

export interface ApiRoute {
  method: string;
  path: string;
  scope: string;
  what: { en: string; sr: string };
}

/** The routes behind the pages, in the order of the site. */
export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/health/live · /health/ready",
    scope: "—",
    what: { en: "the process; the database and Redis", sr: "proces; baza i Redis" },
  },
  {
    method: "GET",
    path: "/examples/config",
    scope: "—",
    what: {
      en: "the demo key and limits this site runs on (VOLA_EXAMPLES)",
      sr: "demo ključ i ograničenja na kojima radi ovaj sajt (VOLA_EXAMPLES)",
    },
  },
  {
    method: "GET",
    path: "/files/:type/:id",
    scope: "files:read",
    what: {
      en: "the instance's files, newest first, cursor pages",
      sr: "fajlovi instance, najnoviji prvi, kursorske strane",
    },
  },
  {
    method: "POST",
    path: "/files/:type/:id",
    scope: "files:write",
    what: {
      en: "multipart upload: file, folder_path, metadata, encryption",
      sr: "multipart upload: file, folder_path, metadata, encryption",
    },
  },
  {
    method: "PUT",
    path: "/files/:type/:id/slug/:slug",
    scope: "files:write",
    what: {
      en: "upsert of a named file (the seeder uses it)",
      sr: "upsert imenovanog fajla (koristi ga seeder)",
    },
  },
  {
    method: "GET",
    path: "/files/:type/:id/:fileId",
    scope: "files:read",
    what: {
      en: "download: Range/206, ETag/304, Content-Disposition",
      sr: "preuzimanje: Range/206, ETag/304, Content-Disposition",
    },
  },
  {
    method: "GET",
    path: "/files/:type/:id/:fileId/info",
    scope: "files:read",
    what: {
      en: "metadata, processing_status, the ocr block (?ocr=full)",
      sr: "metapodaci, processing_status, ocr blok (?ocr=full)",
    },
  },
  {
    method: "GET",
    path: "/files/:type/:id/:fileId/thumb/:size?crop=",
    scope: "files:read",
    what: {
      en: "WebP 64–512; 202 while the worker renders",
      sr: "WebP 64–512; 202 dok worker renderuje",
    },
  },
  {
    method: "GET",
    path: "/files/:type/:id/:fileId/versions",
    scope: "files:read",
    what: { en: "the version chain", sr: "lanac verzija" },
  },
  {
    method: "PATCH",
    path: "/files/:type/:id/:fileId",
    scope: "files:write",
    what: {
      en: "rename, move (folder_path), visibility",
      sr: "preimenuj, premesti (folder_path), vidljivost",
    },
  },
  {
    method: "DELETE",
    path: "/files/:type/:id/:fileId[/purge]",
    scope: "files:write",
    what: {
      en: "soft delete; purge removes the bytes",
      sr: "meko brisanje; purge uklanja bajtove",
    },
  },
  {
    method: "GET",
    path: "/public/:fileId",
    scope: "—",
    what: {
      en: "an is_global_public file, no key (the players)",
      sr: "is_global_public fajl, bez ključa (plejeri)",
    },
  },
  {
    method: "GET",
    path: "/folders/:type/:id[/path]",
    scope: "folders:read",
    what: { en: "a folder's subfolders and files", sr: "podfolderi i fajlovi foldera" },
  },
  {
    method: "POST",
    path: "/uploads · HEAD/PATCH/DELETE /uploads/:id",
    scope: "files:write",
    what: { en: "resumable upload (tus 1.0 core)", sr: "resumable upload (tus 1.0 core)" },
  },
  {
    method: "POST",
    path: "/shares",
    scope: "shares:write",
    what: {
      en: "a link: password, expires_at, max_downloads",
      sr: "link: lozinka, expires_at, max_downloads",
    },
  },
  {
    method: "GET",
    path: "/s/:token",
    scope: "—",
    what: {
      en: "the shared file (X-Share-Password when it has one)",
      sr: "deljeni fajl (X-Share-Password kad je ima)",
    },
  },
  {
    method: "POST",
    path: "/keyrings/me · /unlock · DELETE /unlock",
    scope: "keyrings:write",
    what: {
      en: "a PIN, an unlock token (X-Vola-Unlock), a lock",
      sr: "PIN, unlock token (X-Vola-Unlock), zaključavanje",
    },
  },
  {
    method: "POST",
    path: "/udc/list {collection: files}",
    scope: "files:read",
    what: {
      en: "the files UDC collection (what the browser draws)",
      sr: "UDC kolekcija files (ono što crta pregledač)",
    },
  },
  {
    method: "GET",
    path: "/udc/subscribe (WebSocket)",
    scope: "files:read",
    what: {
      en: "row events; the key as the bearer.<key> subprotocol",
      sr: "događaji redova; ključ kao subprotokol bearer.<key>",
    },
  },
  {
    method: "ANY",
    path: "/examples/write/<route>",
    scope: "— (X-User-Id: demo-…)",
    what: {
      en: "the write proxy: the demo's writes under the server's key",
      sr: "write proxy: upisi demoa pod serverovim ključem",
    },
  },
];

/** `/examples/api`: the table of routes and curl examples with the demo key. */
export function ApiPage() {
  const { t, locale } = useI18n();
  const { connection } = useSettings();
  const base = absolute(connection.baseUrl);
  const key = connection.apiKey;
  const instance = `${connection.instanceType}/${connection.instanceId}`;
  const auth = `-H "Authorization: Bearer ${key || "<key>"}"`;
  return (
    <div className="page">
      <PageHeader title={t("API", "TITLE")} subtitle={t("API", "SUBTITLE")} />
      <Note>{t("API", "KEY_NOTE")}</Note>
      <section className="api" data-testid="api">
        <table className="api__table">
          <thead>
            <tr>
              <th>{t("API", "METHOD")}</th>
              <th>{t("API", "PATH")}</th>
              <th>{t("API", "SCOPE")}</th>
              <th>{t("API", "WHAT")}</th>
            </tr>
          </thead>
          <tbody>
            {API_ROUTES.map((route) => (
              <tr key={`${route.method} ${route.path}`}>
                <td>
                  <code>{route.method}</code>
                </td>
                <td>
                  <code>{route.path}</code>
                </td>
                <td>
                  <code>{route.scope}</code>
                </td>
                <td>{locale === "sr" ? route.what.sr : route.what.en}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>{t("API", "EXAMPLES")}</h2>
        {!key ? <p className="notice">{t("API", "NO_KEY")}</p> : null}
        <Code label="health" text={`curl -sS ${base}/health/ready`} />
        <Code label="config" text={`curl -sS ${base}/examples/config`} />
        <Code label="list" text={`curl -sS ${auth} "${base}/files/${instance}?limit=5"`} />
        <Code
          label="info"
          text={`curl -sS ${auth} "${base}/files/${instance}/<fileId>/info?ocr=full"`}
        />
        <Code
          label="download with Range"
          text={`curl -sS -D - -o part.bin ${auth} -H "Range: bytes=0-1023" "${base}/files/${instance}/<fileId>"`}
        />
        <Code
          label="thumbnail"
          text={`curl -sS -D - -o thumb.webp ${auth} "${base}/files/${instance}/<fileId>/thumb/256?crop=attention"`}
        />
        <Code label="folders" text={`curl -sS ${auth} "${base}/folders/${instance}/images"`} />
        <Code
          label="udc list"
          text={`curl -sS ${auth} -H "Content-Type: application/json" -d '{"collection":"files","filter":{"and":[{"field":"instance_type","op":"eq","value":"${connection.instanceType}"},{"field":"instance_id","op":"eq","value":"${connection.instanceId}"}]},"page":{"limit":5}}' ${base}/udc/list`}
        />
        <Code label="lookups" text={`curl -sS "${base}/lookups?locale=${locale}"`} />
        <Code
          label="write through the proxy (no key)"
          text={`curl -sS -H "X-User-Id: ${connection.visitor}" -F "file=@photo.jpg" -F "folder_path=uploads" ${base}/examples/write/files/${instance}`}
        />
        <Code
          label="a write with the demo key → 403"
          text={`curl -sS -X POST ${auth} -F "file=@photo.jpg" ${base}/files/${instance}`}
        />
      </section>
    </div>
  );
}
