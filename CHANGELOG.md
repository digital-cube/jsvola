# Changelog

All notable changes to JSVola. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@vola/*` package and the Docker image
share one version.

## [Unreleased]

### Added

- Background jobs and thumbnails (plan 4.1). `@vola/server` gains a second process, the
  **worker** (`node dist/worker.js`, `pnpm start:worker`, the `vola-worker` compose service on
  the same image), consuming the BullMQ queue `vola-processing` on `VOLA_REDIS_URL` with
  `VOLA_WORKER_CONCURRENCY` (2) jobs at once and a graceful SIGTERM; `VOLA_QUEUE_PREFIX` (`vola`)
  namespaces the Redis keys. `VOLA_WORKER_ENABLED` = `auto` (default: async when Redis is set) /
  `1` (insist; one ERROR line and synchronous work without Redis) / `0` (always synchronous —
  thumbnails render inline on `/thumb`, OCR will not run; one INFO line per process, never an
  error). New table `vola_processing_job` (migration `0004_processing_jobs`: `id`, `tenant_id`,
  `file_id`, `kind`, `params`, `status`, `attempts`, `error`, `created_at`, `started_at`,
  `finished_at`; `(file_id, kind, params)` unique) and `processing_status` on every file info,
  the UDC `files` row and `…/info`: the worst status of the file's jobs wins (`FAILED` >
  `RUNNING` > `PENDING` > `DONE`, `SKIPPED` ignored, `null` without jobs). After every upload
  (plain, slug, version, resumable) of a raster image (not SVG) or PDF with `encryption = none`,
  four `THUMBNAIL` jobs (64 / 128 / 256 / 512, crop `cover`) are queued; the worker renders them
  with `sharp` (`rotate()` for EXIF, `cover` = centre crop, `fit` = contain, `attention`, WebP
  quality 80; a PDF's first page through `pdftoppm -f 1 -l 1 -r 72 -png`), 30 s per job, 3 tries
  then `FAILED` with a short `error`, and stores each as the derived file
  `thumb-<size>-<crop>.webp` next to the blob (shared across tenants, purged with it); after
  every job a `processing` event goes out, so a live `files` list updates.
  `GET|HEAD /files/:type/:id/:fileId/thumb/:size?crop=` (`files:read`): `400 invalid_size` /
  `invalid_crop`; `200` + `X-Thumbnail-Status: ready` + `Cache-Control: private, max-age=86400`
  + `ETag`/`304` when the rendition exists; **`202`** + a grey WebP placeholder (~50 B) +
  `X-Thumbnail-Status: generating` + `Cache-Control: no-cache` when it does not and the worker
  is on (the job row is written or refreshed); inline rendering and `200` without a worker (or
  when the queue cannot be reached); `200` placeholder + `X-Thumbnail-Status: failed` for a file
  that cannot be rendered; `404 no_thumbnail` for an unsupported type or an encrypted file. The
  expired-upload sweep moved to a repeatable BullMQ job in async mode (the in-process timer
  stays for deployments without a worker). `@vola/core`: `PROCESSING_KINDS`,
  `PROCESSING_STATUSES`, `aggregateProcessingStatus`, `THUMBNAIL_SIZES`, `THUMBNAIL_CROPS`,
  `thumbnailDerivedName`, `thumbnailSupported`, `THUMBNAIL_STATUS_HEADER`. New dependencies:
  `bullmq`, `sharp`, `pino`. The E2E stack starts the built worker next to the built server.

- Real-time `subscribe` (plan 3.2): `GET /udc/subscribe` upgrades to a WebSocket
  (`bearer.<key>` subprotocol next to `vola.v1`, or the usual headers; `files:read`; refusals
  are plain `401`/`403`/`400` before the upgrade; the key is never read from the URL). A
  client sends `udc.subscribe {collection: "files", filter}` with a `list`-style filter
  (top-level `instance_type` required, `instance_id`, `folder_path`, `include_deleted` and
  the rest as in `list`; up to 32 per connection) and receives `udc.row.upsert` (the row as
  `list` answers it, read back under the tenant and the same masking / `decorateRow`) or
  `udc.row.remove` (an id) whenever a file of that instance is uploaded, replaced by slug,
  versioned, completed by a resumable upload, moved, renamed, made (in)visible, soft-deleted,
  purged, or moved by a folder rename / deleted with a folder. `FileEventBus`
  (`@vola/server`): every writer publishes `{tenantId, instanceType, instanceId, folderId,
  fileId, kind}` after its commit — Redis pub/sub on `vola:files:<tenant id>` with
  `VOLA_REDIS_URL` (several server and worker processes), in-process without;
  `publishProcessingStatus` is the hook for the plan-4.1 worker. Heartbeat
  (`VOLA_WS_HEARTBEAT_MS`), slow-consumer close `4008` (`VOLA_WS_MAX_BUFFERED`), `1001` on
  shutdown, `1011` when the feed is down. `volaPlugin` takes `events` and `subscribe`
  (`false` switches either off); `@fastify/websocket` is registered unless the host did.
  Wire schemas in `@vola/core` (`ClientMessageSchema`, `ServerMessageSchema`,
  `SUBSCRIBE_CLOSE_CODES`, `FILE_EVENT_KINDS`). The `files` collection now reports
  `capabilities.subscribe: true`. Docs: `docs/REALTIME.md`.

- Lookups, translations and the UDC `files` collection (plan 3.1). `@vola/lookups` is now the
  full copy of `@memento/lookups` (YAML compiler and registry, CSV translations with a
  validator, candidate recorder, codegen) plus `promoteCandidates`; `lookups.yaml`
  (`FileKinds`, `ProcessingStatuses`, `ProcessingKinds`, `ShareScopes`, `OcrLanguages`,
  `EncryptionModes` — no `InstanceTypes`) and `i18n/translations.csv` (en, sr) live at the
  repository root. `GET /lookups?locale=en|sr` (no key; fallback en) serves terms, wire values
  and labels; `GET /instance-types` (`files:read`) the tenant's instance types with live-file
  counts. An upload whose `kind` / `encryption` the vocabulary does not know is recorded under
  `var/candidates` (`VOLA_LOOKUPS_PATH`, `VOLA_TRANSLATIONS_PATH`, `VOLA_RECORD_CANDIDATES`,
  `VOLA_CANDIDATES_DIR`); `vola lookup-promote`, `vola lookups validate|candidates` manage
  the queue. `@jsudc/server` 0.2.1 is mounted under `/udc` behind the API-key auth
  (in-protocol refusals, `files:read` to read, admin with `X-Tenant-Slug`) with the read-only
  `files` collection (`udc/files/view.yaml`): required top-level `instance_type` filter
  (empty list without it), optional `instance_id`, `folder_path` (one level, `""` root),
  `filename` (ilike), `mime_type`, `extension`, `kind`, `size`, `created_at`,
  `include_deleted`; sort by `created_at` / `filename` / `size`; keyset cursor paging with
  `id` tiebreak and exact `total`; `download_url` / `thumb_url` in rows; an encrypted row is
  masked (`<encrypted>`, no MIME/extension) in rows, filters, sorts and cursors, with a
  `decorateRow` hook for phase 6. `menu.yaml` is served as the `menu` collection
  (`VOLA_MENU_PATH`). The Docker image ships the vocabulary and menu under `/app/config`.
- Resumable uploads (`vola_upload`, migration `0003_uploads`): `OPTIONS|POST /uploads`,
  `HEAD|PATCH|DELETE /uploads/:id` speaking tus 1.0 core + `creation`, `termination`,
  `expiration`, implemented natively in `@vola/server` (no `@tus/server`) so `tus-js-client`
  works unchanged — verified by an e2e test that uses it. `Upload-Metadata` carries
  `instance_type`, `instance_id`, `filename` (required), `folder_path`, `parent_id`, `slug`,
  `content_type`/`filetype`, `metadata`; `Upload-Length` is required (`Upload-Defer-Length` →
  `400`, over `VOLA_MAX_UPLOAD_BYTES` → `413`). Partial bytes go to
  `VOLA_STORAGE_PATH/uploads/<id>.part` as they stream, the offset is committed only after
  `fsync`, a parallel PATCH is `409 upload_locked` (`FOR UPDATE NOWAIT`), a wrong offset
  `409 upload_offset_mismatch`, a client cut mid-body keeps what arrived. Completion goes
  through the same `finalizeUpload` as `POST /files` (hash, dedup, MIME, rename, folder,
  version, slug); the last PATCH and every later HEAD carry `Vola-File-Id`. An upload belongs to
  the tenant, not the key. `VOLA_UPLOAD_TTL_HOURS` (24): expired uploads are swept by a periodic
  job in the server process. `@vola/core` gains the tus header names and the `Upload-Metadata`
  codec (`encodeTusMetadata` / `decodeTusMetadata`).
- Folders, versions and visibility (`vola_folder`, migration `0002_folders`): virtual folders
  inside an instance (`POST|GET|PATCH|DELETE /folders/:type/:id/*path` — chain auto-create,
  one-level listing, rename and move with every descendant path rewritten in one
  transaction, recursive soft delete, `409 folder_exists` / `folder_not_empty`), paths of
  1–255-character segments (no `/`, `\`, control characters, `.` or `..`; 32 levels), uploads
  with `folder_path` / `folder_id`, `GET|HEAD …/path/*`, `PATCH …/:fileId` (move, rename with
  `409 file_exists`, `is_public`, `is_global_public`), versions through `parent_id`
  (`GET …/:fileId/versions`, purge of the whole chain), `is_public` readable by any
  authenticated tenant, and the anonymous `GET|HEAD /public/:fileId` for `is_global_public`
  files (`Cache-Control: public, max-age=300`; never an encrypted file —
  `409 encrypted_not_public`). `vola_file.folder_id` and `parent_id` are foreign keys now.
- Files (`vola_file`, migration `0001_files`): content-addressable storage on disk
  (`StorageBackend` / `FilesystemBackend`: `blobs/aa/bb/cc/<sha256>`, streamed through
  `tmp/` with SHA-256 on the fly, fsync, atomic link, dedup, derived files next to the blob,
  path-traversal safe), `POST /files/:type/:id` (streaming multipart, `413 file_too_large`
  over `VOLA_MAX_UPLOAD_BYTES`, MIME from magic bytes → extension → declared type, `kind`,
  collision rename `a (1).pdf`), `PUT …/slug/:slug` (upsert), `GET|HEAD …/:fileId` and
  `…/slug/:slug` (`Range`/`206`/`416`, `ETag`/`304`, `Content-Disposition` with RFC 5987
  names, `nosniff`, `?download=1`, `last_accessed_*`), `GET …/:fileId/info`, cursor list,
  soft delete and purge (blob removed only when no row of any tenant references it). The
  encryption columns (`encryption`, `enc_format`, `keyring_id`, `fk_ct`, `meta_ct`) are
  declared now and stay `none`/NULL until phase 6.
- Tenants and API keys (`vola_tenant`, `vola_apikey`, migration `0000_tenant_apikey`):
  keys are `vola_live_…` / `vola_test_…` / `vola_admin_…` (32 base62 characters), only
  their SHA-256 is stored, the plaintext is shown once. Scopes `files:read`, `files:write`,
  `folders:read`, `folders:write`, `shares:write`, `keys:write`, `keyrings:write`, `admin`.
- `@vola/server`: API-key auth on every route (`Authorization: Bearer`, `X-Api-Key`, or the
  `bearer.<key>` WebSocket subprotocol), `TenantContext` on `request.vola` and through
  `requireTenant()` (AsyncLocalStorage), route `config.scope` / `config.auth = "none"` /
  `config.tenant = "optional"`, admin keys selecting a tenant with `X-Tenant-Slug`,
  `X-User-Id` as the principal, `last_used_at` written at most once a minute per key.
  `POST|GET /keys`, `DELETE /keys/:id` (scope `keys:write`).
- `@vola/cli`: `vola migrate`, `create-tenant`, `create-key`, `create-admin-key`,
  `list-keys`, `revoke-key` (`--json` for machine output).
- Monorepo scaffold (pnpm workspaces, Turborepo, Biome, Vitest, TypeScript 5.9, Node 24):
  `@vola/core`, `@vola/lookups`, `@vola/server`, `@vola/cli`, `@vola/client`, `@vola/react`
  and the private `@vola/e2e` suite.
- `@vola/server`: `volaPlugin` (Fastify 5) mounted under `VOLA_PREFIX` (default `/vola`),
  Zod-validated `VOLA_*` configuration, `GET /health/live` and `GET /health/ready`
  (PostgreSQL, and Redis when configured), `X-Request-ID` echo/generation, the
  `{ error: { code, message } }` error envelope, Drizzle migrations (`pnpm db:migrate`).
- `compose.yaml` (PostgreSQL 16 + Redis 7 for development, with the `vola_test` database),
  `docker-compose.yaml` (the `vola` image + PostgreSQL + Redis), multi-stage `Dockerfile`
  with libvips, poppler-utils and tesseract (eng, srp, deu), GitHub Actions CI.
