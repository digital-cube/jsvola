# Migrating a consumer from vola-spp to JSVola

For the applications that call vola-spp today — **thilo.ai, opencon, vigiles, hotels, dclabs,
dclabstpl, mementoservice, tplbuilder-2** ([ANALYSIS.md § 2.5](ANALYSIS.md#25-ko-koristi-vola-danas)).
JSVola is a new API (decision 1 of [PLAN.md](PLAN.md): no wire compatibility) and a clean start
(decision 2: no data migration). The route reference is [API.md](API.md); the SDK that wraps
every route is [`@vola/client`](../packages/client/README.md).

## What changes in one paragraph

Same model, new wire. A file still belongs to a tenant and an instance `(instance_type,
instance_id)`, still has a slug, a folder path, a version chain, `is_public` /
`is_global_public`, thumbnails that answer `202` while the worker renders, share links, stats,
UDC `list` / `describe` / `read`. What is different: the paths lose the `/api/v1` prefix and the
`/id/` segments (`/vola/files/tickets/<uuid>/<fileId>`), visibility and move are one `PATCH`
with a JSON body, shares are created with a JSON body and followed at `/vola/s/<token>`, the
error envelope is `{error: {code, message}}` with stable snake_case codes, the key goes in
`Authorization: Bearer` (`X-Api-Key` still works), and there are new things: resumable uploads,
live lists over WebSocket, OCR, encryption, keyrings, an audit trail.

## Authentication

| | vola-spp | JSVola |
|---|---|---|
| header | `X-API-Key: <key>` | `Authorization: Bearer <key>` — **`X-Api-Key: <key>` is accepted too** (header names are case-insensitive, so an existing `X-API-Key` keeps working); for WebSockets the subprotocol `bearer.<key>` |
| key format | `vola_live_…` / `vola_test_…` / `vola_admin_…` | the same prefixes; only the SHA-256 is stored; the display form is `vola_live…k3Qz` |
| the keys themselves | | **new keys**: a clean start means the key table is empty — issue new keys with `vola create-key` and put them in each consumer's configuration ([CLI.md](CLI.md)) |
| scopes | a JSON list on the key | `files:read`, `files:write`, `folders:read`, `folders:write`, `shares:write`, `keys:write`, `keyrings:write`, `encryption:caller`, `admin` — finer than before; a consumer that uploads and lists needs `files:read,files:write`, one that makes folders `folders:*`, one that shares `shares:write` |
| admin key | `X-Tenant-Slug` selects the tenant | the same |
| the acting user | `X-User-Id` | the same header, now also the owner of a keyring |
| a tenant key on another tenant's file | 404 / 403 | always `404` |
| errors | FastAPI's `{detail: …}` | `{error: {code, message, …}}`; codes in [API.md § Errors](API.md#errors) |

## Routes: old → new → `@vola/client`

`:type/:id` below is `instance_type/instance_id` (`tickets/5c1b…`); `$F` a file id. The SDK
methods take the same arguments in order.

| vola-spp | JSVola | `@vola/client` |
|---|---|---|
| `POST /api/v1/files/{type}/id/{id}` multipart (`folder_path`, `folder_id`, `parent_id`) | `POST /vola/files/:type/:id` multipart (the same fields + `metadata`, `encryption`) | `vola.files.upload(type, id, source, { folderPath, folderId, parentId, metadata, encryption })` |
| `PUT /api/v1/files/{type}/id/{id}/slug/{slug}` | `PUT /vola/files/:type/:id/slug/:slug` | `vola.files.putSlug(type, id, slug, source)` |
| `GET\|HEAD /api/v1/files/{type}/id/{id}/id/{file_id}` (Range / 206) | `GET\|HEAD /vola/files/:type/:id/:fileId` | `vola.files.download(type, id, fileId, { range, ifNoneMatch, download })`, `vola.files.head(…)` |
| `GET …/path/{path}` | `GET\|HEAD /vola/files/:type/:id/path/*` | `vola.files.byPath(type, id, path)` |
| `GET …/slug/{slug}` | `GET\|HEAD /vola/files/:type/:id/slug/:slug` | `vola.files.bySlug(type, id, slug)` |
| `GET …/id/{file_id}/info` | `GET /vola/files/:type/:id/:fileId/info` (+ `ocr`, `?ocr=full`) | `vola.files.info(type, id, fileId, { ocr })` |
| `GET …/id/{file_id}/thumb/{size}?crop=` (`202` = placeholder) | `GET\|HEAD /vola/files/:type/:id/:fileId/thumb/:size?crop=` (`202` = placeholder, unchanged) | `vola.files.thumb(type, id, fileId, size, { crop })` → `{status: "ready" \| "generating" \| "failed" \| "not_modified"}` |
| `PATCH …/id/{file_id}/visibility` | `PATCH /vola/files/:type/:id/:fileId` `{is_public, is_global_public}` | `vola.files.patch(type, id, fileId, { is_public, is_global_public })` |
| `PATCH …/id/{file_id}/move` | `PATCH /vola/files/:type/:id/:fileId` `{folder_path}` | `vola.files.patch(type, id, fileId, { folder_path })` |
| — | `PATCH …` `{filename}` (new: rename) | `vola.files.patch(type, id, fileId, { filename })` |
| `DELETE …/id/{file_id}` (soft) | `DELETE /vola/files/:type/:id/:fileId` | `vola.files.delete(type, id, fileId)` |
| `DELETE …/id/{file_id}/purge` | `DELETE /vola/files/:type/:id/:fileId/purge` → `{files, blobs}` | `vola.files.purge(type, id, fileId)` |
| list files of an instance (UDC only) | `GET /vola/files/:type/:id?cursor&limit&include_deleted` (new REST list) | `vola.files.list(type, id, { cursor, limit })`, `vola.files.iterate(type, id)` |
| — | `GET /vola/files/:type/:id/:fileId/versions` | `vola.files.versions(type, id, fileId)` |
| `POST /api/v1/folders/{type}/id/{id}/path/{path}` | `POST /vola/folders/:type/:id/*path` | `vola.folders.create(type, id, path)` |
| `GET …/folders/…/path/{path}` | `GET /vola/folders/:type/:id[/*path]` → `{folder, subfolders[], files[]}` | `vola.folders.list(type, id, path)` |
| `PATCH …/folders/…/path/{path}` | `PATCH /vola/folders/:type/:id/*path` `{name \| parent_path \| default_keyring}` | `vola.folders.rename(…)`, `vola.folders.move(…)`, `vola.folders.patch(…)` |
| `DELETE …/folders/…/path/{path}` | `DELETE /vola/folders/:type/:id/*path[?recursive=1]` | `vola.folders.delete(type, id, path, { recursive })` |
| `POST /api/v1/share` | `POST /vola/shares` `{file_id \| folder: {instance_type, instance_id, path}, password, expires_at, max_downloads}` → `{token, url, …}` | `vola.shares.create({ … })` |
| `DELETE /api/v1/share/id/{id}` | `DELETE /vola/shares/:id` | `vola.shares.revoke(id)` |
| — | `GET /vola/shares[?file_id=]`, `GET /vola/shares/:id` | `vola.shares.list({ fileId })`, `vola.shares.get(id)` |
| `GET\|HEAD /share/token/{t}[/download]` | `GET\|HEAD /vola/s/:token[?download=1]` (`X-Share-Password` or `?password=`) | `VolaClient.openShare(url, { password, download, range })` |
| `GET /share/token/{t}/path/{p}` | `GET\|HEAD /vola/s/:token/path/*` | `vola.shares.open(url, { path })`, `vola.shares.listing(url)` |
| `GET\|HEAD /public/file/{id}` | `GET\|HEAD /vola/public/:fileId` | `vola.files.public(fileId)`, `vola.files.publicUrl(fileId)` |
| `GET /api/v1/stats/tenant` | `GET /vola/stats/tenant[?recompute=1]` | `vola.stats.tenant({ recompute })` |
| `GET /api/v1/stats/instance/{type}/id/{id}` | `GET /vola/stats/instance/:type/:id` | `vola.stats.instance(type, id)` |
| `GET /api/v1/stats/storage` | `GET /vola/stats/storage` | `vola.stats.storage()` |
| `GET /api/v1/instance-types` | `GET /vola/instance-types` | `vola.instanceTypes()` |
| `POST /api/v1/keys` | `POST /vola/keys` `{name, scopes, env, expires_at}`; `GET /vola/keys`; `DELETE /vola/keys/:id` | `vola.keys.create(…)`, `vola.keys.list()`, `vola.keys.revoke(id)` |
| `POST /api/v1/admin/transfer` | `POST /vola/admin/transfer` (the same body; `dry_run` added) | `vola.admin.transfer(…)` |
| `POST /udc/list\|describe\|read` | `POST /vola/udc/list\|describe\|read` (`@jsudc/server` 0.2 protocol; the `files` collection needs a top-level `instance_type` filter, as before) | `vola.udc.list(…)`, `vola.udc.describe(…)`, `vola.udc.read(…)` |
| `GET /api/lookups` | `GET /vola/lookups[?locale=]` (no key) | `vola.lookups(locale)` |
| health | `GET /vola/health/live`, `GET /vola/health/ready` | `vola.live()`, `vola.ready()` |
| — (new) | `POST /vola/uploads` + tus (`HEAD`/`PATCH`/`DELETE /vola/uploads/:id`) | `vola.uploads.resumable(type, id, source, { … })` |
| — (new) | `GET /vola/udc/subscribe` (WebSocket) | `@vola/react`'s `VolaFileBrowser`, or a `WebSocket` by hand ([REALTIME.md](REALTIME.md)) |
| — (new) | `/vola/keyrings/…`, `X-Vola-Unlock`, `X-Vola-Content-Key`, `encryption` on uploads, share grants | `vola.keyrings.*`, `encryption` / `contentKey` options, `openShare` handles the fragment |

## What stays exactly the same

- **The 202 thumbnail rule.** `GET …/thumb/:size` answers `202` with a grey placeholder and
  `X-Thumbnail-Status: generating` while the worker renders; `200` with the WebP when it is
  there. Branch on the status, never cache a `202` body under a content-derived key, pass
  `no-cache` through a proxy, retry with backoff. Every consumer that got this right against
  vola-spp needs no change here ([API.md](API.md#thumbnails--get-thumbsize-answers-202-too)).
  `@vola/client`'s `files.thumb()` and `@vola/react`'s `VolaThumb` implement the rule.
- The sizes `64 / 128 / 256 / 512`, the crops `cover` / `fit` / `attention`, WebP.
- `Range` / `206` / `416`, `HEAD`, `ETag` and `304` on downloads; `inline` for images, video,
  audio and PDF.
- `instance_id` is a UUID; `instance_type` a lowercase identifier; slugs name one live file.
- The UDC `files` collection and its "a top-level `instance_type` filter or an empty list" rule;
  `download_url` and `thumb_url` on every row.
- `is_public` (any authenticated tenant may read) and `is_global_public` (`/public/:fileId`
  without a key).
- Content-addressed storage, dedup, soft delete, purge when nothing references the blob.
- `X-Tenant-Slug` for admin keys, `X-User-Id` for attribution.

## What is gone or different

- `/api/v1` and the `/id/` path segments. `…/visibility` and `…/move` → one `PATCH`.
- `POST /api/v1/share` → `POST /vola/shares` with a JSON body; `/share/token/{t}` → `/vola/s/:token`;
  `/share/token/{t}/download` → `?download=1`. The password goes in `X-Share-Password`.
- `X-File-Hash` on downloads → the `ETag` (`"<sha256>"`) carries the hash of a plain file.
- Share passwords are argon2id, not bcrypt (no hashes are migrated anyway).
- The response envelopes: an upload answers the file info directly (`201`), lists answer
  `{files, next_cursor}`, errors `{error: {code, message}}`.
- `POST /admin/transfer` no longer creates the destination tenant; it must exist.
- `EXIF` and `AI_SUMMARY` jobs, present in vola-spp's vocabulary only, do not exist.

## No data migration (decision 2)

JSVola starts empty: a new database, a new storage directory, new keys. vola-spp keeps running
for the consumers that have not moved; a consumer moves by pointing its configuration at the
new server and, if it needs its old files there, uploading them again through the new API
(their content hash will be the same, so a dual-write period costs no extra disk on the new
side). There is no script that reads vola-spp's tables or its `aa/bb/cc/<sha>.<ext>` tree, by
decision: the old tree keeps the extension in the blob name and vola-spp's rows carry no
encryption, OCR or version metadata the new schema wants, and every consumer re-syncs what it
still needs from its own source of truth. Share tokens are not carried over: links sent out
under vola-spp stay valid against vola-spp as long as it runs.

## Checklist for a consumer

The eight projects use, in this order of frequency, `POST /udc/list` (every list in every UI),
`/thumb/` (thilo, vigiles, dclabs), `/api/v1/files/…/id/…` (upload, download, info), `X-Tenant-Slug`
+ `X-API-Key` (every backend is an admin-key caller), `/udc/describe` + `/udc/read`,
`/api/lookups`, `/api/v1/instance-types`, `/api/v1/stats/*` (vigiles), `/api/v1/folders/…`
(opencon), `…/visibility` and `/public/file/{id}` (dclabs), `…/slug/logo` (dclabstpl,
mementoservice, tplbuilder-2), `…/slug/profile_image` (thilo). Per project:

1. **Keys.** Create the tenant(s) and new keys on the JSVola server (`vola create-tenant`,
   `vola create-key` / `create-admin-key`) with the scopes the project needs; put them in the
   project's configuration in place of the vola-spp key. A backend that acts for several
   tenants keeps using an admin key + `X-Tenant-Slug`.
2. **Base URL and prefix.** `https://files.example.com/vola` replaces `https://…` + `/api/v1`.
   If the project has a vola client module (thilo.ai has `libs/vola`), replace it with
   `@vola/client` (TypeScript) or rewrite its route table from the one above (Python). The
   `/udc/*` calls move under the prefix: `/vola/udc/list`.
3. **Uploads.** `POST /vola/files/:type/:id` — drop `/id/` from the path; the field names
   (`file`, `folder_path`, `folder_id`, `parent_id`) are unchanged, `metadata` is new. The
   answer is the file info itself. Above a few MiB from a browser, switch to
   `vola.uploads.resumable()` / `VolaUploadButton`.
4. **Downloads and `info`.** Drop `/id/`; read the hash from `ETag` instead of `X-File-Hash`.
5. **Thumbnails.** Path change only; keep the `202` handling (or adopt `files.thumb()` /
   `VolaThumb`). Check the project's cache layer does not key a `202` body by hash — the rule
   that already applied.
6. **Visibility and move.** Two routes become one `PATCH` with `{is_public}`,
   `{is_global_public}`, `{folder_path}`.
7. **Shares.** `POST /vola/shares` with a JSON body; the link is `url` from the answer (set
   `VOLA_PUBLIC_URL` on the server so it is the public one); `/share/token/…` URLs in templates
   become `/vola/s/<token>`. For an encrypted file the `url` has a `#fragment` the recipient's
   client must send as `X-Share-Secret` (`VolaClient.openShare` does it).
8. **UDC.** `POST /vola/udc/list|describe|read` with the same filter DSL (`@jsudc/core` 0.2);
   rows gain `kind`, `encryption`, `processing_status`, `ocr`. A UI on `@udc/react` moves to
   `@jsudc/react` + `@vola/react`'s `VolaFileBrowser` (live through `/udc/subscribe`).
9. **Stats, instance types, lookups.** Path changes only (`/vola/stats/tenant`,
   `/vola/instance-types`, `/vola/lookups`).
10. **Errors.** Map `{error: {code}}` instead of `{detail}`; the codes to branch on are in
    [API.md](API.md#errors) — notably `423 vola_locked`, `409 vola_integrity` and
    `503 encryption_unavailable` if the project adopts encryption.
11. **Transfer (thilo).** `POST /vola/admin/transfer` with the same body; create the
    destination tenant first; try `dry_run: true`.
12. **Run the smoke test**: upload, `info`, download with `Range`, a thumbnail until `200`, a
    UDC list, a share link opened without a key, delete and purge — the README's quick start
    against the project's own server.
13. **Decommission** the vola-spp key for that project once the switch is done.

New capabilities worth adopting while there: `encryption: "tenant"` on uploads (one header,
no client change), keyrings for per-user private files (`@vola/react`'s `VolaPinGate`), OCR
text through `…/info?ocr=full` and the UDC `ocr` full-text filter, the audit trail into memento,
and live lists instead of polling.
