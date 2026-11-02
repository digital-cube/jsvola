# JSVola HTTP API (v1.0)

Every route of `@vola/server`: method, path, scope, body, answers and error codes. Base path:
`/vola` (`VOLA_PREFIX`). Every example below assumes `localhost:8300` and `$KEY`, an API key of
the tenant (see [Authentication](#authentication)). The Zod schemas of every body and answer
live in [`@vola/core`](../packages/core/src) and are named in each section; a client that wants
the same types without hand-written requests uses [`@vola/client`](../packages/client/README.md).

How things fit together (packages, upload flow, CAS layout, worker, events):
[ARCHITECTURE.md](ARCHITECTURE.md). Encryption byte by byte: [CRYPTO.md](CRYPTO.md). The
WebSocket protocol of `/udc/subscribe`: [REALTIME.md](REALTIME.md). Coming from vola-spp:
[MIGRATION-FROM-VOLA-SPP.md](MIGRATION-FROM-VOLA-SPP.md).

Contents: [Authentication](#authentication) · [Errors](#errors) · [Headers](#headers-and-query-parameters) ·
[Health](#health) · [API keys](#api-keys) · [Files](#files) · [Download: Range, HEAD, ETag](#download-range-head-etag) ·
[Thumbnails and the 202](#thumbnails--get-thumbsize-answers-202-too) · [OCR](#ocr) ·
[Resumable uploads (tus)](#resumable-uploads-tus-10) · [Folders](#folders) · [Versions and visibility](#versions-and-visibility) ·
[Encryption on the wire](#encryption-on-the-wire) · [Keyrings](#keyrings) · [Share links and grants](#share-links) ·
[Statistics](#statistics) · [Admin transfer](#admin-transfer) · [Lookups and instance types](#lookups-and-instance-types) ·
[UDC collections](#udc-collections) · [Real-time](#real-time-get-udcsubscribe) · [Examples site routes](#the-examples-sites-routes) ·
[OpenAPI](#openapi)

## Authentication

Every route except the health probes, `GET /lookups`, `OPTIONS /uploads`, the public share and
public file routes, `POST /keyrings/me/unlock/close` and `GET /examples/config` needs an API
key, sent one of three ways:

```
Authorization: Bearer vola_live_…
X-Api-Key: vola_live_…
Sec-WebSocket-Protocol: vola.v1, bearer.vola_live_…      (the WebSocket)
```

A key is `vola_live_…`, `vola_test_…` (a tenant key) or `vola_admin_…` (an admin key); only its
SHA-256 is stored, the plaintext is printed once by `vola create-key` / `POST /keys`. A tenant
key belongs to one tenant and holds **scopes**; an admin key belongs to no tenant and selects
one per request with `X-Tenant-Slug`.

| scope | allows |
|---|---|
| `files:read` | downloads, `info`, lists, versions, thumbnails, stats, instance types, UDC reads and `subscribe` |
| `files:write` | uploads (multipart, slug, resumable), `PATCH`, delete, purge, UDC writes |
| `folders:read` | `GET /folders/…` |
| `folders:write` | `POST` / `PATCH` / `DELETE /folders/…` |
| `shares:write` | create, list and revoke share links |
| `keys:write` | `POST` / `GET /keys`, `DELETE /keys/:id` — a key may only grant scopes its creator holds |
| `keyrings:write` | every `/keyrings/me/…` route |
| `encryption:caller` | sending `X-Vola-Content-Key` (the `caller` encryption mode) |
| `admin` | an admin key: everything above for the tenant named in `X-Tenant-Slug`, plus `POST /admin/transfer`, `/keyrings/by-principal/…`, the deployment-wide `GET /stats/storage`, `POST /examples/purge` |

`X-User-Id` names the **principal** of the host application (at most 255 characters): recorded
as `created_by` / `deleted_by` / `last_accessed_by`, the actor of audit events, and the owner
of a [keyring](#keyrings). It is optional everywhere except the keyring routes
(`400 user_required`).

| answer | when |
|---|---|
| `401 unauthorized` | no key, an unknown key, a revoked or expired one — one message for every case |
| `403 forbidden` + `required: [scope…]` | the key lacks a scope the route needs |
| `404 tenant_not_found` | an admin key named an unknown tenant in `X-Tenant-Slug` |
| `400 tenant_required` | an admin key on a tenant route without `X-Tenant-Slug` |

Every answer carries `X-Request-Id` (yours when you sent one, a UUID otherwise). An admin key
may do everything a tenant key may, for the tenant it names.

## Errors

```json
{ "error": { "code": "file_not_found", "message": "file not found" } }
```

Codes are snake_case and stable; some answers add fields next to `code` and `message` (`required`,
`attempts`, `retry_after`, `reason`). The envelope schema is `ErrorResponseSchema`.

| HTTP | code | where |
|---|---|---|
| 400 | `bad_request` | malformed JSON, a bad header, an unknown query value |
| 400 | `file_required` | a multipart upload without a `file` part |
| 400 | `invalid_size`, `invalid_crop` | `/thumb/:size?crop=` |
| 400 | `tenant_required` | an admin key without `X-Tenant-Slug` on a tenant route |
| 400 | `user_required` | a keyring route without `X-User-Id` |
| 400 | `upload_overflow` | a tus `PATCH` body past `Upload-Length` |
| 400 | `caller_key_from_browser` | `X-Vola-Content-Key` together with an `Origin` header |
| 401 | `unauthorized` | the API key |
| 401 | `share_password_required`, `share_secret_required` | a share link |
| 403 | `forbidden` | a missing scope (`required`), a tenant key on an admin route |
| 403 | `pin_wrong`, `recovery_wrong` | keyrings |
| 403 | `demo_forbidden` | the examples write proxy on something the visitor does not own |
| 404 | `file_not_found`, `folder_not_found`, `upload_not_found`, `share_not_found`, `keyring_not_found`, `tenant_not_found`, `not_found` | another tenant's row is `404`, never `403` |
| 404 | `no_thumbnail` | a file that has no thumbnail by nature |
| 409 | `file_exists`, `folder_exists`, `folder_not_empty` | names and folders |
| 409 | `upload_completed`, `upload_offset_mismatch`, `upload_locked`, `uploads_in_progress` | resumable uploads |
| 409 | `encrypted_not_public`, `encrypted_share_requires_grant`, `encrypted_transfer_unsupported`, `client_opaque` | what an encrypted file cannot do |
| 409 | `vola_integrity` | "The file could not be decrypted." — a wrong key or secret, or damaged bytes ([CRYPTO.md § 7](CRYPTO.md#7-troubleshooting)) |
| 409 | `keyring_exists` | `POST /keyrings/me` twice |
| 410 | `share_gone` | a revoked or expired share |
| 410 | `upload_expired`, `upload_lost` | a swept upload; an encrypted upload whose sealed state does not match |
| 412 | *(tus)* | `Tus-Resumable` missing or not `1.0.0`; the answer carries `Tus-Version` |
| 413 | `file_too_large` | over `VOLA_MAX_UPLOAD_BYTES` (512 MiB), on multipart and on tus creation |
| 415 | `unsupported_media_type` | a JSON route without `Content-Type: application/json`; the examples proxy's type list |
| 416 | `range_not_satisfiable` | a `Range` outside the file |
| 422 | `validation_error` | a body or path the schema refuses; `details` lists the Zod issues |
| 422 | `pin_invalid` (`reason: length \| digits \| trivial`), `client_blob_invalid` | keyrings; a `client` blob |
| 423 | `vola_locked` | a `keyring` file without a usable `X-Vola-Unlock`, a `caller` file without `X-Vola-Content-Key` |
| 429 | `too_many_attempts` | a keyring in lock-out; `Retry-After` and `retry_after` |
| 429 | `too_many_password_attempts` | ten wrong share passwords per token in fifteen minutes |
| 429 | `demo_rate_limited` | the examples write proxy, per address |
| 500 | `internal_error`, `blob_missing`, `blob_not_removed` | a row whose blob is gone from disk; a reset that could not remove a blob |
| 501 | `not_implemented` | a share `scope` other than `PUBLIC_LINK` |
| 503 | `encryption_unavailable` | no key file, pepper file or Redis for the encryption mode asked ([CRYPTO.md § 7](CRYPTO.md#7-troubleshooting)) |
| 503 | `service_unavailable` | `/health/ready` with a failing check |

## Headers and query parameters

The names are constants of `@vola/core` (`USER_ID_HEADER`, `UNLOCK_HEADER`, …).

| | direction | meaning |
|---|---|---|
| `Authorization: Bearer`, `X-Api-Key` | request | the API key |
| `X-Tenant-Slug` | request | the tenant an admin key acts for |
| `X-User-Id` | request | the principal of the host application |
| `X-Vola-Encryption` | request | the encryption mode of an upload (`none`, `tenant`, `keyring`, `caller`); the alternative to the `encryption` multipart field |
| `X-Vola-Encryption` | response | the mode of a downloaded encrypted file |
| `X-Vola-Unlock` | request | a keyring unlock token |
| `X-Vola-Content-Key` | request | the 32-byte key (base64) of a `caller` file |
| `X-Share-Password`, `?password=` | request | the password of a share link |
| `X-Share-Secret` | request | the secret (`#…` of the link) of a share grant |
| `X-Thumbnail-Status` | response | `ready`, `generating`, `failed` |
| `Vola-File-Id` | response | the file a resumable upload became (or will become) |
| `X-Request-Id` | both | correlation id |
| `Tus-Resumable`, `Upload-Length`, `Upload-Offset`, `Upload-Metadata`, `Upload-Expires`, `Tus-Version`, `Tus-Extension`, `Tus-Max-Size` | both | [tus 1.0](https://tus.io/protocols/resumable-upload) |
| `?download=1` | request | `Content-Disposition: attachment` |
| `?include_deleted=1` | request | lists, `info`, versions: soft-deleted rows too |
| `?include_revoked=1` | request | `GET /shares` |
| `?recursive=1` | request | `DELETE /folders/…` |
| `?recompute=1` | request | `GET /stats/…` |
| `?ocr=full` | request | `…/info` with the whole OCR text |
| `?locale=en\|sr` | request | `GET /lookups` |
| `?crop=cover\|fit\|attention` | request | `/thumb/:size` |
| `?cursor=`, `?limit=` | request | lists |

## Health

| route | auth | answer |
|---|---|---|
| `GET /health/live` | none | `200 {"status":"ok"}` — the process is up (`LiveResponseSchema`) |
| `GET /health/ready` | none | `200 {"status":"ok","checks":{"database":"ok","redis":"ok"}}` or `503 {"status":"fail", …}`; `redis` only with `VOLA_REDIS_URL` (`ReadyResponseSchema`) |

```sh
curl localhost:8300/vola/health/live
curl localhost:8300/vola/health/ready
```

## API keys

Scope `keys:write`. The CLI does the same against the database (`vola create-key`,
`vola list-keys`, `vola revoke-key`, [CLI.md](CLI.md)); admin keys are made with the CLI only.

| route | body → answer |
|---|---|
| `POST /keys` | `{name, scopes: [tenant scope…], env: "live" \| "test", expires_at?}` (`ApiKeyCreateSchema`) → `201` `ApiKeyCreatedSchema`: the key row plus `key`, the plaintext, **this once**; `403` when a scope asked is not held by the caller (`a key may only grant scopes its creator holds`) |
| `GET /keys` | `ApiKeyListSchema`: the tenant's keys — id, `prefix`, `last4`, name, scopes, dates, `revoked_at`; never the plaintext or the hash |
| `DELETE /keys/:id` | revoke, idempotent → the revoked key row (`revoked_at` set); another tenant's key is `404` |

```sh
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/keys
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"name":"ci","scopes":["files:read"],"env":"test"}' localhost:8300/vola/keys
curl -H "X-Api-Key: $ADMIN" -H "X-Tenant-Slug: acme" localhost:8300/vola/keys
```

## Files

Files hang off an **instance** of the host application: `(instance_type, instance_id)`, e.g.
`tickets/<uuid>`. `instance_type` is `[a-z][a-z0-9_]*`, `instance_id` a UUID
(`InstanceTypeSchema`). Bytes are stored content-addressed, so the same content uploaded twice is
one blob ([ARCHITECTURE.md](ARCHITECTURE.md#cas-layout)). Every row is tenant-scoped: another
tenant's file is `404 file_not_found`, never `403`.

A file's answer is `FileInfoSchema` (`…/info` adds the `ocr` block: `FileDetailSchema`):

```json
{
  "id": "0192…", "tenant_id": "7a3e…", "instance_type": "tickets", "instance_id": "5c1b…",
  "filename": "report.pdf", "extension": "pdf", "size": 48213, "mime_type": "application/pdf",
  "kind": "document", "hash": "9f2a…", "slug": null, "folder_id": null, "parent_id": null,
  "is_public": false, "is_global_public": false,
  "encryption": "none", "enc_format": null, "keyring_id": null, "metadata": {"source": "scan"},
  "processing_status": "PENDING",
  "created_at": "2026-11-01T10:00:00.000Z", "created_by": "user-42", "updated_at": "2026-11-01T10:00:00.000Z",
  "deleted_at": null, "deleted_by": null, "last_accessed_at": null, "last_accessed_by": null
}
```

| route | scope | notes |
|---|---|---|
| `POST /files/:type/:id` | `files:write` | multipart: the `file` part + optional `metadata` (a JSON object), `folder_path` (created when missing) or `folder_id`, `parent_id` (a new [version](#versions-and-visibility)), `encryption` (**before** the `file` part) — see [Encryption on the wire](#encryption-on-the-wire); → `201` with the file info; `413 file_too_large` over `VOLA_MAX_UPLOAD_BYTES` (512 MiB); `a.pdf` → `a (1).pdf` on a name collision in the same folder; `400 file_required` without the part |
| `PUT /files/:type/:id/slug/:slug` | `files:write` | upsert of a **named** file (`SlugSchema`: `[a-z0-9][a-z0-9_-]*`, ≤ 100): the previous live file of that slug is soft-deleted in the same transaction → `201` |
| `GET\|HEAD /files/:type/:id/:fileId` | `files:read` | the bytes — [Download](#download-range-head-etag); by id also another tenant's `is_public` file |
| `GET\|HEAD /files/:type/:id/slug/:slug` | `files:read` | the live file of that slug |
| `GET\|HEAD /files/:type/:id/path/*` | `files:read` | the newest live file of that name in that folder path (`docs/2026/q4.pdf`) |
| `GET /files/:type/:id/:fileId/info` | `files:read` | the metadata, never `fk_ct` / `meta_ct`; an encrypted file's real name, type and metadata, decrypted (`503` / `409` / `423` as a download); `?include_deleted=1`; the `ocr` block, `?ocr=full` — [OCR](#ocr) |
| `GET /files/:type/:id/:fileId/versions` | `files:read` | the version chain from any member, newest first (`FileVersionsSchema`); `?include_deleted=1` |
| `GET /files/:type/:id` | `files:read` | the instance's live files, `created_at desc, id desc`; `?cursor=` (opaque, from `next_cursor`), `?limit=` ≤ 200 (default 50), `?include_deleted=1` (`FileListSchema`) |
| `PATCH /files/:type/:id/:fileId` | `files:write` | JSON `FilePatchSchema`: `{folder_path}` moves (`""` = the root; created when missing), `{filename}` renames (`409 file_exists`; an encrypted file's name is re-sealed), `{is_public}`, `{is_global_public}` (`409 encrypted_not_public` on an encrypted file) → the file info |
| `DELETE /files/:type/:id/:fileId` | `files:write` | soft delete (`deleted_at`, `deleted_by`), idempotent → the file info |
| `DELETE /files/:type/:id/:fileId/purge` | `files:write` | removes the row and its whole version chain → `{files, blobs}` (`PurgeResultSchema`); a blob and its derived files leave the disk only when no row of any tenant references them |
| `GET\|HEAD /files/:type/:id/:fileId/thumb/:size` | `files:read` | [Thumbnails](#thumbnails--get-thumbsize-answers-202-too) |
| `GET\|HEAD /public/:fileId` | none | anonymous download of an `is_global_public` file (`Cache-Control: public, max-age=300`); anything else is `404` |

```sh
# upload (multipart, streamed) → 201 with the file info
curl -H "Authorization: Bearer $KEY" -F file=@report.pdf -F 'metadata={"source":"scan"}' \
     localhost:8300/vola/files/tickets/$TICKET
# a named file: PUT upserts, the previous `avatar` is soft-deleted in the same transaction
curl -X PUT -H "Authorization: Bearer $KEY" -F file=@me.png localhost:8300/vola/files/users/$USER/slug/avatar
# metadata, list, versions
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/info
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET?limit=50&include_deleted=1"
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/versions
# move, rename, visibility
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"folder_path":"archive/2026","filename":"report-final.pdf"}' localhost:8300/vola/files/tickets/$TICKET/$FILE
# delete (soft) and purge
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/purge   # → {"files":1,"blobs":1}
```

MIME is detected from the magic bytes (`file-type`), then the extension, then the declared type;
`kind` (`image`, `video`, `audio`, `document`, `spreadsheet`, `presentation`, `archive`, `text`,
`code`, `other` — the `FileKinds` vocabulary) follows from it. `processing_status` is the
aggregate of the file's background jobs, worst first — `FAILED` > `RUNNING` > `PENDING` > `DONE`,
`SKIPPED` ignored — and `null` when no job was ever created for it (a text file, or a deployment
without a worker). Every write publishes a file event for live subscribers
([Real-time](#real-time-get-udcsubscribe)).

## Download: Range, HEAD, ETag

`GET` and `HEAD` on `…/:fileId`, `…/slug/:slug`, `…/path/*`, `/public/:fileId` and `/s/:token`
share one sender (`routes/send-file.ts`):

| | plain file | encrypted file |
|---|---|---|
| `Accept-Ranges` | `bytes` | `bytes` |
| `Range: bytes=a-b`, `bytes=a-`, `bytes=-n` | one range → `206` + `Content-Range: bytes a-b/size`; outside the file → `416 range_not_satisfiable` + `Content-Range: bytes */size`; several ranges → the first is served | the same, in **plaintext** coordinates; only the segments the range touches are read and decrypted |
| `HEAD` | the same headers as `GET`, no body, never counts as a download, never touches `last_accessed_*` | the same |
| `ETag` | `"<sha256 of the bytes>"`; `If-None-Match` → `304` | `"<file id>"` |
| `Cache-Control` | `private, no-cache` (`/public`: `public, max-age=300`) | `no-store` |
| `Content-Disposition` | `inline` for raster images (not SVG), video, audio, PDF; `attachment` otherwise; `?download=1` forces `attachment`; `filename*=UTF-8''…` always | `inline` only for a PNG / JPEG / GIF / WebP the **bytes** identified; the decrypted name |
| `Content-Type` | the detected MIME; `X-Content-Type-Options: nosniff` always | the real type from the sealed metadata; a `client` blob is `application/octet-stream` with `Range` in ciphertext bytes |
| `last_accessed_at/by` | written on `GET` at most once a minute per file | the same |

```sh
curl -I -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE        # HEAD: size, type, ETag
curl -H "Authorization: Bearer $KEY" -H "Range: bytes=0-1023" localhost:8300/vola/files/tickets/$TICKET/$FILE   # 206
curl -H "Authorization: Bearer $KEY" -H 'If-None-Match: "<etag>"' localhost:8300/vola/files/tickets/$TICKET/$FILE  # 304
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/$FILE?download=1" -o report.pdf
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/users/$USER/slug/avatar
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/path/docs/2026/q4.pdf"
```

A `<video>` / `<audio>` element and a PDF viewer work directly against these URLs (`206`,
`Accept-Ranges`); the examples site's *Range & streaming* page shows it.

## Thumbnails — `GET …/thumb/:size` answers **202** too

An upload of a raster image (not SVG) or a PDF queues four `THUMBNAIL` jobs (64, 128, 256,
512, crop `cover`) for the worker, which renders them with [sharp](https://sharp.pixelplumbing.com/)
— EXIF orientation applied, WebP quality 80, the first page of a PDF through `pdftoppm -r 72`
— and stores each next to the blob as `thumb-<size>-<crop>.webp`: shared by every file of every
tenant with that content, gone with the blob on purge.

| route | scope | notes |
|---|---|---|
| `GET\|HEAD /files/:type/:id/:fileId/thumb/:size?crop=` | `files:read` | WebP; `size` 64 / 128 / 256 / 512 (`400 invalid_size`), `crop` `cover` (default) / `fit` / `attention` (`400 invalid_crop`); `404 no_thumbnail` for anything but a raster image or PDF (text, video, SVG, a `client` blob) |

`/thumb/:size` takes the rendering off the request path, so there are two outcomes a client
MUST tell apart:

| status | body | headers | meaning |
|---|---|---|---|
| `200` | the WebP thumbnail | `X-Thumbnail-Status: ready`, `Cache-Control: private, max-age=86400`, `ETag` (`304` on `If-None-Match`) | cache hit |
| `202` | a **grey placeholder** (~50 B) | `X-Thumbnail-Status: generating`, `Cache-Control: no-cache`, no `ETag` | cache miss; the job is queued (or refreshed) for the worker — retry |

> **Trap:** `202` is a *success* status. It passes `raise_for_status()` (httpx/requests) and
> `response.ok` (fetch), so the placeholder looks like a valid thumbnail unless you check for it
> explicitly.

Rules for consumers (the same rules vola-spp's README stated; nothing changed here):

1. **Branch on the status code, not on an exception** — `status !== 202` is the only reliable
   test that the bytes are a real thumbnail (`X-Thumbnail-Status: generating` is the equivalent
   signal).
2. **Never cache a 202 body under a key derived from the content** (hash, checksum, ETag). Such a
   key never invalidates, so the grey square outlives the real thumbnail — in the browser's HTTP
   cache and in any in-memory / object-URL cache alike. A `202` carries no `ETag` for that reason.
3. **If you proxy a thumbnail onwards**, pass the status and `no-cache` through; do not repackage
   a 202 body into your own `max-age` + `ETag` answer.
4. **Retry** — the worker usually fills the cache within about a second; the next request is a
   `200`. Back off (1 s, 2 s, 4 s …) rather than hammering.

Two more answers: a file that cannot be rendered (broken bytes, `pdftoppm` missing) is `200` with
the grey placeholder, `X-Thumbnail-Status: failed` and `no-cache` — its jobs are `FAILED` after 3
tries and `processing_status` says so. If the queue cannot be reached, or the deployment runs
without a worker (`VOLA_WORKER_ENABLED=0`), the server renders inline and answers `200` — the
worker is an optimisation, not a requirement. The worker publishes a `processing` event after
every job, so a live `files` list sees `processing_status` move without polling.

An **encrypted** file's thumbnail is a sealed sibling under the file key ([CRYPTO.md § 11](CRYPTO.md#11-thumbnails-and-ocr-of-encrypted-files-phase-63)):
`200` decrypted, `Cache-Control: no-store`, an `ETag` of the file id; `202` only for a `tenant`
file the worker is rendering; a `keyring` / `caller` file renders inline in the request that
holds the key (`423` without it); `404 no_thumbnail` above `VOLA_ENC_INLINE_DERIVE_MAX_BYTES`.

```sh
curl -s -o thumb.webp -w '%{http_code} %header{x-thumbnail-status}\n' -H "Authorization: Bearer $KEY" \
     "localhost:8300/vola/files/tickets/$TICKET/$FILE/thumb/256?crop=fit"
# 202 generating   → retry;   200 ready   → thumb.webp is the image
```

## OCR

An upload of a raster image (not SVG, not GIF) or a PDF that is not encrypted also queues one
`OCR` job (`VOLA_OCR_ENABLED`, [DEPLOYMENT.md](DEPLOYMENT.md#ocr)). The worker runs the system
`tesseract` — an image as it is, a PDF page by page after `pdftoppm -r 200 -png` rasterised the
first `VOLA_OCR_MAX_PAGES` (20) pages, the texts joined with `\f` — with the languages of
`VOLA_OCR_LANGS` (`eng+srp+deu`). The result lands in `vola_file_metadata` (`ocr_text`,
`ocr_lang`, `ocr_pages`, `ocr_at`, and `ocr_tsv`, a `tsvector` under a GIN index).

| | |
|---|---|
| `GET …/:fileId/info` | `ocr: {status, lang, pages, text_preview}` (`OcrInfoSchema`) — `text_preview` is the first 500 characters |
| `GET …/:fileId/info?ocr=full` | adds `ocr.text`, the whole text |
| UDC `files` filter `{"field":"ocr","op":"contains","value":"invoice 0042"}` | a full-text search (`plainto_tsquery('simple', …)`: every word must occur, any order, case-insensitive, no stemming); `eq true\|false`, `is_null`, `is_not_null` select files with or without text |

```sh
curl -s -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/info | jq .ocr
# {"status":"DONE","lang":"eng+srp+deu","pages":2,"text_preview":"INVOICE 2026-0042 …"}
curl -s -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/$FILE/info?ocr=full" | jq -r .ocr.text
```

`ocr.status` is the job's (`PENDING` → `RUNNING` → `DONE` | `FAILED` after 3 tries; `SKIPPED`
when the worker cannot run OCR; `null` when no job was created — not eligible, or OCR off). A
`tenant`-encrypted file is OCRed by the worker and the text sealed into `ocr_ct` — readable
through `…/info`, **not** in the full-text search; `keyring` / `caller` files get no OCR
([CRYPTO.md § 11](CRYPTO.md#11-thumbnails-and-ocr-of-encrypted-files-phase-63)).

## Resumable uploads (tus 1.0)

`/uploads` speaks [tus 1.0](https://tus.io/protocols/resumable-upload) core with the
`creation`, `termination` and `expiration` extensions, implemented natively (the encrypted
variant cuts the byte stream into sealed segments as it arrives), so
[`tus-js-client`](https://github.com/tus/tus-js-client) works unchanged and `@vola/client`'s
`uploads.resumable()` wraps it. An upload belongs to the tenant: any `files:write` key of it may
resume one; another tenant's is `404`. Completion takes the SAME path as `POST /files` — hash,
dedup, MIME, collision rename, folder, version, slug — and the last `PATCH` answers with
`Vola-File-Id` (so does every `HEAD` after it).

| route | scope | notes |
|---|---|---|
| `OPTIONS /uploads` | none | `Tus-Resumable: 1.0.0`, `Tus-Version: 1.0.0`, `Tus-Extension: creation,termination,expiration`, `Tus-Max-Size` (= `VOLA_MAX_UPLOAD_BYTES`) |
| `POST /uploads` | `files:write` | `Upload-Length` (required; `Upload-Defer-Length` → `400`; over the limit → `413 file_too_large`) + `Upload-Metadata` (tus base64 pairs): `instance_type`, `instance_id`, `filename` required; `folder_path`, `parent_id`, `slug`, `content_type` (or tus's `filetype`), `metadata` (JSON object), `encryption` optional → `201`, `Location: /vola/uploads/<id>`, `Upload-Expires`, and `Vola-File-Id` for an encrypted upload (the id is in every AAD); a zero-length upload completes at once |
| `HEAD /uploads/:id` | `files:write` | `Upload-Offset`, `Upload-Length`, `Upload-Metadata`, `Upload-Expires`, `Cache-Control: no-store`; `Vola-File-Id` once complete; expired → `410 upload_expired` |
| `PATCH /uploads/:id` | `files:write` | `Content-Type: application/offset+octet-stream`, `Upload-Offset` must equal the server's (`409 upload_offset_mismatch`); the body is appended as it streams and the offset is committed only after `fsync`; a parallel PATCH on the same upload → `409 upload_locked`; a body past `Upload-Length` → `400 upload_overflow`, undone → `204` with the new `Upload-Offset` (+ `Vola-File-Id` when complete); an already completed upload → `409 upload_completed` |
| `DELETE /uploads/:id` | `files:write` | removes the row and the partial bytes → `204` |

Every request but `OPTIONS` must carry `Tus-Resumable: 1.0.0` (`412` with `Tus-Version`
otherwise). Partial bytes live in `VOLA_STORAGE_PATH/uploads/<id>.part` as they arrive. An
upload not finished within `VOLA_UPLOAD_TTL_HOURS` (24) is swept, part file and row, every 15
minutes. An encrypted upload (`encryption` in `Upload-Metadata`) needs the owner's
`X-Vola-Unlock` (`keyring`) or the `X-Vola-Content-Key` (`caller`) on **every** PATCH
([CRYPTO.md § 10](CRYPTO.md#10-the-encrypted-resumable-upload-phase-63)); `encryption client` with
a `fk_ct` pair stores a blob the client sealed itself ([CRYPTO.md § 13](CRYPTO.md#13-client-mode--a-blob-the-client-made-phase-63)).

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

```sh
# the same by hand: create, send, check
LOC=$(curl -s -D - -o /dev/null -X POST -H "Authorization: Bearer $KEY" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(stat -c %s video.mp4)" \
  -H "Upload-Metadata: instance_type $(echo -n tickets | base64),instance_id $(echo -n $TICKET | base64),filename $(echo -n video.mp4 | base64)" \
  localhost:8300/vola/uploads | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
curl -s -D - -o /dev/null -X PATCH -H "Authorization: Bearer $KEY" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" --data-binary @video.mp4 "localhost:8300$LOC"
#   HTTP/1.1 204 No Content … Upload-Offset: <size> … Vola-File-Id: <id>
curl -s -I -H "Authorization: Bearer $KEY" -H "Tus-Resumable: 1.0.0" "localhost:8300$LOC"
```

## Folders

Folders are virtual: a hierarchy in the database inside one instance (the blob store stays
flat). A path is `a/b/c` — segments of 1–255 characters without `/`, `\`, NUL or control
characters, never `.` or `..`, at most 32 levels (`FolderPathSchema`) — and a `..` anywhere is
`422 validation_error`. The path is the wildcard of the URL, so a name may carry spaces and
Unicode (percent-encoded).

| route | scope | notes |
|---|---|---|
| `POST /folders/:type/:id/*path` | `folders:write` | idempotent (`201`, `200` when it exists); the whole chain of parents is created → `FolderInfoSchema` |
| `GET /folders/:type/:id[/*path]` | `folders:read` | one level: `folder` (`null` for the root), direct `subfolders` by name, live `files` by name (`FolderListingSchema`) |
| `PATCH /folders/:type/:id/*path` | `folders:write` | JSON `FolderPatchSchema`: `{name}` renames, `{parent_path}` moves (`""` = root, created when missing), `{default_keyring: "me" \| null}` sets the encryption policy ([Keyrings](#keyrings)); every descendant path is rewritten in one transaction; `409 folder_exists`; into itself → `422` |
| `DELETE /folders/:type/:id/*path` | `folders:write` | soft delete → `{folder, folders, files}` counts (`FolderDeleteResultSchema`); not empty without `?recursive=1` → `409 folder_not_empty` |

```sh
curl -X POST  -H "Authorization: Bearer $KEY" localhost:8300/vola/folders/tickets/$TICKET/docs/2026   # 201; parents too
curl          -H "Authorization: Bearer $KEY" localhost:8300/vola/folders/tickets/$TICKET/docs        # {folder, subfolders[], files[]}
curl          -H "Authorization: Bearer $KEY" localhost:8300/vola/folders/tickets/$TICKET             # the root
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"name":"documents"}' \
     localhost:8300/vola/folders/tickets/$TICKET/docs                                                # descendants follow
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"parent_path":"archive"}' \
     localhost:8300/vola/folders/tickets/$TICKET/documents                                           # a move
curl -X DELETE -H "Authorization: Bearer $KEY" "localhost:8300/vola/folders/tickets/$TICKET/archive?recursive=1"
curl -H "Authorization: Bearer $KEY" -F file=@q4.pdf -F folder_path=docs/2026 localhost:8300/vola/files/tickets/$TICKET
```

## Versions and visibility

A **version** is an upload with `parent_id`: the new row points at the previous one, inherits its
`filename` and `folder_id` unless given (the same name is no collision against its own chain),
and the previous version stays live — a path download answers the newest file of that name.
`…/versions` lists the chain from any member; purge removes the whole chain.

```sh
curl -H "Authorization: Bearer $KEY" -F file=@q4-v2.pdf -F parent_id=$FILE localhost:8300/vola/files/tickets/$TICKET
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/versions
```

**Visibility:** `is_public` lets any authenticated tenant download the file (and read `…/info`)
by its `(type, id, fileId)` — the vola-spp rule; everything else stays the owner's.
`is_global_public` opens `GET|HEAD /public/:fileId` to anyone, without a key; an encrypted
file can never get it (`409 encrypted_not_public`).

```sh
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"is_global_public":true}' \
     localhost:8300/vola/files/tickets/$TICKET/$FILE
curl localhost:8300/vola/public/$FILE          # no key
```

## Encryption on the wire

The model, the key hierarchy and the blob format are in [CRYPTO.md](CRYPTO.md); this is what a
client sends and gets back. The mode of an upload is decided, in this order, by: a folder with an
encryption policy (`default_keyring`), the `encryption` multipart field (sent **before** the
`file` part), the `X-Vola-Encryption` header, the `encryption` pair of a tus `Upload-Metadata`,
or the tenant's `default_encryption` (`vola tenant-set --slug acme --default-encryption tenant`).

| mode | the request carries | who can open it | share | thumbnail | OCR |
|---|---|---|---|---|---|
| `none` | — | anyone with `files:read` | link | worker | worker |
| `tenant` | nothing (the server's `VOLA_KEY_FILE`) | the server | grant | worker, sealed | worker, sealed, not searchable |
| `keyring` | `X-Vola-Unlock` (the owner's token) | the owner, while unlocked | grant, made under the owner's unlock | inline in the request, sealed | none |
| `caller` | `X-Vola-Content-Key` (32 B base64, scope `encryption:caller`, never from a browser) | whoever holds the key | only a caller-made grant | inline in the request, sealed | none |
| `client` | `encryption client` + `fk_ct` on `POST /uploads` | the client | no | no | no |

What every encrypted file has in common: the row shows `<id>.bin` / `application/octet-stream` /
`kind: other`; `…/info`, lists and UDC rows show the real name, type and metadata when the
request can open it, `<encrypted>` otherwise; `size` is the plaintext length, `hash` the SHA-256
of the ciphertext (no deduplication); downloads are `no-store` with an `ETag` of the file id
and `X-Vola-Encryption: <mode>`; `Range` works in plaintext coordinates; `is_global_public` is
`409`; a damaged blob or a wrong key is `409 vola_integrity`; a missing key file / pepper file /
Redis is `503 encryption_unavailable`.

```sh
curl -X POST -H "Authorization: Bearer $KEY" -H "X-Vola-Encryption: tenant" \
  -F file=@secret.pdf "localhost:8300/vola/files/tickets/$TICKET"              # 201 … "encryption":"tenant"

KEY_B64=$(openssl rand -base64 32)                                              # caller mode: your key, every time
curl -X POST -H "Authorization: Bearer $KEY" -H "X-Vola-Encryption: caller" -H "X-Vola-Content-Key: $KEY_B64" \
  -F file=@secret.pdf "localhost:8300/vola/files/tickets/$TICKET"
curl -H "Authorization: Bearer $KEY" -H "X-Vola-Content-Key: $KEY_B64" \
  "localhost:8300/vola/files/tickets/$TICKET/$FILE"                             # the bytes; 423 without the key
```

## Keyrings

A **keyring** belongs to a principal of a tenant (the `X-User-Id`) and is locked by a 6-digit
PIN ([CRYPTO.md § 8](CRYPTO.md#8-the-keyring-provider-phase-62)). An unlock is a short-lived token
(`VOLA_UNLOCK_TTL_S`, default 150 s, sliding with every request that carries it) sent in
`X-Vola-Unlock` — never in a URL; without it a keyring file is `423 vola_locked` and lists show
`<encrypted>`. Needs Redis, `VOLA_PEPPER_FILE` and `VOLA_KEY_FILE`; otherwise `503`.

All routes: scope `keyrings:write`, `X-User-Id` required (`400 user_required`).

| route | body → answer | notes |
|---|---|---|
| `GET /keyrings/me/status` | → `{keyring_id, has_pin, locked, unlock_expires_in, locked_until, attempts, pin_set_at}` (`KeyringStatusSchema`) | reads the token of the request **without extending it** |
| `POST /keyrings/me` | `{pin}` → `201 {keyring_id, recovery_key}` (`KeyringCreatedSchema`) | the recovery key **this once** (`K7QM-2P9X-…`, 8 × 4 base32); `409 keyring_exists`; `422 pin_invalid {reason: length \| digits \| trivial}` |
| `PUT /keyrings/me/pin` | `{current_pin, new_pin}` → `204` | files untouched; every token of the principal dies |
| `POST /keyrings/me/recover` | `{recovery_key, new_pin}` → `{keyring_id, recovery_key}` | a **new** recovery key; a wrong key is `403 recovery_wrong` and never counts as a PIN attempt |
| `POST /keyrings/me/unlock` | `{pin}` → `{token, expires_in}` (`UnlockedSchema`) | `403 pin_wrong {attempts, retry_after}`; `429 too_many_attempts` + `Retry-After` while locked out — the right PIN too |
| `DELETE /keyrings/me/unlock` | → `204` | ends the token of `X-Vola-Unlock`; idempotent |
| `POST /keyrings/me/unlock/close` | `{token}` (JSON, or the bare token as `text/plain`) → `204` | **no API key**: the `navigator.sendBeacon` alias — holding the token is the authority, and all it can do is end it |
| `POST /keyrings/me/reset` | `{confirm: "RESET"}` → `{keyring_id, files, blobs}` | the crypto-shred of every file under the keyring, then the keyring; re-authenticating the person is the caller's job |
| `GET /keyrings/me/delete-preview` | → `{keyring_id, files, live_files, bytes}` | counts only, nothing decrypted |
| `GET /keyrings/by-principal/:principal/status`, `POST …/reset` | admin key (`X-Tenant-Slug`) | another principal's status and reset — never an unlock |

Brute force: 1–2 wrong PINs free, 3 → 1 s, 4 → 5 s, 5–9 → 30 s, 10 → 1 h, then doubling;
the counter lives in the row and survives a restart. An **encrypted folder** is a policy:
`PATCH /folders/… {"default_keyring":"me"}` makes every new upload into it (and below) a keyring
file under the caller's keyring; the uploader needs that keyring's token.

```sh
H=(-H "Authorization: Bearer $KEY" -H "X-User-Id: user-42" -H "Content-Type: application/json")
curl -X POST "${H[@]}" -d '{"pin":"135790"}' localhost:8300/vola/keyrings/me                 # 201 {keyring_id, recovery_key}
TOKEN=$(curl -s -X POST "${H[@]}" -d '{"pin":"135790"}' localhost:8300/vola/keyrings/me/unlock | jq -r .token)
curl -X POST -H "Authorization: Bearer $KEY" -H "X-User-Id: user-42" -H "X-Vola-Unlock: $TOKEN" \
     -H "X-Vola-Encryption: keyring" -F file=@diary.txt localhost:8300/vola/files/tickets/$TICKET   # 201 … keyring_id
curl -H "Authorization: Bearer $KEY" -H "X-User-Id: user-42" -H "X-Vola-Unlock: $TOKEN" \
     localhost:8300/vola/files/tickets/$TICKET/$FILE                                           # the bytes; 423 without
curl -X PATCH "${H[@]}" -d '{"default_keyring":"me"}' localhost:8300/vola/folders/tickets/$TICKET/private
curl -X DELETE -H "Authorization: Bearer $KEY" -H "X-User-Id: user-42" -H "X-Vola-Unlock: $TOKEN" \
     localhost:8300/vola/keyrings/me/unlock                                                   # lock
```

## Share links

A share link gives anyone with its token access to one file or one folder — no API key, no
tenant. Only the SHA-256 of the token is stored (the plaintext is in the `201` once); a password
is stored as argon2id; `expires_at` ends the link, `max_downloads` caps how many downloads may
*start* through it, `DELETE` revokes it.

| route | scope | notes |
|---|---|---|
| `POST /shares` | `shares:write` | `ShareCreateSchema`: `{file_id \| folder: {instance_type, instance_id, path}, password?, expires_at?, max_downloads?, scope?, fk_share_ct?}` → `201` `ShareCreatedSchema` with `token` and `url` (`VOLA_PUBLIC_URL`, or the request's origin, + `/vola/s/<token>`); `scope` other than `PUBLIC_LINK` → `501 not_implemented`; another tenant's target → `404`; an encrypted file → a grant (below) |
| `GET /shares[?file_id=\|folder_id=][&include_revoked=1]` | `shares:write` | newest first, never the token (`ShareListSchema`) |
| `GET /shares/:id` | `shares:write` | one share (`ShareInfoSchema`; `encrypted: true` marks a grant) |
| `DELETE /shares/:id` | `shares:write` | revoke, idempotent → the share (`revoked_at` set); a grant's wrapped key is dropped too |
| `GET\|HEAD /s/:token` | none | file share: the download ([Range, HEAD, ETag](#download-range-head-etag), `Content-Disposition`, `?download=1`); folder share: one level as JSON (`SharedFolderListingSchema`: `{kind: "folder", folder, subfolders[], files[]}`), paths relative to the shared folder |
| `GET\|HEAD /s/:token/path/*` | none | a file (or the listing of a subfolder) inside a shared folder; never outside it (`..` → `422`) |

```sh
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"file_id":"'$FILE'","password":"s3cr3t","expires_at":"2026-12-31T23:59:59Z","max_downloads":3}' \
     localhost:8300/vola/shares                            # 201 {id, token, url, has_password, …}
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"folder":{"instance_type":"tickets","instance_id":"'$TICKET'","path":"docs/2026"}}' \
     localhost:8300/vola/shares                            # a folder share
curl -H "X-Share-Password: s3cr3t" localhost:8300/vola/s/$TOKEN                   # the file; or ?password=
curl localhost:8300/vola/s/$TOKEN                         # a folder share: {kind:"folder", folder, subfolders[], files[]}
curl localhost:8300/vola/s/$TOKEN/path/q4/report.pdf      # a file inside the shared folder, by relative path
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/shares?file_id=$FILE&include_revoked=1"
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/shares/$SHARE     # revoke → 410 from then on
```

Answers: unknown token `404 share_not_found`; revoked or expired `410 share_gone`; password
missing or wrong `401 share_password_required` — ten wrong ones per token in fifteen minutes
(Redis-shared when `VOLA_REDIS_URL` is set, per process otherwise) → `429
too_many_password_attempts` with `retry_after`, the right password included until the window
ends. **Counting:** only a request that starts a download counts — a `GET` without `Range` or
with a `Range` from byte 0 — through an atomic `UPDATE … WHERE download_count < max_downloads`,
so two readers cannot both take the last one. `HEAD` and a `Range` continuation never count,
and once the limit is reached they still answer (the last granted download can be resumed)
while starting another is `410`. Every share answer carries `Cache-Control: private, no-store`
and `X-Robots-Tag: noindex, nofollow`; an encrypted file inside a shared folder is invisible to
the share.

### The share grant — sharing an encrypted file

A share of a `tenant` or `keyring` file is a **grant** ([CRYPTO.md § 12](CRYPTO.md#12-the-share-grant-phase-63)):
the server wraps the file key under a 32-byte secret it draws and forgets, and the `url` ends in
`#<secret>` — a fragment, which a browser never sends to a server. The recipient's client sends
it as `X-Share-Secret`: missing → `401 share_secret_required`, wrong → `409 vola_integrity`,
right → the file **decrypted** (the recipient gets plaintext — say so in the dialog), with
`Range`, `no-store`, and the password / expiry / `max_downloads` rules above. A `keyring` file's
grant is made under the owner's `X-Vola-Unlock` (`423` without); the recipient needs no token.
Revoking a grant also drops the wrapped key: nothing is left to open. A `caller` file is
`409 encrypted_share_requires_grant` unless the caller sends its own `fk_share_ct`; a `client`
file always. `VolaClient.openShare(url)` does the fragment → header step for a recipient.

```sh
URL=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"file_id":"'$ENCRYPTED_FILE'"}' localhost:8300/vola/shares | jq -r .url)     # …/vola/s/<token>#<secret>
curl -H "X-Share-Secret: ${URL##*#}" "${URL%%#*}"                                    # the plaintext
```

## Statistics

| route | scope | notes |
|---|---|---|
| `GET /stats/tenant[?recompute=1]` | `files:read` | the tenant's live files (soft-deleted ones never count): `total_files`, `total_bytes` (before deduplication), `by_kind`, `oldest_at`, `newest_at`, `computed_at` (`TenantStatsSchema`) |
| `GET /stats/instance/:type/:id[?recompute=1]` | `files:read` | the same for one instance |
| `GET /stats/storage` | `files:read` | `files`, `logical_bytes`, `unique_blobs`, `unique_bytes`; an admin key adds `physical` (the disk: `blobs`, `derived`, `uploads`) and without `X-Tenant-Slug` measures the whole deployment (`scope: "deployment"`) (`StorageStatsSchema`) |

```sh
curl -H "Authorization: Bearer $KEY" "localhost:8300/vola/stats/tenant?recompute=1"
#   {"scope":"tenant","total_files":42,"total_bytes":…,"by_kind":{"image":30,"document":12},"oldest_at":…,"newest_at":…,"computed_at":…}
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/stats/instance/tickets/$TICKET
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/stats/storage
#   {"scope":"tenant","files":42,"logical_bytes":…,"unique_blobs":40,"unique_bytes":…,"physical":null,…}
curl -H "Authorization: Bearer $ADMIN" localhost:8300/vola/stats/storage       # scope "deployment" + physical {blobs, derived, uploads}
```

The tenant and instance numbers are **snapshots** in `vola_tenant_stats`: computed on the first
read, forced with `?recompute=1`, and refreshed by the worker's repeatable `refresh-stats` job
for snapshots older than `VOLA_STATS_TTL_MIN` (60) whose tenant had file activity since (the
job runs every half TTL). Without a worker a read past the TTL recomputes instead.

## Admin transfer

When the host application moves an entity between tenants (thilo moves a project, with its
tickets, from one workspace to another), its files follow through one admin call. Rows move,
blobs stay on disk (they are content-addressed and shared). Everything of the listed instances
goes: every file row (every version, the soft-deleted ones too), the folders, the share links
(same tokens, so a public link keeps working), the processing jobs and OCR metadata, the
finished resumable uploads. Statistics of both tenants are recomputed afterwards and live
subscribers of both tenants are told (`purged` on the source, `created` on the destination).

| route | scope | notes |
|---|---|---|
| `POST /admin/transfer` | `admin` (an admin key; a tenant key is `403`; `X-Tenant-Slug` is ignored) | `TransferRequestSchema`: `{from_tenant, to_tenant, instances: [{instance_type, instance_id}] (≤ 1000), user_map?: {old: new}, dry_run?}` → `TransferResultSchema`, the counts; `404 tenant_not_found` for either slug (the destination must exist); a `tenant`-encrypted file's key is re-wrapped for the destination in the same transaction (`503 encryption_unavailable` without the key file, `409 vola_integrity` for a key that does not open); `409 encrypted_transfer_unsupported` when an instance holds a `keyring`, `caller` or `client` file; `409 uploads_in_progress` when a resumable upload of the instance is still running; `422` for the same tenant twice or no instances |

```sh
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
     -d '{"from_tenant":"acme","to_tenant":"beta","instances":[{"instance_type":"tickets","instance_id":"'$TICKET'"}],
          "user_map":{"alice@acme":"u-17"},"dry_run":true}' \
     localhost:8300/vola/admin/transfer
#   {"from_tenant":"acme","to_tenant":"beta","instances":1,"files":12,"folders":3,"merged_folders":1,"shares":2,"jobs":40,"metadata":4,"uploads":0,"dry_run":true}
```

Rules: a folder whose path already exists for the same instance on the destination is
**merged** into that folder (its files, subfolders and share links re-pointed, the source row
removed), never duplicated; a **live** source folder revives a **deleted** destination folder
it merges into. `user_map` rewrites `created_by`, `deleted_by` and `last_accessed_by` of files,
`created_by` / `deleted_by` of folders and `created_by` of share links; a user with no mapping
stays. The whole call is **one transaction** and is **idempotent** — a repeated call finds
nothing on the source and reports zeros. `dry_run` runs the same statements and rolls them
back. `vola transfer` does the same against the database directly ([CLI.md](CLI.md)). With
`VOLA_MEMENTO_URL` the call is audited ([AUDIT.md](AUDIT.md)).

## Lookups and instance types

| route | scope | notes |
|---|---|---|
| `GET /lookups[?locale=en\|sr]` | none | the controlled vocabulary of `lookups.yaml` (`FileKinds`, `ProcessingStatuses`, `ProcessingKinds`, `ShareScopes`, `OcrLanguages`, `EncryptionModes`) with its terms, wire values and labels in the locale asked for; an unknown locale falls back to `en` (`LookupsResponseSchema`) |
| `GET /instance-types` | `files:read` | the tenant's distinct `instance_type` values that have live files, with the number of those files, by name (`InstanceTypesResponseSchema`) |

```sh
curl "localhost:8300/vola/lookups?locale=sr"
#   {"locale":"sr","locales":["en","sr"],"lookups":{"FileKinds":[{"term":"IMAGE","value":"image","label":"Slika"},…],…}}
curl -H "Authorization: Bearer $KEY" localhost:8300/vola/instance-types
#   {"instance_types":[{"instance_type":"tickets","files":12},{"instance_type":"users","files":3}]}
```

There is no `InstanceTypes` section in the vocabulary: an instance type is a free string of the
caller. A value the vocabulary does not know is never rejected; it is recorded as a candidate
(`vola lookups candidates`, `vola lookup-promote`).

## UDC collections

The way to browse files is [UDC](https://github.com/digital-cube/jsudc) — the `@jsudc/server`
protocol, mounted under `/udc` behind the API-key auth: `files:read` for `collections`,
`describe`, `list`, `read` (and `files:write` for `mutate`, `reindex`, `tree.reparent` and the
`schema.*` actions); an admin key with `X-Tenant-Slug`; a refusal is an in-protocol `forbidden`
/ `validation_error` envelope.

| route | scope | notes |
|---|---|---|
| `POST /udc/collections` | `files:read` | the collections: `files`, and `menu` when `menu.yaml` exists |
| `POST /udc/describe` | `files:read` | `{collection}` → fields, filters, sorts, the view |
| `POST /udc/list` | `files:read` | `{collection, filter, sort, page: {limit, cursor}}` → `{rows, next_cursor, total}` |
| `POST /udc/read` | `files:read` | `{collection, id}` → one row |
| `POST /udc/<write action>` | `files:write` | `mutate`, `reindex`, `tree.reparent`, `schema.*` — the built-in collections are read-only and refuse them in-protocol; writes go through the REST routes |
| `GET /udc/subscribe` | `files:read` | the WebSocket ([Real-time](#real-time-get-udcsubscribe)) |

```sh
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" localhost:8300/vola/udc/list -d '{
    "collection": "files",
    "filter": {"and": [
      {"field": "instance_type", "op": "eq", "value": "tickets"},
      {"field": "instance_id", "op": "eq", "value": "'$TICKET'"},
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
`include_deleted` and `ocr` ([OCR](#ocr)); it sorts by `created_at`, `filename` or `size` and
pages by an opaque cursor (`next_cursor` → `page.cursor`), with an exact `total`. Rows carry
`download_url` and `thumb_url` (`…/thumb/256`: `200` ready, `202` while the worker renders,
`404 no_thumbnail`), `kind` / `encryption` / `processing_status` as lookup values and `ocr`
(yes/no). An encrypted file's row carries its real `filename`, `mime_type`, `extension` and
`kind` when the request can open it and `filename: "<encrypted>"` otherwise; **filters, sorts and
cursors always see the mask**. `menu.yaml` is served as the `menu` collection.

## Real-time: `GET /udc/subscribe`

The same rows, live. A WebSocket (`["vola.v1", "bearer.<key>"]` as subprotocols, or the usual
headers; `files:read`) takes `udc.subscribe` messages with a `list`-style filter — a top-level
`instance_type` is required, `instance_id` and `folder_path` narrow it — and pushes
`udc.row.upsert` (the row, exactly as `list` would answer it) and `udc.row.remove` (an id) as
files are uploaded, replaced, moved, renamed, deleted, purged and processed. A client that reads
too slowly is closed with `4008` (`VOLA_WS_MAX_BUFFERED`), one that stops answering pings is
terminated (`VOLA_WS_HEARTBEAT_MS`). The protocol, its message schemas (`ClientMessageSchema`,
`ServerMessageSchema` in `@vola/core`) and the lifecycle are in [REALTIME.md](REALTIME.md).

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

## The examples site's routes

Present only with `VOLA_EXAMPLES=true` ([EXAMPLES-SITE.md](EXAMPLES-SITE.md)); `404` otherwise.

| route | auth | notes |
|---|---|---|
| `GET /examples/config` | none | `{api_key, tenant, instance_type, instance_id, user_prefix, write_path, limits: {max_upload_bytes, ttl_hours, rate_limit, rate_window_s, mime_types}, features: {keyring, tenant_encryption, worker}}` — the **read-only** visitor key and the demo instance |
| `ANY /examples/write/<route>` | the visitor key + `X-User-Id: demo-…` | replays a visitor's write (uploads, the tus protocol with `Location` rewritten, the visitor's own files and folders, shares with the expiry capped, the visitor's keyring) under the server's write key, after the policy: `413 demo_too_large` (5 MiB), `415 demo_mime_not_allowed`, `403 demo_forbidden` (a seeded or another visitor's row), `400 demo_user_required`, `429 demo_rate_limited` + `Retry-After` (60 writes per address per ten minutes) |
| `POST /examples/regenerate/:fileId` | the visitor key | drops a file's thumbnails so the `202 → 200` sequence can be watched again |
| `POST /examples/purge` | admin key | removes what visitors left after `VOLA_DEMO_TTL_HOURS` (the server runs it every `VOLA_DEMO_PURGE_INTERVAL_MIN` anyway) |

## OpenAPI

There is no generated OpenAPI document in v1.0. The routes validate their bodies with the Zod
schemas of `@vola/core` by hand (`safeParse` in the handler) rather than through Fastify's
`schema` option, so `@fastify/swagger` would see no schemas and produce an empty specification;
wiring it in means registering every schema (Zod 4's `z.toJSONSchema`) and every route's
params, query, headers and responses through a type provider — a day of work and a change to
every route file, not a documentation task. The proposal is recorded in the ticket report of
plan 8.2: `fastify-type-provider-zod` + `@fastify/swagger` + `@fastify/swagger-ui` at
`/vola/docs`, the multipart and tus routes described by hand, the WebSocket left to
[REALTIME.md](REALTIME.md). Until then this document is the contract, and `@vola/core` the
machine-readable half of it.
