# Changelog

All notable changes to JSVola. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@vola/*` package and the Docker image
share one version.

## [Unreleased]

### Added

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
