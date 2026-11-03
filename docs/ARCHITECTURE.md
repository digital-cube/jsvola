# JSVola — Architecture (v1.0)

How the pieces fit: the packages and their dependency direction, the database schema, what an
upload goes through (`finalizeUpload`), the content-addressable layout on disk, the worker and
its queues, the event bus behind the live lists, encryption as a layer, the admin transfer,
and how the server is embedded or run. The endpoint reference is [API.md](API.md); encryption
byte by byte is [CRYPTO.md](CRYPTO.md); the plan and the decisions behind it are
[PLAN.md](PLAN.md) and [ANALYSIS.md](ANALYSIS.md).

## 1. Repository layout

```
jsvola/
├── pnpm-workspace.yaml        # packages/* and apps/*
├── turbo.json                 # build / typecheck / test / test:cov / test:e2e pipelines
├── tsconfig.base.json         # strict TS, NodeNext, the custom condition "@vola/source"
├── biome.json                 # lint + format
├── compose.yaml               # development infrastructure: PostgreSQL 16 + Redis 7 (+ vola_test)
├── docker-compose.yaml        # the production-like stack: vola + vola-worker + postgres + redis (+ seeder)
├── Dockerfile                 # one image: server, worker, the vola CLI, the examples site
├── .env.example               # every VOLA_* variable, explained
├── lookups.yaml  i18n/        # the controlled vocabulary and its labels
├── menu.yaml                  # the examples site's sidebar, served as the `menu` UDC collection
├── packages/
│   ├── core/     @vola/core     Zod schemas, types, header/query/error constants, key helpers (dep: zod)
│   ├── lookups/  @vola/lookups  YAML vocabulary, CSV translations, candidates, promotion (dep: yaml)
│   ├── server/   @vola/server   Fastify plugin + server.ts + worker.ts, Drizzle schema + drizzle/ migrations,
│   │                            CAS storage, services, crypto, jobs, events, UDC collections, udc/files/view.yaml
│   ├── cli/      @vola/cli      the `vola` command (Commander) over @vola/server's services
│   ├── client/   @vola/client   the fetch SDK (deps: @vola/core, @jsudc/core)
│   ├── react/    @vola/react    React 19 components over @vola/client and @jsudc/react
│   └── e2e/      @vola/e2e      end-to-end tests against the built server (private)
└── apps/
    └── examples/ @vola/examples the examples site, Vite + React (private)
```

Dependency direction: `cli → server → core, lookups`; `client → core`; `react → client, core`;
`examples → react, client, core`. `core` has no Node-only API (it hashes with Web Crypto), so
the same package serves the browser, React and Node.

Every package exports `dist/` to consumers plus a `@vola/source` export condition that points
at `src/`: `tsx --conditions=@vola/source` (the dev server, the CLI in development) and
`tsc --noEmit` resolve workspace packages from source, so no build step is needed while
developing. Vitest resolves the same way. The condition is harmless in the published packages
(only `dist/` ships; nobody passes the condition).

## 2. `@vola/core` — the protocol

One Zod schema per body and answer, named `<Thing>Schema` with its inferred type `<Thing>`
(`FileInfoSchema` / `FileInfo`, `ShareCreateSchema`, `KeyringStatusSchema`, …), grouped by area
(`files.ts`, `folders.ts`, `uploads.ts`, `shares.ts`, `keyrings.ts`, `stats.ts`, `transfer.ts`,
`subscribe.ts`, `apikey.ts`, `lookups.ts`, `health.ts`, `errors.ts`). Next to them the
constants both sides have to agree on — header names (`USER_ID_HEADER`, `UNLOCK_HEADER`,
`CONTENT_KEY_HEADER`, `THUMBNAIL_STATUS_HEADER`, the tus headers), multipart field names,
query parameters, error codes (`LOCKED_CODE`, `INTEGRITY_ERROR_CODE`, …), the scopes, the
limits (`FILE_LIST_MAX_LIMIT`, `TRANSFER_MAX_INSTANCES`, `PIN_LENGTH`) — and the helpers the
server and the CLI share: `parseApiKey` / `displayApiKey`, `missingScopes`, `parseOcrLangs`,
`isOcrEligible`, `callerGrantAad`. The server validates request bodies with these schemas
(`safeParse` in the handler); `@vola/client` types its answers with them and can validate them
(`validate: true`).

