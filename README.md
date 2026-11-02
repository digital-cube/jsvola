# JSVola

[![CI](https://github.com/digital-cube/jsvola/actions/workflows/ci.yml/badge.svg)](https://github.com/digital-cube/jsvola/actions/workflows/ci.yml)
[![Release](https://github.com/digital-cube/jsvola/actions/workflows/release.yml/badge.svg)](https://github.com/digital-cube/jsvola/actions/workflows/release.yml)

Self-hosted, multi-tenant, **content-addressable file storage** for applications: a host
application (a ticketing system, a CMS, a chat) hands its files to vola and gets back ids,
downloads with `Range`, thumbnails, OCR text, share links, folders and versions — per tenant,
per entity, with encryption at rest when asked. The TypeScript port of vola-spp: Fastify 5 +
Drizzle/PostgreSQL + Redis, published as `@vola/*` packages on npm and as one Docker image.

**What makes it vola**

- **Content-addressable.** Bytes are stored once under their SHA-256
  (`blobs/aa/bb/cc/<hash>`); the same file uploaded twice — by anyone, in any tenant — is one
  blob, and a blob leaves the disk only when no row references it. Thumbnails sit next to the
  blob and are shared the same way.
- **The instance model.** A file belongs to a tenant and to an **instance** of the host
  application — `(instance_type, instance_id)`, e.g. `tickets/<uuid>` — and optionally to a
  virtual folder path, a slug (`avatar`: one live file per name) and a version chain. The host
  keeps its own data model; vola keeps the bytes and the hierarchy.
- **Tenants and keys.** Every row is tenant-scoped; API keys carry scopes; an admin key acts for
  any tenant. Another tenant's file is `404`, never `403`.
- **Encryption at rest, four ways.** `tenant` (a server key file), `keyring` (a 6-digit PIN per
  user with recovery and lock-out), `caller` (a key per request, nothing kept) and `client` (a
  blob the client sealed). AES-256-GCM in 1 MiB segments under a random per-file key, so `Range`
  and resumable uploads work on encrypted files too; thumbnails and OCR of encrypted files are
  sealed under the same key; a share of an encrypted file carries its secret in the URL fragment.
- **Resumable uploads** (tus 1.0), **live lists** over WebSocket (UDC `subscribe`), a worker for
  thumbnails (WebP, sharp) and OCR (tesseract), share links with password / expiry / download
  cap, statistics, an admin transfer of instances between tenants, and an optional audit trail
  in [memento](https://github.com/digital-cube/jsmemento).

## Packages

| package | what |
|---|---|
| [`@vola/core`](packages/core) | Zod schemas, inferred types, header and error constants shared by server, CLI and clients |
| [`@vola/lookups`](packages/lookups) | the controlled vocabulary: `lookups.yaml` + CSV translations, candidates, promotion |
| [`@vola/server`](packages/server) | Fastify plugin + standalone server, the worker, Drizzle schema and migrations, CAS storage, UDC collections |
| [`@vola/cli`](packages/cli) | the `vola` command line: tenants, keys, key and pepper files, transfer, lookups, the demo seeder |
| [`@vola/client`](packages/client) | the fetch SDK for every route — Node 24+ and browsers |
| [`@vola/react`](packages/react) | React 19 components: file browser, uploads, thumbnails, PIN gate, share dialog |
| [`apps/examples`](apps/examples) | the examples site: one page per capability over a demo instance, served by the server at `/` (private) |
| [`packages/e2e`](packages/e2e) | end-to-end tests against the built server (private) |

Every package and the image share one version. Install what you need:

```sh
pnpm add @vola/client            # a backend or a browser talking to a vola server
pnpm add @vola/react @vola/client @jsudc/react @jsudc/core @tanstack/react-query   # a React app
pnpm add @vola/server @vola/core # embed the Fastify plugin in your own server
```

## Quick start

Docker (or podman) and `curl`. The stack is the server, the worker, PostgreSQL 16 and Redis 7;
the image is `ghcr.io/digital-cube/jsvola`. Keys and tenants are made with the bundled `vola`
CLI inside the container.

```sh
git clone https://github.com/digital-cube/jsvola.git && cd jsvola
docker compose -f docker-compose.yaml up -d --wait          # server :8300 + worker + PostgreSQL + Redis
curl localhost:8300/vola/health/ready                       # {"status":"ok","checks":{"database":"ok","redis":"ok"}}

docker compose -f docker-compose.yaml exec vola vola create-tenant --slug acme --name "Acme Inc"
docker compose -f docker-compose.yaml exec vola vola create-key --tenant acme --name backend --env live \
    --scopes files:read,files:write,folders:read,folders:write,shares:write
#   → prints vola_live_… ONCE; only its SHA-256 is stored
export KEY=vola_live_…
export TICKET=$(uuidgen | tr A-F a-f)                       # the host application's entity: tickets/<uuid>
```

Upload, read, download:

```sh
# upload (multipart, streamed) → 201 with the file info; the same bytes twice are one blob
curl -s -H "Authorization: Bearer $KEY" -F file=@README.md -F 'metadata={"source":"readme"}' \
     localhost:8300/vola/files/tickets/$TICKET | tee /tmp/file.json | jq '{id, filename, size, mime_type, kind, hash}'
export FILE=$(jq -r .id /tmp/file.json)

# metadata, the instance's files, the folder listing
curl -s -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/info | jq .filename
curl -s -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET | jq '.files | length'

# download: HEAD, Range/206, ETag/304, ?download=1
curl -sI -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE | grep -iE '^(HTTP|etag|accept-ranges|content-type)'
curl -s -H "Authorization: Bearer $KEY" -H "Range: bytes=0-9" -o /dev/null -w '%{http_code}\n' \
     localhost:8300/vola/files/tickets/$TICKET/$FILE                                    # 206
curl -s -H "Authorization: Bearer $KEY" "localhost:8300/vola/files/tickets/$TICKET/$FILE?download=1" -o copy.md && cmp README.md copy.md

# a named file (PUT upserts), a folder, a share link
curl -s -X PUT -H "Authorization: Bearer $KEY" -F file=@LICENSE localhost:8300/vola/files/users/$TICKET/slug/avatar | jq .slug
curl -s -H "Authorization: Bearer $KEY" -F file=@CHANGELOG.md -F folder_path=docs/2026 localhost:8300/vola/files/tickets/$TICKET | jq .folder_id
curl -s -H "Authorization: Bearer $KEY" localhost:8300/vola/folders/tickets/$TICKET/docs | jq '.subfolders[].name'   # "2026"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"file_id":"'$FILE'","max_downloads":3}' localhost:8300/vola/shares | jq -r .url  # anyone with the link: curl <url>

# delete (soft) and purge
curl -s -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE | jq .deleted_at
curl -s -X DELETE -H "Authorization: Bearer $KEY" localhost:8300/vola/files/tickets/$TICKET/$FILE/purge   # {"files":1,"blobs":1} — the blob goes when no row of any tenant cites its hash
```

Encrypted files and keyrings need the two secret files, made once by the CLI in the image
(so the container's user owns them) and backed up:

```sh
mkdir -p secrets && chmod 700 secrets
docker compose -f docker-compose.yaml run --rm --no-deps -v "$PWD/secrets:/out" vola \
    sh -c 'vola keys-generate --path /out/vola.key && vola pepper-generate --path /out/vola.pepper'
#   ./secrets is mounted read-only at /run/secrets/vola in vola and vola-worker; picked up on the next request, no restart.
#   (rootless podman: the container's user is a subordinate uid on the host — `chmod 777 secrets` for this one command, then 755.)
curl -s -X POST -H "Authorization: Bearer $KEY" -H "X-Vola-Encryption: tenant" -F file=@README.md \
     localhost:8300/vola/files/tickets/$TICKET | jq '{encryption, filename, size}'   # {"encryption":"tenant","filename":"README.md","size":…}
docker compose -f docker-compose.yaml exec vola vola keys-status                       # 1 key line, 1 tenant-encrypted file
```

Without them the server runs and serves plain files; anything encrypted answers
`503 encryption_unavailable`. **Without them, once files are encrypted, those files are lost** —
[DEPLOYMENT.md](docs/DEPLOYMENT.md#the-key-file-and-the-pepper-file).

From an application, the same through the SDK:

```ts
import { VolaClient } from "@vola/client";
const vola = new VolaClient({ baseUrl: "http://localhost:8300/vola", apiKey: process.env.VOLA_API_KEY, userId: "user-42" });
const info = await vola.files.upload("tickets", ticketId, file, { folderPath: "docs/2026", encryption: "tenant" });
const response = await vola.files.download("tickets", ticketId, info.id, { range: { start: 0, end: 1023 } });
const thumb = await vola.files.thumb("tickets", ticketId, info.id, 256);   // {status: "ready" | "generating" | "failed"}
```

## Development

Node 24+, pnpm 11 (`corepack enable`), Docker or podman for PostgreSQL + Redis.

```sh
pnpm install
cp .env.example .env
docker compose up -d                 # PostgreSQL 16 + Redis 7 (compose.yaml; also creates vola_test)
pnpm db:migrate && pnpm db:migrate:test
pnpm dev                             # http://localhost:8300/vola/health/live — tsx watch, from source
pnpm dev:worker                      # the worker, in a second terminal
pnpm vola create-tenant --slug acme --name "Acme Inc"
pnpm vola create-key --tenant acme --name local --env test --scopes files:read,files:write
```

| | |
|---|---|
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm typecheck` / `pnpm build` | Turbo over every package |
| `pnpm test` / `pnpm test:cov` | Vitest; server and CLI need the compose databases; coverage ≥ 80 % per package |
| `pnpm test:e2e` | the built server against PostgreSQL + Redis over HTTP (`VOLA_E2E_URL` to point it at a running one) |
| `pnpm db:generate` | a new Drizzle migration after editing `packages/server/src/db/schema.ts` |
| `pnpm vola lookups validate` | `lookups.yaml` + `i18n/translations.csv` |

`.env` is not loaded automatically: export the variables (`set -a; . ./.env; set +a`) or rely on
the defaults, which match `compose.yaml`. CI (`.github/workflows/ci.yml`) runs lint, type check,
build, unit tests with coverage, the E2E suite, a `pnpm pack --dry-run` of every public package,
the relative-link check of the documents, and builds the image and runs the E2E suite against
`docker-compose.yaml`. Releases are a tag ([CONTRIBUTING.md](docs/CONTRIBUTING.md#releasing)).

## Documentation

- [docs/API.md](docs/API.md) — every route: method, path, scope, body, answers, error codes; `Range`/`HEAD` rules, the **202 thumbnail rule**, tus, shares and grants, keyrings, UDC
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — packages, the upload flow (`finalizeUpload`), the CAS layout, the worker and its queues, the event bus and `subscribe`, transfer, the database schema
- [docs/CRYPTO.md](docs/CRYPTO.md) — encryption at rest: keys, the `JSV` blob format, the four modes, keyrings, what a dump reveals, troubleshooting
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — the image, `docker-compose.yaml`, every `VOLA_*` variable, the key and pepper files, volumes, backups, upgrades
- [docs/CLI.md](docs/CLI.md) — every `vola` command
- [docs/MIGRATION-FROM-VOLA-SPP.md](docs/MIGRATION-FROM-VOLA-SPP.md) — for consumers of vola-spp: route table, auth, what stays the same, the checklist
- [docs/REALTIME.md](docs/REALTIME.md) — the WebSocket protocol of `/udc/subscribe`
- [docs/REACT.md](docs/REACT.md) — `@vola/react` components and hooks
- [docs/AUDIT.md](docs/AUDIT.md) — the optional audit trail in memento
- [docs/EXAMPLES-SITE.md](docs/EXAMPLES-SITE.md) — the examples site and its stage deploy
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — dev setup, tests, commits, releasing
- [CHANGELOG.md](CHANGELOG.md) — releases
- [docs/PLAN.md](docs/PLAN.md), [docs/ANALYSIS.md](docs/ANALYSIS.md) — the v1.0 plan and the vola-spp analysis (background, Serbian)

## License

MIT
