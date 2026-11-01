# Changelog

All notable changes to JSVola. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@vola/*` package and the Docker image
share one version.

## [Unreleased]

### Added

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
