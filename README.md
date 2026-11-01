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
| `POST /vola/files/:type/:id` | `files:write` | `file` part + optional `metadata`; `folder_path` (created when missing) or `folder_id` places it; `parent_id` makes it a new version; `413 file_too_large` over `VOLA_MAX_UPLOAD_BYTES` (512 MiB); `a.pdf` → `a (1).pdf` on a name collision in the same folder |
| `PUT /vola/files/:type/:id/slug/:slug` | `files:write` | upsert of a named file |
| `GET\|HEAD …/:fileId`, `…/slug/:slug`, `…/path/*` | `files:read` | `Accept-Ranges: bytes`, single `Range` → `206`, outside → `416`; `ETag: "<sha256>"`, `If-None-Match` → `304`; `X-Content-Type-Options: nosniff`; `?download=1`; `last_accessed_*` once a minute (GET only); by id also another tenant's `is_public` file |
| `GET …/:fileId/info` | `files:read` | metadata, never `fk_ct`/`meta_ct`; `?include_deleted=1` |
| `GET …/:fileId/versions` | `files:read` | the version chain, newest first; `?include_deleted=1` |
| `GET /vola/files/:type/:id` | `files:read` | `created_at desc, id desc`, `?cursor`, `?limit` ≤ 200, `?include_deleted=1` |
| `PATCH …/:fileId` | `files:write` | `{folder_path}` moves (`""` = root), `{filename}` renames (`409 file_exists`), `{is_public}`, `{is_global_public}` (`409 encrypted_not_public` on an encrypted file) |
| `DELETE …/:fileId` | `files:write` | soft delete (`deleted_at`, `deleted_by`), idempotent |
| `DELETE …/:fileId/purge` | `files:write` | removes the row and its whole version chain; the blob and its derived files leave the disk only when no row of any tenant references them |
| `GET\|HEAD /vola/public/:fileId` | — | anonymous download of an `is_global_public` file (`Cache-Control: public, max-age=300`); anything else is `404` |

MIME is detected from the magic bytes (`file-type`), then the extension, then the declared type;
`kind` (`image`, `video`, `audio`, `document`, `spreadsheet`, `presentation`, `archive`, `text`,
`code`, `other`) follows from it.

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
finished within `VOLA_UPLOAD_TTL_HOURS` (24) is swept, part file and row, by a periodic job in
the server process (every 15 minutes; a BullMQ repeatable job once phase 4.1 brings the worker).

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

## Container

```sh
docker compose -f docker-compose.yaml up -d --build
curl localhost:8300/vola/health/live    # {"status":"ok"}
curl localhost:8300/vola/health/ready   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

Configuration is environment only, every variable prefixed `VOLA_` — see `.env.example`.

## License

MIT
