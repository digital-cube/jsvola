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
pnpm vola tenant-set --slug acme --default-encryption tenant   # encrypt uploads that name no mode
pnpm vola transfer --from acme --to beta --instance tickets:<uuid> [--user-map users.json] [--dry-run]

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
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/info            # + ocr: {status, lang, pages, text_preview}
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/$FILE/info?ocr=full"  # + ocr.text, the whole OCR text
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET?limit=50&cursor=…&include_deleted=1"
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE        # soft
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/purge  # → {files, blobs}
```

| route | scope | notes |
|---|---|---|
| `POST /vola/files/:type/:id` | `files:write` | `file` part + optional `metadata`; `folder_path` (created when missing) or `folder_id` places it; `parent_id` makes it a new version; `encryption` field (before the `file` part) or `X-Vola-Encryption` header: `none` / `tenant` — see [Encryption at rest](#encryption-at-rest); `413 file_too_large` over `VOLA_MAX_UPLOAD_BYTES` (512 MiB); `a.pdf` → `a (1).pdf` on a name collision in the same folder |
| `PUT /vola/files/:type/:id/slug/:slug` | `files:write` | upsert of a named file |
| `GET\|HEAD …/:fileId`, `…/slug/:slug`, `…/path/*` | `files:read` | `Accept-Ranges: bytes`, single `Range` → `206`, outside → `416`; `ETag: "<sha256>"`, `If-None-Match` → `304`; `X-Content-Type-Options: nosniff`; `?download=1`; `last_accessed_*` once a minute (GET only); by id also another tenant's `is_public` file. An encrypted file is decrypted segment by segment for the requested range: `ETag: "<file id>"`, `Cache-Control: no-store`, `inline` only for a sniffed raster image; `503 encryption_unavailable` without the key file, `409 vola_integrity` for a damaged blob or key |
| `GET …/:fileId/info` | `files:read` | metadata, never `fk_ct`/`meta_ct` (an encrypted file's real name, type and metadata, decrypted; `503` / `409` as a download); `?include_deleted=1`; the `ocr` block (`status`, `lang`, `pages`, `text_preview` = the first 500 characters), `?ocr=full` adds `ocr.text` — see [OCR](#ocr--tesseract-in-the-worker) |
| `GET …/:fileId/versions` | `files:read` | the version chain, newest first; `?include_deleted=1` |
| `GET /vola/files/:type/:id` | `files:read` | `created_at desc, id desc`, `?cursor`, `?limit` ≤ 200, `?include_deleted=1` |
| `PATCH …/:fileId` | `files:write` | `{folder_path}` moves (`""` = root), `{filename}` renames (`409 file_exists`; an encrypted file's name is re-sealed into `meta_ct`), `{is_public}`, `{is_global_public}` (`409 encrypted_not_public` on an encrypted file) |
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

### OCR — tesseract in the worker

An upload of a raster image (not SVG, not GIF) or a PDF that is not encrypted also queues one
`OCR` job. The worker runs the system `tesseract` on it — an image as it is, a PDF page by page
after `pdftoppm -r 200 -png` rasterised the first `VOLA_OCR_MAX_PAGES` (20) pages, the texts
joined with `\f` — with the languages of `VOLA_OCR_LANGS` (`eng+srp+deu`, every code from the
`OcrLanguages` vocabulary; an unknown one stops the process at start, as does a language the
installed tesseract lacks), `VOLA_OCR_TIMEOUT_S` (120) per page, stdout capped at 10 MiB, the
tools spawned with an argument list (no shell) and the temporary directory always removed. The
result lands in `vola_file_metadata` (`file_id`, `tenant_id`, `ocr_text`, `ocr_lang`,
`ocr_pages`, `ocr_at` and `ocr_tsv`, a `tsvector` generated from the text with the `simple`
configuration under a GIN index), one row per file, gone with the file.

```sh
curl -s -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/info | jq .ocr
# {"status": "DONE", "lang": "eng+srp+deu", "pages": 2, "text_preview": "INVOICE 2026-0042 …"}
curl -s -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/$FILE/info?ocr=full" | jq -r .ocr.text
```

`ocr.status` is the job's (`PENDING` → `RUNNING` → `DONE` | `FAILED` after 3 tries; `SKIPPED`
when the worker cannot run OCR; `null` when no job was created — not eligible, or OCR off); the
rest is `null` until a pass stored its text. The UDC `files` collection carries `ocr` as a yes/no
column and as a filter: `{"field": "ocr", "op": "contains", "value": "invoice 0042"}` is a
full-text search (`plainto_tsquery('simple', …)` over `ocr_tsv`: every word must occur, in any
order, case does not matter, no stemming — the same for every language), `eq true|false` /
`is_not_null` / `is_null` select files with or without text; a live `subscribe` with such a
filter gets the row the moment its text is in (the worker publishes a `processing` event after
every OCR job, as after every thumbnail).

| `VOLA_OCR_ENABLED` | server | worker |
|---|---|---|
| `auto` *(default)* | queues an `OCR` job per eligible upload | runs it when `tesseract --version` succeeded at start; without tesseract one WARN line and every `OCR` job is `SKIPPED` |
| `1` / `true` | the same | refuses to start without tesseract (exit 1, the reason on one line) |
| `0` / `false` | never creates an `OCR` job | skips any it receives |

The Docker image ships `tesseract-ocr` with `eng`, `srp` and `deu`; a worker on another host
needs the same (`apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-srp
tesseract-ocr-deu poppler-utils`). Out of scope here: encrypted files (phase 6.3 runs OCR under
the file key), an AI summary, EXIF.

#### Deployment without a worker (`VOLA_WORKER_ENABLED`)

The worker is a second process of the same image (`node dist/worker.js`, `pnpm start:worker`);
a deployment that does not run one is supported: thumbnails are rendered lazily on `/thumb`
(`200`, the real WebP), nothing is recorded in `vola_processing_job`, OCR does not run (`ocr.status`
stays `null`). That is **not logged as an error** — one INFO line per process, `background jobs disabled`.

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
file can never get it (`409 encrypted_not_public`).

### Encryption at rest

An upload with `encryption=tenant` (the multipart field **before** the `file` part, the
`X-Vola-Encryption` header, the `encryption` pair of a tus `Upload-Metadata`, or the tenant's
default — `vola tenant-set --slug acme --default-encryption tenant`) is stored as a `JSV` blob:
AES-256-GCM in 1 MiB segments under a random **per-file key**, which is itself wrapped under a
key derived from the server's key file and the tenant id (`vola_file.fk_ct`). The row shows
`<id>.bin` / `application/octet-stream` / `kind: other`; the real name, MIME type and `metadata`
are sealed under the file key (`meta_ct`) and come back decrypted in `…/info`, lists, UDC rows
and the `Content-Disposition` of a download. `size` is the plaintext length, `hash` the SHA-256
of the ciphertext — two uploads of the same bytes are two blobs, there is no deduplication of
encrypted files. `Range` works in plaintext coordinates and reads only the segments it needs.
The worker never touches an encrypted file (no thumbnail, no OCR), it cannot be
`is_global_public` or shared with a plain link, and a transfer between tenants re-wraps its key.
`docs/CRYPTO.md` has the format byte by byte, the key hierarchy, what a dump reveals and the
troubleshooting of `503 encryption_unavailable` / `409 vola_integrity`.

```sh
vola keys-generate                 # VOLA_KEY_FILE (default /run/secrets/vola.key), 0600, refuses to overwrite
curl -X POST -H "Authorization: Bearer $KEY" -H "X-Vola-Encryption: tenant" \
  -F file=@secret.pdf "http://localhost:8300/vola/files/tickets/$ID"
vola keys-status                   # files per key line; rotate by PREPENDING a line, old lines retire lazily
```

Without the key file the server starts and serves plain files; anything encrypted answers
`503 encryption_unavailable` until the file is there (no restart needed). `keyring` (a PIN per
principal) and `caller` (a key per request) are phases 6.2 and 6.3 and answer `501` today.

### Share links

A share link gives anyone with its token access to one file or one folder — no API key, no
tenant. Only the SHA-256 of the token is stored (the plaintext is in the `201` once); a password
is stored as argon2id; `expires_at` ends the link, `max_downloads` caps how many downloads may
*start* through it, `DELETE` revokes it. A share of an encrypted file is a share grant (phase
6.3) and is refused here with `409 encrypted_share_requires_grant`.

```sh
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"file_id":"'$FILE'","password":"s3cr3t","expires_at":"2026-12-31T23:59:59Z","max_downloads":3}' \
     localhost:8300/vola/shares                           # 201 {id, token, url, has_password, …}
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"folder":{"instance_type":"tickets","instance_id":"'$TICKET'","path":"docs/2026"}}' \
     localhost:8300/vola/shares                           # a folder share
curl -H "X-Share-Password: s3cr3t" localhost:8300/vola/s/$TOKEN                   # the file; or ?password=
curl localhost:8300/vola/s/$TOKEN                        # a folder share: {kind:"folder", folder, subfolders[], files[]}
curl localhost:8300/vola/s/$TOKEN/path/q4/report.pdf     # a file inside the shared folder, by relative path
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/shares?file_id=$FILE&include_revoked=1"
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/shares/$SHARE    # revoke → 410 from then on
```

| route | scope | notes |
|---|---|---|
| `POST /vola/shares` | `shares:write` | `{file_id \| folder: {instance_type, instance_id, path}, password?, expires_at?, max_downloads?, scope?}` → `201` with `token` and `url` (`VOLA_PUBLIC_URL`, or the request's origin); `scope` other than `PUBLIC_LINK` → `501 not_implemented`; encrypted file → `409`; another tenant's target → `404` |
| `GET /vola/shares[?file_id=\|folder_id=][&include_revoked=1]`, `GET /vola/shares/:id` | `shares:write` | newest first, never the token |
| `DELETE /vola/shares/:id` | `shares:write` | revoke, idempotent |
| `GET\|HEAD /vola/s/:token` | — | file share: the download (`Range`, `ETag`, `Content-Disposition`, `?download=1`); folder share: one level as JSON, paths relative to the shared folder |
| `GET\|HEAD /vola/s/:token/path/*` | — | a file (or the listing of a subfolder) inside a shared folder; never outside it (`..` → `422`) |

Answers: unknown token `404 share_not_found`; revoked or expired `410 share_gone`; password
missing or wrong `401 share_password_required` — ten wrong ones per token in fifteen minutes
(Redis-shared when `VOLA_REDIS_URL` is set, per process otherwise) → `429
too_many_password_attempts` with `retry_after`, the right password included until the window
ends. **Counting:** only a request that starts a download counts — a `GET` without `Range` or
with a `Range` from byte 0 — through an atomic `UPDATE … WHERE download_count < max_downloads`,
so two readers cannot both take the last one. `HEAD` and a `Range` continuation never count,
and once the limit is reached they still answer (the last granted download can be resumed)
while starting another is `410`. The limit counts downloads, not bytes. Every share answer
carries `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`; an encrypted
file inside a shared folder is invisible to the share.

### Statistics

```sh
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/stats/tenant?recompute=1"
#   {"scope":"tenant","total_files":42,"total_bytes":…,"by_kind":{"image":30,"document":12},"oldest_at":…,"newest_at":…,"computed_at":…}
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/stats/instance/tickets/$TICKET
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/stats/storage
#   {"scope":"tenant","files":42,"logical_bytes":…,"unique_blobs":40,"unique_bytes":…,"physical":null,…}
curl -H "Authorization: Bearer $ADMIN" localhost:8300/vola/stats/storage       # scope "deployment" + physical {blobs, derived, uploads}
```

| route | scope | notes |
|---|---|---|
| `GET /vola/stats/tenant[?recompute=1]` | `files:read` | the tenant's live files (soft-deleted ones never count): `total_files`, `total_bytes` (before deduplication), `by_kind`, `oldest_at`, `newest_at`, `computed_at` |
| `GET /vola/stats/instance/:type/:id[?recompute=1]` | `files:read` | the same for one instance |
| `GET /vola/stats/storage` | `files:read` | logical bytes, distinct blobs and their bytes; an admin key adds `physical` (the disk: `blobs`, `derived`, `uploads`) and without `X-Tenant-Slug` measures the whole deployment |

The tenant and instance numbers are **snapshots** in `vola_tenant_stats`: computed on the first
read, forced with `?recompute=1`, and refreshed by the worker's repeatable `refresh-stats` job
for snapshots older than `VOLA_STATS_TTL_MIN` (60) whose tenant had file activity since (the
job runs every half TTL). Without a worker a read past the TTL recomputes instead.

### Admin transfer — moving instances between tenants

When the host application moves an entity between tenants (thilo moves a project, with its
tickets, from one workspace to another), its files follow through one admin call. Rows move,
blobs stay on disk (they are content-addressed and shared). Everything of the listed instances
goes: every file row (every version, the soft-deleted ones too), the folders, the share links
(same tokens, so a public link keeps working), the processing jobs and OCR metadata, the
finished resumable uploads. Statistics of both tenants are recomputed afterwards and live
subscribers of both tenants are told (`purged` on the source, `created` on the destination).

```sh
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
     -d '{"from_tenant":"acme","to_tenant":"beta","instances":[{"instance_type":"tickets","instance_id":"'$TICKET'"}],
          "user_map":{"alice@acme":"u-17"},"dry_run":true}' \
     localhost:8300/vola/admin/transfer
#   {"from_tenant":"acme","to_tenant":"beta","instances":1,"files":12,"folders":3,"merged_folders":1,"shares":2,"jobs":40,"metadata":4,"uploads":0,"dry_run":true}
pnpm vola transfer --from acme --to beta --instance tickets:$TICKET --instance tickets:$OTHER --user-map users.json --dry-run
```

| route | scope | notes |
|---|---|---|
| `POST /vola/admin/transfer` | `admin` (an admin key; a tenant key is `403`; `X-Tenant-Slug` is ignored) | `{from_tenant, to_tenant, instances: [{instance_type, instance_id}], user_map?: {old: new}, dry_run?}` → the counts; `404 tenant_not_found` for either slug (the destination must exist); a `tenant`-encrypted file's key is re-wrapped for the destination in the same transaction (`503 encryption_unavailable` without `VOLA_KEY_FILE`, `409 vola_integrity` for a key that does not open); `409 encrypted_transfer_unsupported` when an instance holds a `keyring` / `caller` file (phases 6.2 / 6.3); `409 uploads_in_progress` when a resumable upload of the instance is still running (finish, delete or let it expire first); `422` for the same tenant twice or no instances |

Rules: a folder whose path already exists for the same instance on the destination is
**merged** into that folder (its files, subfolders and share links re-pointed, the source row
removed), never duplicated; a **live** source folder revives a **deleted** destination folder
it merges into, so its files do not land in the bin. `user_map` rewrites `created_by`,
`deleted_by` and `last_accessed_by` of files, `created_by` / `deleted_by` of folders and
`created_by` of share links; a user with no mapping stays. The whole call is **one
transaction** (every instance moves or none does) and is **idempotent** — a repeated call finds
nothing on the source and reports zeros. `dry_run` runs the same statements and rolls them
back: the same counts, nothing written. Only the listed instances move; a file that belongs
to another instance (thilo: a user's board background lives under the *user*) stays where it
is unless listed. The CLI form `vola transfer` does the same against the database directly.

### Audit trail (memento, optional)

With `VOLA_MEMENTO_URL` + `VOLA_MEMENTO_API_KEY` (a memento key with the `write` scope) every
destructive or security-relevant operation becomes a memento event — `VOLA_FILE_DELETED`,
`VOLA_FILE_PURGED`, `VOLA_FILE_VISIBILITY_CHANGED`, `VOLA_SHARE_CREATED`,
`VOLA_SHARE_REVOKED`, `VOLA_KEY_CREATED`, `VOLA_KEY_REVOKED`, `VOLA_INSTANCES_TRANSFERRED` —
with `actor_id` = `X-User-Id` or `key:vola_live…k3Qz`, and a payload of ids, size, MIME type
and the tenant slug: never a token, a password, a key, nor the name of an encrypted file.
Delivery is an `audit` BullMQ job the worker pushes with five tries when Redis is there, one
fire-and-forget push otherwise; a request never waits for memento and never fails because of
it. Without the two variables the audit is off, logged once at INFO. Event catalogue, payloads
and the memento-side vocabulary and templates: [`docs/AUDIT.md`](docs/AUDIT.md).

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
`filename`, `mime_type`, `extension`, `kind`, `size`, `created_at` (`between`, `gt`, …),
`include_deleted` and `ocr` (`contains <words>`: a full-text search of the OCR text, see
[OCR](#ocr--tesseract-in-the-worker)); it sorts by `created_at`, `filename` or `size` and pages by
an opaque cursor (`next_cursor` → `page.cursor`), with an exact `total`. Rows carry `download_url`
and `thumb_url` (`…/thumb/256`: `200` ready, `202` while the worker renders, `404 no_thumbnail`),
`kind` / `encryption` / `processing_status` as lookup values and `ocr` (yes/no: text was extracted). An encrypted file's
row carries its real `filename`, `mime_type`, `extension` and `kind` when the server holds the key
(`tenant` mode, `VOLA_KEY_FILE` present) and `filename: "<encrypted>"` with no MIME type or
extension otherwise; **filters, sorts and cursors always see the mask** (the real name is never
in SQL). The `decorateRow` hook of `volaPlugin` runs after that (the phase-6.2 unlock). `menu.yaml`
is served as the `menu` collection (the sidebar of the examples site).

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
(`pdftoppm`) and `tesseract-ocr` (`eng`, `srp`, `deu`) for the worker. Locally: `pnpm dev` and
`pnpm dev:worker`.

## License

MIT
