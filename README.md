# JSVola

Self-hosted, multi-tenant, content-addressable file storage — the TypeScript port of
vola-spp. Fastify 5 + Drizzle/PostgreSQL + Redis, published as `@vola/*` packages on npm
and as one Docker image.

> Work in progress: this is the v1.0 scaffold. See `docs/PLAN.md` for the roadmap and the
> API contract, `docs/ANALYSIS.md` for the background.

## Packages

| package | what |
|---|---|
| `@vola/core` | Zod schemas and types shared by server, CLI and clients |
| `@vola/lookups` | controlled vocabularies: `lookups.yaml` + CSV translations, candidates, promotion (a copy of `@memento/lookups`) |
| `@vola/server` | Fastify plugin + standalone server, Drizzle schema and migrations |
| `@vola/cli` | `vola` command line (tenants, API keys, migrations) |
| `@vola/client` | fetch-based SDK |
| `@vola/react` | React 19 components and hooks |
| `packages/e2e` | end-to-end tests against the built server (private) |

## Quick start

```sh
pnpm install
cp .env.example .env
docker compose up -d          # PostgreSQL 16 + Redis 7 (also creates vola_test)
pnpm db:migrate
pnpm dev                      # http://localhost:8300/vola/health/live
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (needs the compose
databases), `pnpm test:e2e` (the built server against PostgreSQL + Redis).

## Tenants and API keys

Every route except health needs an API key: `Authorization: Bearer <key>`, `X-Api-Key: <key>`,
or — for WebSockets — the subprotocol `bearer.<key>`. A key belongs to one tenant and holds
scopes (`files:read`, `files:write`, `folders:read`, `folders:write`, `shares:write`,
`keys:write`, `keyrings:write`); an admin key (`vola_admin_…`, scope `admin`) belongs to no
tenant and selects one per request with `X-Tenant-Slug`. `X-User-Id` names the principal of
the host application (recorded as `created_by`, later for attribution and keyrings).

```sh
pnpm vola create-tenant --slug acme --name "Acme Inc"
pnpm vola create-key --tenant acme --name backend --env live --scopes files:read,files:write,keys:write
#   → prints vola_live_… ONCE; only its SHA-256 is stored
pnpm vola create-admin-key --name ops
pnpm vola list-keys --tenant acme
pnpm vola revoke-key vola_live…k3Qz          # or the key id

curl -H "Authorization: Bearer vola_live_…" localhost:8300/vola/keys
curl -H "X-Api-Key: vola_admin_…" -H "X-Tenant-Slug: acme" localhost:8300/vola/keys
```

A missing or unusable key is `401 unauthorized` (one message for every case); a missing scope
is `403 forbidden` with `required`; an admin key naming an unknown tenant gets
`404 tenant_not_found`, and one naming none on a tenant route `400 tenant_required`.

## Files

Files hang off an **instance** of the host application: `(instance_type, instance_id)`, e.g.
`tickets/<uuid>`. Bytes are stored content-addressed (`VOLA_STORAGE_PATH/blobs/aa/bb/cc/<sha256>`,
written to `tmp/` with the hash computed on the way, fsynced, then linked into place), so the same
content uploaded twice — by anyone — is one blob. Every row is tenant-scoped: another tenant's file
is `404 file_not_found`, never 403.

```sh
# upload (multipart, streamed; optional `metadata` JSON object) → 201 with the file info
curl -H "Authorization: Bearer $KEY" -F file=@report.pdf -F 'metadata={"source":"scan"}' \
     localhost:8300/vola/files/tickets/$TICKET