## 3. Database schema (PostgreSQL + Drizzle)

`packages/server/src/db/schema.ts`; migrations in `packages/server/drizzle/` (`0000` … `0009`),
applied by the server at start (`runMigrations`) and by `vola migrate`. Every table is prefixed
`vola_`, every row that belongs to a tenant carries `tenant_id`, and every query is scoped by
it — another tenant's row does not exist (`404`).

| table | what | notes |
|---|---|---|
| `vola_tenant` | `slug`, `name`, `is_active`, `default_encryption` | the slug is what an admin key names in `X-Tenant-Slug` |
| `vola_apikey` | `tenant_id` (NULL for an admin key), `name`, `key_hash` (SHA-256), `prefix` + last four for display, `scopes[]`, `is_admin`, `last_used_at` (throttled), `expires_at`, `revoked_at`, `created_by` | the plaintext is never stored |
| `vola_folder` | `tenant_id`, `instance_type`, `instance_id`, `parent_id`, `name`, `path` (unique per live instance), `default_keyring_id` (the encryption policy), soft delete | a virtual hierarchy; renames rewrite every descendant `path` in one transaction |
| `vola_file` | `tenant_id`, `instance_type`, `instance_id`, `slug` (one live file per slug), `hash` (SHA-256 of the stored blob), `size`, `filename`, `extension`, `mime_type`, `kind`, `metadata` jsonb, `folder_id`, `parent_id` (the version chain), `is_public`, `is_global_public`, `encryption`, `enc_format`, `keyring_id`, `fk_ct`, `meta_ct`, `created_by`, `updated_at`, soft delete, `last_accessed_*` | the blob is referenced by `hash`; several rows of several tenants may share one |
| `vola_upload` | a resumable upload in flight: instance, folder, parent, slug, filename, declared MIME, metadata, `length`, `offset`, `expires_at`, `completed_file_id`, `encryption`, `enc_state` jsonb (the sealed-segment state, [CRYPTO.md § 10](CRYPTO.md#10-the-encrypted-resumable-upload-phase-63)) | the row is locked `FOR UPDATE NOWAIT` during a PATCH |
| `vola_processing_job` | `file_id`, `kind` (`THUMBNAIL`, `OCR`), `params` (size, crop), `status` (`PENDING` → `RUNNING` → `DONE` / `FAILED` / `SKIPPED`), `error`, timestamps | `processing_status` of a file is the aggregate |
| `vola_file_metadata` | `file_id` (PK, cascade), `ocr_text`, `ocr_lang`, `ocr_pages`, `ocr_at`, `ocr_tsv` (generated `tsvector`, GIN), `ocr_ct` (the sealed text of an encrypted file) | the full-text search of the UDC `ocr` filter |
| `vola_share_link` | `file_id` XOR `folder_id`, `token_hash`, `scope`, `password_hash` (argon2id), `expires_at`, `max_downloads`, `download_count`, `created_by`, `revoked_at`, `fk_share_ct` (the share grant) | the token's plaintext is answered once |
| `vola_tenant_stats` | one snapshot per `(tenant, scope tenant\|instance, instance_type, instance_id)`: `total_files`, `total_bytes`, `by_kind`, `oldest_at`, `newest_at`, `computed_at` | refreshed by the worker, or lazily |
| `vola_keyring` | `tenant_id`, `principal`, `kdf` (Argon2id parameters per keyring), `mk_pin_ct`, `mk_recovery_ct`, `recovery_salt`, `attempts`, `locked_until`, `pin_set_at`, soft delete | [CRYPTO.md § 8](CRYPTO.md#8-the-keyring-provider-phase-62) |

Ids are UUIDv7 (`db/uuid.ts`), so `created_at desc, id desc` is a stable cursor. Deletes are
soft everywhere a user can reach (`deleted_at`, `deleted_by`); purge is the only hard delete of
a file, and it is the moment a blob may leave the disk.

## 4. `@vola/server`

```
src/
├── server.ts          standalone: loadConfig → connect → runMigrations → buildApp → listen; SIGTERM drains
├── worker.ts          the worker process: the same config, ProcessingWorker on the BullMQ queue
├── app.ts             buildApp(): Fastify + pino (LOG_REDACT), the plugin under config.prefix, VOLA_UI_DIR
├── plugin.ts          volaPlugin: wires every dependency (VolaPluginOptions) and registers the routes
├── config.ts          every VOLA_* variable, validated with Zod → Config
├── auth.ts, apikey.ts, context.ts   the API key, scopes, X-Tenant-Slug, the per-request TenantContext (AsyncLocalStorage)
├── errors.ts          VolaError → {error: {code, message, …}}; the framework's own errors mapped to codes
├── routes/            one file per area: health, keys, files, thumbnails, uploads, folders, shares,
│                      share-public, public, stats, admin, keyrings, lookups; send-file.ts (the download sender)
├── services/          the logic, testable without HTTP: files (stage/finalize/list/patch/purge), folders,
│                      uploads (tus), upload-crypto, thumbnails, ocr, pdf-pages, processing, shares,
│                      share-password, stats, transfer, tenants, apikeys, encryption, keyrings, unlock, derivatives
├── storage/           StorageBackend interface + FilesystemBackend (the CAS)
├── uploads/           PartStore: the part files of resumable uploads
├── files/             byte-range parsing, content-disposition, filename sanitising, MIME detection
├── crypto/            pure: the JSV format, AEAD, wrap providers (tenant, keyring, caller), meta, derived, sha256 midstate
├── jobs/              ProcessingQueue (BullMQ), JobDispatcher, ProcessingWorker, resolveJobsMode
├── events/            FileEventBus: Local and Redis pub/sub
├── udc/               the UDC collections (files, menu), the files view, SQL filter compiler, the subscribe hub + route
├── audit/             AuditLog → memento (AuditSink), the event payloads
├── examples/          the examples site's demo routes (VOLA_EXAMPLES)
├── lookups.ts         the vocabulary (@vola/lookups) and GET /lookups
├── ui.ts              VOLA_UI_DIR: the built SPA at / and /en/ with an index.html fallback
└── db/                Drizzle schema, connect(), uuid
```

### Request lifecycle

1. **Auth** (`auth.ts`, an `onRequest` hook): the route's `config` says `auth: "none"`, or a
   `scope`; the key is read from `Authorization: Bearer`, `X-Api-Key` or the WebSocket
   subprotocol, hashed, looked up (`last_used_at` throttled to once a minute), its scopes
   checked. An admin key resolves `X-Tenant-Slug` to a tenant. The result is a `TenantContext`
   — tenant id and slug, scopes, the principal from `X-User-Id`, the unlock token, the content
   key, whether the request came from a browser (`Origin`) — kept in an `AsyncLocalStorage`
   so services call `requireTenant()` instead of threading it through.
2. **The handler** parses params and body with the `@vola/core` schema (`422 validation_error`
   with the Zod issues) and calls a service.
3. **Services** are plain async functions over `FilesDeps` / `UploadsDeps` / … (`db`, `storage`,
   `events`, `crypto`, `dispatcher`, `audit`, `now`), so tests exercise them with a real
   database and a temporary directory.
4. **Errors**: a `VolaError(code, status, message, details)` becomes the envelope; anything
   else is `500 internal_error` with the stack in the log. Every answer carries `X-Request-Id`.
5. **After the commit** the service publishes a file event (§ 7) and an audit event (§ 9); a
   failure of either is logged, never raised.

The logger redacts every header that can carry a secret (`LOG_REDACT`: the API key, the unlock
token, the content key, the share password and secret) at every level, including `trace`.

### Deployment modes

- **Standalone** — `node dist/server.js` (the image's `CMD`): migrations, then listen.
- **Embedded** — a host application registers `volaPlugin` on its own Fastify instance with a
  `prefix` and `VolaPluginOptions` (its own `db`, `redis`, `storage`, `events`, `audit`, an
  `extend` callback for its own routes inside the prefix, `decorateRow` for the `files`
  collection). `@fastify/websocket` registered by the host is reused.
- **The worker** — `node dist/worker.js`, the same image and configuration (§ 6).
- **Without Redis** — one process, in-process events, synchronous thumbnails, no keyrings.

## 5. The upload flow and the CAS

### `stageUpload` → `finalizeUpload`

Every way bytes arrive — `POST /files` (multipart), `PUT …/slug/:slug`, the last `PATCH` of a
resumable upload — ends in the same two steps of `services/files.ts`:

```
request body ──► stageUpload ─┬─ headSniffer: the first 4100 bytes kept for MIME detection
                              ├─ (encryption ≠ none) createEncryptStream under a fresh file key
                              └─ storage.put: SHA-256 on the way, written to tmp/<uuid>, fsync
                                            └──► StagedUpload {hash, size, head, tmpPath, encrypted?}
StagedUpload ──► finalizeUpload ─ detectMime(head, filename, declared) → mime, extension, kind
                                 ─ ONE transaction, under pg_advisory_xact_lock(hash):
                                 │    storage.commit: link tmp → blobs/aa/bb/cc/<hash> (or discard: dedup)
                                 │    slug: soft-delete the previous live file of that slug
                                 │    collision rename within the folder: a.pdf → a (1).pdf (not against its own version chain)
                                 │    INSERT vola_file (folder, parent, metadata, encryption, fk_ct, meta_ct)
                                 ─ dispatcher.requestThumbnails / requestOcr (jobs, § 6)
                                 ─ publish `created` (+ `deleted` for the slug it replaced) (§ 7)
```

The advisory lock on the hash is what makes dedup safe against a concurrent purge: a purge
takes the same lock, checks that no row cites the hash, and only then removes the blob. The
multipart `encryption` field (and the folder) must arrive **before** the `file` part because
the mode decides what is written to disk while the part streams.

### CAS layout

```
<VOLA_STORAGE_PATH>/
├── blobs/aa/bb/cc/<sha256>                        the blob — no extension: the name is not data
├── blobs/aa/bb/cc/<sha256>.thumb-<size>-<crop>.webp   a derived file of that blob (plain files)
├── blobs/aa/bb/cc/<sha256>.enc-<file id>-thumb-<size>-<crop>   a sealed derivative (encrypted files)
├── tmp/<uuid>                                     an upload in flight (multipart)
├── uploads/<upload id>.part                       a resumable upload's bytes so far
└── uploads/<upload id>.partial                    the sealed incomplete segment of an encrypted one
```

`FilesystemBackend` is the one `StorageBackend` of v1.0 (decision 8); the interface
(`put` → staged, `commit`, `discard`, `open(hash, span)`, `stat`, `remove`, `putDerived` /
`openDerived` / `removeDerived`, `usage`) is what an S3 backend would implement later. Every
path is derived from a validated hash (`HASH_RE`) and a validated derived name
(`DERIVED_NAME_RE`), so no input reaches the file system. A blob is never overwritten; two
concurrent uploads of the same bytes race on `link` and one of them simply discards its temp
file. An encrypted blob is never shared (random key and nonce per file), so its hash is in one
row only.

## 6. The worker and its queues

Decision 5: BullMQ on Redis, the worker a second process of the same image
(`node dist/worker.js`). `resolveJobsMode` picks the mode at start:

| `VOLA_WORKER_ENABLED` | `VOLA_REDIS_URL` set | mode |
|---|---|---|
| `auto` (default) | yes | `async`: jobs go to the queue |
| `auto` | no | `sync`: thumbnails render inline on `/thumb`, no OCR, no stats job |
| `1` | no | one ERROR line, then `sync` |
| `0` | any | `sync` — for a deployment with Redis but no worker consuming the queue |

One queue, `vola-processing` under `VOLA_QUEUE_PREFIX` (default `vola`), with five job names:

| job | who enqueues | what the worker does |
|---|---|---|
| `thumbnail` | the server after an upload of a raster image or PDF (four sizes, crop `cover`), and `/thumb` on a cache miss | sharp (EXIF orientation, WebP q80; a PDF's first page through `pdftoppm -r 72`) → `putDerived`; for a `tenant`-encrypted file decrypted into memory and sealed back ([CRYPTO.md § 11](CRYPTO.md#11-thumbnails-and-ocr-of-encrypted-files-phase-63)) |
| `ocr` | the server after an upload of a raster image (not SVG/GIF) or PDF (`VOLA_OCR_ENABLED`) | `tesseract` (a PDF rasterised page by page with `pdftoppm -r 200`) → `vola_file_metadata`; a `tenant` file's text sealed into `ocr_ct` |
| `sweep-uploads` | a repeatable job the server schedules (every 15 min) | removes resumable uploads older than `VOLA_UPLOAD_TTL_HOURS`, part files and rows |
| `refresh-stats` | a repeatable job (every half `VOLA_STATS_TTL_MIN`) | recomputes `vola_tenant_stats` snapshots older than the TTL for tenants with activity since |
| `audit` | the server and the CLI, when memento is configured | pushes the event to memento (5 tries, backoff) |

A thumbnail job has 30 s, an OCR job `VOLA_OCR_TIMEOUT_S` (120 s) per page or image. Every job has
3 tries with exponential backoff, then `FAILED` with a short `error`; its
row in `vola_processing_job` is what `processing_status` aggregates, and the worker publishes a
`processing` event after each one so live lists move. `VOLA_WORKER_CONCURRENCY` (2) jobs run
at once per process; scale with more processes (`--scale vola-worker=N`). The worker needs the
**same storage directory** as the server (derived files are written next to the blobs) and,
for `tenant`-encrypted files, the same `VOLA_KEY_FILE`; it never needs the pepper file. In
`sync` mode the server does the thumbnail and the sweep itself and nothing is recorded in
`vola_processing_job`.

The `/thumb` route is where the two modes meet: `200` from the derived file when it exists;
otherwise in `async` mode `202` + a grey placeholder and a (re)queued job, in `sync` mode an
inline render and `200`. The rules a client must follow are in
[API.md](API.md#thumbnails--get-thumbsize-answers-202-too).

## 7. The event bus and `subscribe`

Every writer announces its change **after its transaction committed** through
`publishFileEvent` on a `FileEventBus` (`events/bus.ts`): `RedisFileEventBus` — one channel per
tenant, `vola:files:<tenant id>`, so several server and worker processes share one feed — with
`VOLA_REDIS_URL`, `LocalFileEventBus` (in-process) without. An event carries **ids only**
(`tenantId`, `instanceType`, `instanceId`, `folderId`, `fileId`, `kind`: `created`, `updated`,
`deleted`, `purged`, `processing`); nothing an encrypted row hides crosses Redis.

`GET /udc/subscribe` (`udc/subscribe-route.ts`, `udc/hub.ts`) is the consumer: a WebSocket
behind the same auth, `udc.subscribe` messages with a `list`-style filter, and for every event
of the tenant the hub re-reads the row through the same `files` collection source — with the
subscription's own context, so masking and decryption are those of the subscriber, not of the
uploader — decides whether it matches the filter, and pushes `udc.row.upsert` or
`udc.row.remove`. Heartbeat, slow-consumer close (`4008`), the limits and the message schemas
are in [REALTIME.md](REALTIME.md). `@vola/react`'s file browser is built on this
(`useFilesLive`: a cached row is patched in place, anything else refetches).

## 8. UDC collections

The browsing surface is [UDC](https://github.com/digital-cube/jsudc): `@jsudc/server`'s routes
under `/udc/<action>` behind vola's auth (`udc/plugin.ts`), and a `CollectionRegistry` with
the `files` collection (`udc/files-source.ts`: the row shape, the filter → SQL compiler in
`sql-filter.ts`, an opaque keyset cursor in `cursor.ts`, the view in `udc/files/view.yaml`) and
the `menu` collection (`menu.yaml`, the examples site's sidebar). The `files` source requires a
top-level `instance_type` filter, ANDs the tenant in, computes `download_url` / `thumb_url`,
maps `kind` / `encryption` / `processing_status` to lookup values, exposes `ocr` as a
full-text filter over `ocr_tsv`, and reveals an encrypted row's real name only when the
request can open it — filters, sorts and cursors always see the mask. A host that embeds the
plugin can `decorateRow` after that.

## 9. Encryption as a layer

[CRYPTO.md](CRYPTO.md) is the reference; architecturally it is one service and one interface:

- `crypto/` is pure (no I/O): the `JSV` segmented format (`format.ts`, `aead.ts`), the
  `WrapProvider` interface with three implementations — `tenant.ts` (HKDF of the key file per
  tenant), `keyring.ts` (Argon2id + pepper → master key), `caller.ts` (the request's key) —,
  `meta.ts` (the sealed name/type/metadata), `derived.ts` (sealed thumbnails and OCR),
  `sha256.ts` (an exportable midstate for the resumable upload).
- `services/encryption.ts` (`EncryptionService`) is what the rest of the server calls:
  `resolveMode` (policy folder → field/header → tenant default), `wrapNewKey`, `reveal(row)`,
  `openStream(row, range)`, `rewrap` for a transfer, the HTTP mapping (`503`, `409`, `423`,
  `400`). `services/unlock.ts` holds the unlock tokens in Redis; `services/keyrings.ts` the
  keyring rows, the PIN check and the brute-force table; `services/upload-crypto.ts` the
  segment-by-segment sealing of a resumable upload; `services/derivatives.ts` the sealed
  thumbnails and OCR; `services/shares.ts` the grant.
- Everything else sees encryption as columns (`encryption`, `fk_ct`, `meta_ct`, `keyring_id`)
  and as a stream transform: `stageUpload` encrypts on the way in, `send-file.ts` decrypts the
  needed segments on the way out, the UDC source and the lists call `reveal`.

## 10. The admin transfer

`services/transfer.ts` moves every row of a set of instances from one tenant to another in
**one transaction**: files (every version, soft-deleted too), folders (merged by path into an
existing destination folder; a live source folder revives a deleted destination one), share
links (same tokens), processing jobs, OCR metadata, finished uploads; `user_map` rewrites the
`*_by` columns; `tenant`-encrypted keys are re-wrapped for the destination (the wrap AAD
carries the tenant id); a `keyring`, `caller` or `client` file refuses the whole call (the
server holds no key to re-wrap). Blobs stay where they are — they are content-addressed and
shared. Afterwards both tenants' statistics are recomputed and `purged` / `created` events go
out on both channels so live lists of both tenants update. Idempotent; `dry_run` runs the same
statements and rolls back. Reached through `POST /admin/transfer` and `vola transfer`.

## 11. `@vola/cli`

`packages/cli/src/program.ts` builds one Commander tree over `@vola/server`'s services and
database (`connect`, `runMigrations`, `createTenant`, `createApiKey`, `transferInstances`,
`KeyFile`, …) — no HTTP except `demo-seed`, which drives the API with `@vola/client`. The
database is opened lazily, so `--help` and usage errors never connect; `--json` switches every
command to machine-readable output; key and transfer commands write audit events when memento is
configured. Every command: [CLI.md](CLI.md).

## 12. `@vola/client` and `@vola/react`

`@vola/client` is a thin, typed layer over `fetch`: one method per route grouped like the API
(`files`, `folders`, `uploads`, `shares`, `keyrings`, `stats`, `keys`, `admin`, `udc`), errors
as `VolaError` / `VolaLockedError` / `VolaIntegrityError`, the resumable protocol with a
fingerprint store, the unlock token held in memory and never in a URL, the share-grant fragment
turned into the header, and `contentKey` refused in a browser. `@vola/react` puts components
over it on `@jsudc/react`'s `UdcDataView` and `/udc/subscribe` ([REACT.md](REACT.md)).

## 13. Testing

- **Unit and integration** (`packages/*/test`, Vitest): the server's tests run against a real
  PostgreSQL (`VOLA_DATABASE_URL_TEST`, migrated with `pnpm db:migrate:test`) and a real Redis
  where the feature needs one (keyrings, the worker, `subscribe`), with a temporary storage
  directory; coverage ≥ 80 % per package is enforced in CI.
- **E2E** (`packages/e2e`): the built server (or a running one, `VOLA_E2E_URL`) over HTTP — the
  file API, tus with `tus-js-client`, the WebSocket, encryption, the SDK, the examples site.
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, build, tests with coverage, E2E,
  `pnpm pack --dry-run` of every public package, the relative-link check of the documents,
  then the Docker image built and the E2E suite run against `docker-compose.yaml`.
