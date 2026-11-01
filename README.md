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
| `@vola/lookups` | controlled vocabularies (instance types, job kinds, …) |
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
| `POST /vola/files/:type/:id` | `files:write` | `file` part + optional `metadata`; `413 file_too_large` over `VOLA_MAX_UPLOAD_BYTES` (512 MiB); `a.pdf` → `a (1).pdf` on a name collision; `folder_path`/`parent_id` → `400 not_supported` until 2.2 |
| `PUT /vola/files/:type/:id/slug/:slug` | `files:write` | upsert of a named file |
| `GET\|HEAD …/:fileId`, `…/slug/:slug` | `files:read` | `Accept-Ranges: bytes`, single `Range` → `206`, outside → `416`; `ETag: "<sha256>"`, `If-None-Match` → `304`; `X-Content-Type-Options: nosniff`; `?download=1`; `last_accessed_*` once a minute (GET only) |
| `GET …/:fileId/info` | `files:read` | metadata, never `fk_ct`/`meta_ct`; `?include_deleted=1` |
| `GET /vola/files/:type/:id` | `files:read` | `created_at desc, id desc`, `?cursor`, `?limit` ≤ 200, `?include_deleted=1` |
| `DELETE …/:fileId` | `files:write` | soft delete (`deleted_at`, `deleted_by`), idempotent |
| `DELETE …/:fileId/purge` | `files:write` | removes the row (and its version chain); the blob and its derived files leave the disk only when no row of any tenant references them |

MIME is detected from the magic bytes (`file-type`), then the extension, then the declared type;
`kind` (`image`, `video`, `audio`, `document`, `spreadsheet`, `presentation`, `archive`, `text`,
`code`, `other`) follows from it. Folders, versions, visibility, resumable uploads, thumbnails and
encryption come with the later tickets of `docs/PLAN.md`.

## Container

```sh
docker compose -f docker-compose.yaml up -d --build
curl localhost:8300/vola/health/live    # {"status":"ok"}
curl localhost:8300/vola/health/ready   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

Configuration is environment only, every variable prefixed `VOLA_` — see `.env.example`.

## License

MIT