# a named file: PUT upserts, the previous `avatar` is soft-deleted in the same transaction
curl -X PUT -H "Authorization: Bearer $KEY" -F file=@me.png localhost:8300/vola/files/users/$USER/slug/avatar
# download: Range/206, HEAD, ETag/304, inline for images (not SVG), video, audio, PDF
curl -H "Authorization: Bearer $KEY" -H "Range: bytes=0-1023" localhost:8300/vola/files/tickets/$TICKET/$FILE
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/$FILE?download=1"
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/users/$USER/slug/avatar
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/info
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET?limit=50&cursor=…&include_deleted=1"
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE        # soft
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/purge  # → {files, blobs}
```

| route | scope | notes |
|---|---|---|
| `POST /vola/files/:type/:id` | `files:write` | `file` part + optional `metadata`; `folder_path` (created when missing) or `folder_id` places it; `parent_id` makes it a new version; `413 file_too_large` over `VOLA_MAX_UPLOAD_BYTES` (512 MiB); `a.pdf` → `a (1).pdf` on a name collision in the same folder |
| `PUT /vola/files/:type/:id/slug/:slug` | `files:write` | upsert of a named file |
| `GET\|HEAD …/:fileId`, `…/slug/:slug`, `…/path/*` | `files:read` | `Accept-Ranges: bytes`, single `Range` → `206`, outside → `416`; `ETag: "<sha256>"`, `If-None-Match` → `304`; `X-Content-Type-Options: nosniff`; `?download=1`; `last_accessed_*` once a minute (GET only); by id also another tenant's `is_public` file |
| `GET …/:fileId/info` | `files:read` | metadata, never `fk_ct`/`meta_ct`; `?include_deleted=1` |
| `GET …/:fileId/versions` | `files:read` | the version chain, newest first; `?include_deleted=1` |
| `GET /vola/files/:type/:id` | `files:read` | `created_at desc, id desc`, `?cursor`, `?limit` ≤ 200, `?include_deleted=1` |
| `PATCH …/:fileId` | `files:write` | `{folder_path}` moves (`""` = root), `{filename}` renames (`409 file_exists`), `{is_public}`, `{is_global_public}` (`409 encrypted_not_public` on an encrypted file) |
| `DELETE …/:fileId` | `files:write` | soft delete (`deleted_at`, `deleted_by`), idempotent |
| `DELETE …/:fileId/purge` | `files:write` | removes the row and its whole version chain; the blob and its derived files (thumbnails) leave the disk only when no row of any tenant references them |
| `GET\|HEAD …/:fileId/thumb/:size?crop=` | `files:read` | WebP thumbnail, `size` 64 / 128 / 256 / 512 (`400 invalid_size`), `crop` `cover` (default) / `fit` / `attention` (`400 invalid_crop`); **`200` ready or `202` generating** — see [Thumbnails](#thumbnails--get-thumbsize-answers-202-too); `404 no_thumbnail` for anything but a raster image or PDF, and for an encrypted file |
| `GET\|HEAD /vola/public/:fileId` | — | anonymous download of an `is_global_public` file (`Cache-Control: public, max-age=300`); anything else is `404` |

MIME is detected from the magic bytes (`file-type`), then the extension, then the declared type;
`kind` (`image`, `video`, `audio`, `document`, `spreadsheet`, `presentation`, `archive`, `text`,
`code`, `other`) follows from it. Every file info carries `processing_status`: the aggregate of
the file's background jobs (`vola_processing_job`), worst first — `FAILED` > `RUNNING` >
`PENDING` > `DONE`, `SKIPPED` ignored — and `null` when no job was ever created for it (a text
file, or a deployment without a worker).

### Thumbnails — `GET …/thumb/:size` answers **202** too

An upload of a raster image (not SVG) or a PDF queues four `THUMBNAIL` jobs (64, 128, 256,
512, crop `cover`) for the worker, which renders them with [sharp](https://sharp.pixelplumbing.com/)
— EXIF orientation applied, WebP quality 80, the first page of a PDF through `pdftoppm -r 72`
— and stores each next to the blob as `thumb-<size>-<crop>.webp`: shared by every file of every
tenant with that content, gone with the blob on purge. `/thumb/:size` takes the rendering off the
request path, so there are two outcomes a client MUST tell apart:

| status | body | headers | meaning |
|---|---|---|---|
| `200` | the WebP thumbnail | `X-Thumbnail-Status: ready`, `Cache-Control: private, max-age=86400`, `ETag` (`304` on `If-None-Match`) | cache hit |
| `202` | a **grey placeholder** (~50 B) | `X-Thumbnail-Status: generating`, `Cache-Control: no-cache` | cache miss; the job is queued (or refreshed) for the worker — retry |

> **Trap:** `202` is a *success* status. It passes `raise_for_status()` (httpx/requests) and
> `response.ok` (fetch), so the placeholder looks like a valid thumbnail unless you check for it
> explicitly.

Rules for consumers:

1. **Branch on the status code, not on an exception** — `status !== 202` is the only reliable
   test that the bytes are a real thumbnail (`X-Thumbnail-Status: generating` is the equivalent
   signal).
2. **Never cache a 202 body under a key derived from the content** (hash, checksum, ETag). Such a
   key never invalidates, so the grey square outlives the real thumbnail — in the browser's HTTP
   cache and in any in-memory / object-URL cache alike. A `202` carries no `ETag` for that reason.
3. **If you proxy a thumbnail onwards**, pass the status and `no-cache` through; do not repackage
   a 202 body into your own `max-age` + `ETag` answer.
4. **Retry** — the worker usually fills the cache within about a second; the next request is a
   `200`.

Two more answers: a file that cannot be rendered (broken bytes, `pdftoppm` missing) is `200` with
the grey placeholder, `X-Thumbnail-Status: failed` and `no-cache` — its jobs are `FAILED` after 3
tries and `processing_status` says so; a file that has no thumbnail by nature (text, video, SVG, an
encrypted file until phase 6.3) is `404 no_thumbnail`. If the queue cannot be reached, the server
renders inline and answers `200` — the worker is an optimisation, not a requirement. The same
rules hold for every size: `[64, 128, 256, 512]`, anything else is `400`.

The worker publishes a `processing` event after every job, so a live `files` list (see
[Real-time](#real-time-get-volaudcsubscribe)) sees `processing_status` move without polling.

#### Deployment without a worker (`VOLA_WORKER_ENABLED`)

The worker is a second process of the same image (`node dist/worker.js`, `pnpm start:worker`);
a deployment that does not run one is supported: thumbnails are rendered lazily on `/thumb`
(`200`, the real WebP), nothing is recorded in `vola_processing_job`, OCR (phase 4.2) does not
run. That is **not logged as an error** — one INFO line per process, `background jobs disabled`.

| `VOLA_WORKER_ENABLED` | behaviour |
|---|---|
| `auto` *(default)* | async when `VOLA_REDIS_URL` is set, synchronous otherwise |
| `1` / `true` | insist on async; without `VOLA_REDIS_URL` one ERROR line, then synchronous |
| `0` / `false` | always synchronous, even with Redis configured |

> **When `0` is necessary:** a deployment with Redis but without a worker process consuming the
> queue. Auto mode would queue a job nobody picks up and `/thumb` would answer `202` + grey
> placeholder forever — Redis being reachable does not mean a worker is running.

`VOLA_WORKER_CONCURRENCY` (default 2) is how many jobs one worker process runs at once;
`VOLA_QUEUE_PREFIX` (default `vola`) is the Redis key prefix server and worker must share. Every
job has 30 s, 3 tries with exponential backoff, then `FAILED` with a short `error` (never the
file name). The expired-upload sweep is a repeatable job of the same queue in async mode (the
server schedules it, the worker runs it); without a worker the server sweeps in-process.

### Resumable uploads (tus 1.0)

`/vola/uploads` speaks [tus 1.0](https://tus.io/protocols/resumable-upload) core with the
`creation`, `termination` and `expiration` extensions, implemented natively (phase 6.3 cuts this
byte stream into encrypted segments, which no external tus server would allow), so
[`tus-js-client`](https://github.com/tus/tus-js-client) works unchanged. An upload belongs to the
tenant: any `files:write` key of it may resume one; another tenant's is `404`. Completion takes
the SAME path as `POST /vola/files` — hash, dedup, MIME, collision rename, folder, version, slug —
and the last `PATCH` answers with `Vola-File-Id` (so does every `HEAD` after it).

```js
import * as tus from "tus-js-client";
const upload = new tus.Upload(file, {
  endpoint: "https://…/vola/uploads",
  headers: { Authorization: `Bearer ${key}`, "X-User-Id": userId },
  metadata: { instance_type: "tickets", instance_id: ticketId, filename: file.name, filetype: file.type,
              folder_path: "docs/2026", slug: "contract", metadata: JSON.stringify({ source: "web" }) },
  chunkSize: 8 * 1024 * 1024,
  onSuccess: ({ lastResponse }) => console.log("file", lastResponse.getHeader("Vola-File-Id")),
});
upload.start();
```

| route | scope | notes |
|---|---|---|
| `OPTIONS /vola/uploads` | — | `Tus-Resumable`, `Tus-Version: 1.0.0`, `Tus-Extension: creation,termination,expiration`, `Tus-Max-Size` (= `VOLA_MAX_UPLOAD_BYTES`) |
| `POST /vola/uploads` | `files:write` | `Upload-Length` (required; `Upload-Defer-Length` → `400`; over the limit → `413 file_too_large`) + `Upload-Metadata` (tus base64 pairs): `instance_type`, `instance_id`, `filename` required; `folder_path`, `parent_id`, `slug`, `content_type` (or tus's `filetype`), `metadata` (JSON object) optional → `201`, `Location: /vola/uploads/<id>`, `Upload-Expires`; a zero-length upload completes at once |
| `HEAD /vola/uploads/:id` | `files:write` | `Upload-Offset`, `Upload-Length`, `Upload-Metadata`, `Upload-Expires`, `Cache-Control: no-store`; `Vola-File-Id` once complete; expired → `410 upload_expired` |
| `PATCH /vola/uploads/:id` | `files:write` | `Content-Type: application/offset+octet-stream`, `Upload-Offset` must equal the server's (`409 upload_offset_mismatch`); the body is appended as it streams and the offset is committed only after `fsync`; a parallel PATCH on the same upload → `409 upload_locked` (`SELECT … FOR UPDATE NOWAIT`); a body past `Upload-Length` → `400 upload_overflow`, undone → `204` with the new `Upload-Offset` (+ `Vola-File-Id` when complete) |
| `DELETE /vola/uploads/:id` | `files:write` | removes the row and the partial bytes |

Every request but `OPTIONS` must carry `Tus-Resumable: 1.0.0` (`412` with `Tus-Version`
otherwise). Partial bytes live in `VOLA_STORAGE_PATH/uploads/<id>.part`, as they arrive — no
assumption about chunk sizes, so 6.3 can cut them into fixed 1 MiB segments. An upload not
finished within `VOLA_UPLOAD_TTL_HOURS` (24) is swept, part file and row, every 15 minutes — a
BullMQ repeatable job the worker runs, or a timer in the server process when there is no worker.

### Folders, versions, visibility

Folders are virtual: a hierarchy in the database inside one instance (the blob store stays
flat). A path is `a/b/c` — segments of 1–255 characters without `/`, `\`, NUL or control
characters, never `.` or `..`, at most 32 levels — and a `..` anywhere is `422 validation_error`.
The path is the wildcard of the URL, so a name may carry spaces and Unicode (percent-encoded).

```sh
curl -X POST  -H "Authorization: Bearer $KEY" localhost:8300/vola/folders/tickets/$TICKET/docs/2026   # 201 (200 if it exists); parents are created too
curl          -H "Authorization: Bearer $KEY" localhost:8300/vola/folders/tickets/$TICKET/docs        # {folder, subfolders[], files[]}; no path = the root
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"name":"documents"}' \
     localhost:8300/vola/folders/tickets/$TICKET/docs                                                # descendants follow; {"parent_path":"archive"} moves
curl -X DELETE -H "Authorization: Bearer $KEY" "localhost:8300/vola/folders/tickets/$TICKET/docs?recursive=1"
curl -H "Authorization: Bearer $KEY" -F file=@q4.pdf -F folder_path=docs/2026 localhost:8300/vola/files/tickets/$TICKET
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/path/docs/2026/q4.pdf"
curl -H "Authorization: Bearer $KEY" -F file=@q4-v2.pdf -F parent_id=$FILE localhost:8300/vola/files/tickets/$TICKET  # a new version
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"is_global_public":true}' \
     localhost:8300/vola/files/tickets/$TICKET/$FILE
curl localhost:8300/vola/public/$FILE                                                                 # no key
```

| route | scope | notes |
|---|---|---|
| `POST /vola/folders/:type/:id/*path` | `folders:write` | idempotent; the whole chain of parents |
| `GET /vola/folders/:type/:id[/*path]` | `folders:read` | one level: `folder` (`null` for the root), direct `subfolders` by name, live `files` by name |
| `PATCH /vola/folders/:type/:id/*path` | `folders:write` | `{name}` and/or `{parent_path}` (`""` = root, created when missing); every descendant path is rewritten in one transaction; `409 folder_exists`; into itself → `422` |
| `DELETE /vola/folders/:type/:id/*path` | `folders:write` | soft delete → `{folder, folders, files}`; not empty without `?recursive=1` → `409 folder_not_empty` |

A **version** is an upload with `parent_id`: the new row points at the previous one, inherits its
`filename` and `folder_id` unless given (the same name is no collision against its own chain),
and the previous version stays live — a path download answers the newest file of that name.
`…/versions` lists the chain from any member; purge removes the whole chain.

**Visibility:** `is_public` lets any authenticated tenant download the file (and read `…/info`)
by its `(type, id, fileId)` — the vola-spp rule; everything else stays the owner's.
`is_global_public` opens `GET|HEAD /vola/public/:fileId` to anyone, without a key; an encrypted
file can never get it (`409 encrypted_not_public`). Thumbnails, shares and encryption come with
the later tickets of `docs/PLAN.md`.

## Lookups and translations

`lookups.yaml` at the repository root is the controlled vocabulary (`FileKinds`,
`ProcessingStatuses`, `ProcessingKinds`, `ShareScopes`, `OcrLanguages`, `EncryptionModes`;
UPPER_SNAKE_CASE terms, lower-case wire values), `i18n/translations.csv` its English and
Serbian labels. There is no `InstanceTypes` section: an instance type is a free string of the
caller, and the ones in use come from the database.

```sh
curl localhost:8300/vola/lookups?locale=sr        # no key; en, sr — anything else falls back to en
#   {"locale":"sr","locales":["en","sr"],"lookups":{"FileKinds":[{"term":"IMAGE","value":"image","label":"Slika"},…],…}}
curl -H "Authorization: Bearer vola_live_…" localhost:8300/vola/instance-types   # files:read
#   {"instance_types":[{"instance_type":"tickets","files":12},{"instance_type":"users","files":3}]}
```

A value the vocabulary does not know is never rejected: it is recorded under
`var/candidates/<Section>.yaml` (plus a `translations_candidate.csv` a translator can fill in).
`pnpm vola lookups candidates` lists the queue, `pnpm vola lookup-promote [--dry-run]
[--only FileKinds.WEBP]` appends the terms to `lookups.yaml` (comments kept) and their rows to
the sheet, `pnpm vola lookups validate` checks both. `VOLA_LOOKUPS_PATH`, `VOLA_TRANSLATIONS_PATH`,
`VOLA_CANDIDATES_DIR` and `VOLA_RECORD_CANDIDATES` move or switch this off.

## UDC collections

The way to browse files is [UDC](https://github.com/digital-cube/jsudc) — the same
`@jsudc/server` protocol as JSMemento, mounted under `/vola/udc` behind the API-key auth
(`files:read` for `collections`, `describe`, `list`, `read`; an admin key with `X-Tenant-Slug`;
a refusal is an in-protocol `forbidden` / `validation_error` envelope).

```sh
curl -H "Authorization: Bearer vola_live_…" -H "Content-Type: application/json" \
  localhost:8300/vola/udc/list -d '{
    "collection": "files",
    "filter": {"and": [
      {"field": "instance_type", "op": "eq", "value": "tickets"},
      {"field": "instance_id", "op": "eq", "value": "0192…"},
      {"field": "folder_path", "op": "eq", "value": "docs"},
      {"field": "filename", "op": "contains", "value": "report", "case_insensitive": true}
    ]},
    "sort": [{"field": "created_at", "dir": "desc"}],
    "page": {"limit": 50}
  }'
```

The `files` collection (`packages/server/udc/files/view.yaml` is its view) needs a top-level
`instance_type` filter — without one the list is empty, as in vola-spp — and takes `instance_id`
(optional: an admin's "every id of the type"), `folder_path` (that level only; `""` is the root),
`filename`, `mime_type`, `extension`, `kind`, `size`, `created_at` (`between`, `gt`, …) and
`include_deleted`; it sorts by `created_at`, `filename` or `size` and pages by an opaque cursor
(`next_cursor` → `page.cursor`), with an exact `total`. Rows carry `download_url` and
`thumb_url` (`…/thumb/256`: `200` ready, `202` while the worker renders, `404 no_thumbnail`),
`kind` / `encryption` / `processing_status` as lookup values. An encrypted file shows `filename: "<encrypted>"` and no
MIME type or extension — in rows, filters, sorts and cursors alike — until the phase-6 unlock
puts the real ones back through the `decorateRow` hook of `volaPlugin`. `menu.yaml` is served
as the `menu` collection (the sidebar of the examples site).

### Real-time: `GET /vola/udc/subscribe`

The same rows, live. A WebSocket (`["vola.v1", "bearer.<key>"]` as subprotocols, or the usual
headers; `files:read`) takes `udc.subscribe` messages with a `list`-style filter — a top-level
`instance_type` is required, `instance_id` and `folder_path` narrow it — and pushes
`udc.row.upsert` (the row, exactly as `list` would answer it) and `udc.row.remove` (an id) as
files are uploaded, replaced, moved, renamed, deleted and purged. Every writer publishes an
event after its commit on a `FileEventBus`: Redis pub/sub (`vola:files:<tenant id>`) with
`VOLA_REDIS_URL`, so several server and worker processes share one feed, in-process without.
Only ids travel; the row is read back under the tenant's id and the same masking as `list`.
A client that reads too slowly is closed with `4008` (`VOLA_WS_MAX_BUFFERED`), one that stops
answering pings is terminated (`VOLA_WS_HEARTBEAT_MS`). The protocol and its schemas
(`@vola/core`) are in [docs/REALTIME.md](docs/REALTIME.md).

```js
const ws = new WebSocket("ws://localhost:8300/vola/udc/subscribe", ["vola.v1", `bearer.${key}`]);
ws.onopen = () =>
  ws.send(JSON.stringify({
    kind: "udc.subscribe", id: "ticket-42",
    payload: { collection: "files", filter: { and: [
      { field: "instance_type", op: "eq", value: "tickets" },
      { field: "instance_id", op: "eq", value: "0192…" },
    ] } },
  }));
ws.onmessage = (e) => console.log(JSON.parse(e.data)); // udc.welcome, udc.subscribe.ok, udc.row.upsert …
```

## Container

```sh
docker compose -f docker-compose.yaml up -d --build
curl localhost:8300/vola/health/live    # {"status":"ok"}
curl localhost:8300/vola/health/ready   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}
docker compose -f docker-compose.yaml logs vola-worker   # "vola worker ready"
```

Configuration is environment only, every variable prefixed `VOLA_` — see `.env.example`. The
image carries `lookups.yaml`, `i18n/` and `menu.yaml` under `/app/config` (mount your own over
it) and records lookup candidates under `/data/candidates`. The stack runs two containers from
the image: `vola` (`node dist/server.js`, applies migrations, listens) and `vola-worker`
(`node dist/worker.js`, consumes the BullMQ queue); both mount the same `/data` volume, since
thumbnails are written next to the blobs. The image ships `libvips`, `poppler-utils`
(`pdftoppm`) and `tesseract-ocr` for the worker. Locally: `pnpm dev` and `pnpm dev:worker`.

## License

MIT
