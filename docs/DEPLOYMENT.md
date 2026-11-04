# Deploying JSVola

The image, the compose stack, every `VOLA_*` variable, the two secret files, volumes, backups,
upgrades and a reverse proxy. The routes: [API.md](API.md); the CLI inside the container:
[CLI.md](CLI.md); encryption and what the key files protect: [CRYPTO.md](CRYPTO.md).

Contents: [Quick start](#quick-start-docker-composeyaml) · [The image](#the-image) ·
[Environment variables](#environment-variables) · [The key file and the pepper file](#the-key-file-and-the-pepper-file) ·
[Volumes](#volumes) · [The worker](#the-worker) · [OCR](#ocr) · [Reverse proxy](#behind-a-reverse-proxy) ·
[Backups](#backups) · [Upgrades](#upgrades-and-migrations) · [Scaling](#scaling) ·
[Examples site](#the-examples-site-profile-demo) · [Checking a deployment](#checking-a-deployment)

## Quick start: `docker-compose.yaml`

The production-like stack: the **server** (`vola`), the **worker** (`vola-worker`, the same
image), **PostgreSQL 16** and **Redis 7**. Every `${VAR}` can be set in the shell or in a `.env`
next to the file (`.env.example` lists them all).

```sh
docker compose -f docker-compose.yaml up -d
until curl -sf localhost:8300/vola/health/ready; do sleep 2; done   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}

# a tenant and its first key, with the CLI bundled in the image
docker compose -f docker-compose.yaml exec vola vola create-tenant --slug acme --name "Acme Inc"
docker compose -f docker-compose.yaml exec vola vola create-key --tenant acme --name backend --env live \
    --scopes files:read,files:write,folders:read,folders:write,shares:write      # vola_live_… printed ONCE
docker compose -f docker-compose.yaml exec vola vola create-admin-key --name ops   # vola_admin_… for cross-tenant work
```

What the file wires: `vola` on `${VOLA_HOST_PORT:-8300}:8300`, `VOLA_STORAGE_PATH=/data/storage`
on the `vola-data` volume, the key and pepper files from `${VOLA_SECRETS_DIR:-./secrets}` mounted
read-only at `/run/secrets/vola`, PostgreSQL and Redis bound to `127.0.0.1` by default
(`POSTGRES_BIND`, `REDIS_BIND`), Redis with `appendonly yes`, health checks on every service,
`vola-worker` starting after `vola` is healthy (so after the migrations ran). `compose.yaml`
(no `-f`) is the development infrastructure — PostgreSQL + Redis only — for `pnpm dev`.

## The image

`ghcr.io/digital-cube/jsvola:<version>` (`latest` = the newest tag, `edge` = `main`,
`sha-<short>`); multi-arch `linux/amd64` + `linux/arm64`, signed with build provenance.

```sh
docker build -t jsvola .                           # from the repository root
docker run -d -p 8300:8300 \
  -e VOLA_DATABASE_URL=postgresql://vola:vola@db:5432/vola \
  -e VOLA_REDIS_URL=redis://redis:6379/0 \
  -v vola-data:/data -v ./secrets:/run/secrets/vola:ro \
  ghcr.io/digital-cube/jsvola:1.0.0
docker run … ghcr.io/digital-cube/jsvola:1.0.0 node dist/worker.js     # the worker
```

- Base `node:24-bookworm-slim`; runs as the unprivileged `node` user; `WORKDIR /app`.
- `CMD ["node", "dist/server.js"]`: applies pending Drizzle migrations, then listens on
  `VOLA_PORT` (8300). `SIGTERM` closes the WebSocket clients (`1001`), Redis and the pool,
  then exits 0.
- `node dist/worker.js` — the worker (thumbnails, OCR, sweeps, stats, audit). Needs
  `VOLA_REDIS_URL`, the same `/data` and, for `tenant`-encrypted files, the same key file.
- `/usr/local/bin/vola` — the CLI, with the same environment as the server
  (`docker compose -f docker-compose.yaml exec vola vola --help`).
- `/usr/local/bin/vola-healthcheck` — exit 0 when `GET <prefix>/health/ready` answers 200; the
  image's `HEALTHCHECK`.
- System tools for the worker: `libvips42` (sharp), `poppler-utils` (`pdftoppm`),
  `tesseract-ocr` with `eng`, `srp`, `deu`.
- `/app/config/lookups.yaml`, `/app/config/i18n/translations.csv`, `/app/config/menu.yaml` — the
  bundled vocabulary and menu; mount your own over `/app/config`.
- `/app/ui` — the built examples site (`VOLA_UI_DIR`); `/app/demo-assets` — its demo pack.
- `/data` — the volume: `storage/` (the blobs, derived files, uploads in flight) and
  `candidates/` (unknown lookup values recorded for review).

Set in the image: `VOLA_HOST=0.0.0.0`, `VOLA_PORT=8300`, `VOLA_PREFIX=/vola`,
`VOLA_STORAGE_PATH=/data/storage`, `VOLA_LOOKUPS_PATH=/app/config/lookups.yaml`,
`VOLA_MENU_PATH=/app/config/menu.yaml`, `VOLA_CANDIDATES_DIR=/data/candidates`,
`VOLA_UI_DIR=/app/ui`, `VOLA_DEMO_ASSETS=/app/demo-assets`, `NODE_ENV=production`.

## Environment variables

Every variable the server, the worker and the CLI read (`packages/server/src/config.ts`;
`.env.example` has the same list with comments). Empty values count as unset. An invalid value
stops the process at start with one line naming every bad variable.

### Core

| variable | default | |
|---|---|---|
| `VOLA_DATABASE_URL` | `postgresql://vola:vola@localhost:5432/vola` | PostgreSQL. **Set it.** The server migrates it at start; the CLI uses the same |
| `VOLA_DATABASE_URL_TEST` | `postgresql://vola:vola@localhost:5432/vola_test` | the test suites only |
| `VOLA_REDIS_URL` | *(unset)* | Redis: the job queue, file events across processes, unlock tokens, the share-password counter. Unset: one process, synchronous jobs, in-process events, **no keyrings** |
| `VOLA_HOST` / `VOLA_PORT` | `0.0.0.0` / `8300` | the listener |
| `VOLA_PREFIX` | `/vola` | the path every route is mounted under |
| `VOLA_PUBLIC_URL` | *(unset)* | the origin clients reach the server on (`https://files.example.com`), used to build a share link's `url`; unset: the request's `Host` and protocol. Set it behind a proxy |
| `VOLA_TRUST_PROXY` | `false` | take the client address from `X-Forwarded-For` (the demo routes' rate limit, the logs). Only behind a proxy that sets it |
| `VOLA_LOG_LEVEL` | `info` | pino: `fatal` `error` `warn` `info` `debug` `trace` `silent`; JSON on stdout; secret headers redacted at every level |

### Storage and uploads

| variable | default | |
|---|---|---|
| `VOLA_STORAGE_PATH` | `var/storage` (image: `/data/storage`) | the content-addressable store: `blobs/`, `tmp/`, `uploads/`. **Back it up with the database** |
| `VOLA_MAX_UPLOAD_BYTES` | `536870912` (512 MiB) | the largest file one upload may carry (multipart and tus); over it `413 file_too_large` |
| `VOLA_UPLOAD_TTL_HOURS` | `24` | hours an unfinished resumable upload is kept before its part file and row are swept |

### Worker, thumbnails, OCR

| variable | default | |
|---|---|---|
| `VOLA_WORKER_ENABLED` | `auto` | `auto`: jobs go to the worker when Redis is set; `1`: insist (without Redis one ERROR line, then synchronous); `0`: always synchronous — thumbnails render inline on `/thumb`, OCR does not run. **Use `0` when Redis is there but no worker process runs**, or `/thumb` answers `202` forever |
| `VOLA_WORKER_CONCURRENCY` | `2` | jobs one worker process runs at once |
| `VOLA_QUEUE_PREFIX` | `vola` | the Redis key prefix of the queue; server and worker must agree; several deployments may share one Redis with different prefixes |
| `VOLA_OCR_ENABLED` | `auto` | `auto`: an OCR job per eligible upload, run when `tesseract` is installed (otherwise `SKIPPED` with one WARN); `1`: the worker refuses to start without tesseract; `0`: no OCR job is ever created |
| `VOLA_OCR_LANGS` | `eng+srp+deu` | tesseract's `-l`, codes of the `OcrLanguages` vocabulary; an unknown or uninstalled code stops the worker at start |
| `VOLA_OCR_MAX_PAGES` | `20` | pages of a PDF the OCR reads, from the first |
| `VOLA_OCR_TIMEOUT_S` | `120` | seconds one page (or image) may take |
| `VOLA_STATS_TTL_MIN` | `60` | minutes a statistics snapshot may age before the worker's `refresh-stats` job recomputes it (the job runs every half TTL); without a worker a read past the TTL recomputes |

### Encryption

| variable | default | |
|---|---|---|
| `VOLA_KEY_FILE` | `/run/secrets/vola.key` (compose: `/run/secrets/vola/vola.key`) | the key file of the `tenant` provider — one base64 32-byte key per line, the first active. `vola keys-generate`. The worker reads it too. **Back it up** ([below](#the-key-file-and-the-pepper-file)) |
| `VOLA_PEPPER_FILE` | `/run/secrets/vola.pepper` (compose: `/run/secrets/vola/vola.pepper`) | the pepper file of the `keyring` provider — the Argon2 secret of every PIN and recovery key, same format. `vola pepper-generate`. The worker does not need it. **Back it up with the key file** |
| `VOLA_UNLOCK_TTL_S` | `150` | seconds an unlock token lives without a request (5 … 86400); every request that carries it starts the count again |
| `VOLA_ENC_INLINE_DERIVE_MAX_BYTES` | `26214400` (25 MiB) | the largest encrypted file a thumbnail or OCR pass is made of (the plaintext is decrypted into memory); larger files get no derivative; `0` turns derivatives of encrypted files off |

### Real-time

| variable | default | |
|---|---|---|
| `VOLA_WS_HEARTBEAT_MS` | `30000` | a WebSocket ping this often (≥ 1000); a client that missed the last one is cut off |
| `VOLA_WS_MAX_BUFFERED` | `1000` | unwritten messages a slow client may pile up before it is closed with `4008` |

### Vocabulary and menu

| variable | default | |
|---|---|---|
| `VOLA_LOOKUPS_PATH` | `lookups.yaml` at the repository root (image: `/app/config/lookups.yaml`) | the controlled vocabulary served by `GET /lookups`; missing → an empty vocabulary with a warning |
| `VOLA_TRANSLATIONS_PATH` | `i18n/translations.csv` next to the lookups | the label sheet |
| `VOLA_RECORD_CANDIDATES` | `true` | record values the vocabulary does not know, for review (`vola lookups candidates`) |
| `VOLA_CANDIDATES_DIR` | `var/candidates` next to the lookups (image: `/data/candidates`) | where they are recorded |
| `VOLA_MENU_PATH` | `menu.yaml` at the repository root (image: `/app/config/menu.yaml`) | the examples site's sidebar, served as the `menu` UDC collection; missing → no `menu` collection |

### Audit (memento)

| variable | default | |
|---|---|---|
| `VOLA_MEMENTO_URL` | *(unset)* | the memento API base (`https://memento.example.com/memento`). **Both or neither** with the key |
| `VOLA_MEMENTO_API_KEY` | *(unset)* | a memento key with the `write` scope. With both set, destructive and security-relevant operations become memento events ([AUDIT.md](AUDIT.md)); the worker pushes them (give it the same two variables), or the server does, fire-and-forget, without Redis |

### The examples site

| variable | default | |
|---|---|---|
| `VOLA_UI_DIR` | *(unset)* (image: `/app/ui`) | a built single-page app served at `/` and `/en/` with an `index.html` fallback; unset: the API only |
| `VOLA_EXAMPLES` | `false` | the demo routes under `/examples` ([EXAMPLES-SITE.md](EXAMPLES-SITE.md)); `true` needs both keys below |
| `VOLA_DEMO_API_KEY` / `VOLA_DEMO_WRITE_KEY` | *(unset)* | the visitor's **read-only** key and the server's write key (`vola demo-keys` prints a pair); stored by the server at its start |
| `VOLA_DEMO_TENANT` | `demo` | the demo tenant, created when missing |
| `VOLA_DEMO_INSTANCE_TYPE` / `VOLA_DEMO_INSTANCE_ID` | `demo` / `00000000-0000-4000-8000-000000000001` | the one instance the site shows |
| `VOLA_DEMO_MAX_UPLOAD_BYTES` | `5242880` (5 MiB) | the write proxy's upload cap |
| `VOLA_DEMO_TTL_HOURS` | `24` | a visitor's uploads, keyrings and folders are purged after this |
| `VOLA_DEMO_RATE_LIMIT` | `60` | writes one address may make per ten minutes |
| `VOLA_DEMO_PURGE_INTERVAL_MIN` | `15` | how often the purge runs; `0` never |
| `VOLA_URL`, `VOLA_DEMO_ASSETS` | `http://localhost:8300/vola`, `apps/examples/assets` (image: `/app/demo-assets`) | `vola demo-seed`: the server and the pack |

`docker-compose.yaml` additionally reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_PORT`, `POSTGRES_BIND`, `REDIS_PORT`, `REDIS_BIND`, `VOLA_HOST_PORT`, `VOLA_IMAGE`,
`VOLA_SECRETS_DIR` and `COMPOSE_PROFILES`.

## The key file and the pepper file

Two small files hold everything encryption depends on. **Without the key file every
`tenant`-encrypted file of every tenant is noise, and every keyring unlock fails; without the
pepper file no keyring can be unlocked or recovered. There is no recovery path — that is the
point of the design.** The server starts without them and serves plain files; anything
encrypted answers `503 encryption_unavailable` until they are there.

| | key file | pepper file |
|---|---|---|
| variable | `VOLA_KEY_FILE` | `VOLA_PEPPER_FILE` |
| format | one base64 32-byte key per line; the **first** line is active, older lines stay for what they wrapped | the same |
| who needs it | the server and **the worker** (derivatives of `tenant` files); the CLI for `transfer` and `keys-status` | the server only (`pepper-status` in the CLI) |
| protects | the file keys of `tenant` files (HKDF per tenant), the master keys of unlocked keyrings while they sit in Redis | the PIN and recovery wraps of every keyring (the Argon2 secret) |
| make it | `vola keys-generate [--path]` — 0600, refuses to overwrite | `vola pepper-generate [--path]` |
| status | `vola keys-status` — files per line, `NO LINE` for files whose key is gone | `vola pepper-status` — keyrings per line |

**Generate** (once, before the first encrypted upload) with the CLI in the image, so the files
are owned by the container's `node` user and nothing else needs to read them:

```sh
mkdir -p secrets && chmod 700 secrets
docker compose -f docker-compose.yaml run --rm --no-deps -v "$PWD/secrets:/out" vola \
    sh -c 'vola keys-generate --path /out/vola.key && vola pepper-generate --path /out/vola.pepper'
ls -l secrets        # -rw------- … vola.key, vola.pepper (one base64 32-byte line each)
```

`./secrets` is `VOLA_SECRETS_DIR`, mounted read-only at `/run/secrets/vola` in `vola` and
`vola-worker`. The files are read on first use and re-read when their mtime changes: no restart
after they appear or after a rotation. Under **rootless podman** the container's `node` user is
a subordinate uid on the host: make the directory writable for the one command
(`chmod 777 secrets`, then `chmod 755`), or run the stack with `--userns=keep-id`. Files made on
the host (`openssl rand -base64 32 > secrets/vola.key` is the same format) must be readable by
that uid — `vola keys-status` inside the container says `unusable` or `not readable` when they
are not.

**Back up** both files, separately from the database and storage backup (a backup that holds
the blobs, the database and the key file together is a backup an attacker can read; one that
holds the first two without the key is what the encryption is for). A password manager entry,
a sealed envelope, a secrets manager — anything that survives the loss of the host. Check the
restore: `vola keys-status` and `vola pepper-status` against the restored files must show no
`NO LINE`.

**Rotate by prepending a line**, never by replacing one:

```sh
(echo "$(openssl rand -base64 32)"; cat secrets/vola.key) > vola.key.new && install -m 600 vola.key.new secrets/vola.key
```

New uploads wrap under the new line at once; an existing file opens with the line that wrapped
it and is re-wrapped under the active line on its next download or `info` (`vola keys-status`
shows how many files still depend on each older line — a line may be removed only when its
count is zero). A keyring moves to the active pepper line at its next unlock. The whole model,
including what a dump of each component reveals: [CRYPTO.md](CRYPTO.md) § 4, § 5, § 8.8.

## Volumes

| mount | what | |
|---|---|---|
| `/data` (`vola-data`) | `storage/blobs` — the content-addressed bytes, the derived files; `storage/tmp` — multipart uploads in flight; `storage/uploads` — resumable uploads in flight; `candidates/` — unknown lookup values | **the same volume in `vola` and `vola-worker`** — the worker writes thumbnails next to the blobs |
| `/run/secrets/vola` (`./secrets`, read-only) | `vola.key`, `vola.pepper` | both services |
| `/var/lib/postgresql/data` (`postgres-data`) | PostgreSQL | |
| `/data` of `redis` (`redis-data`) | Redis AOF — the job queue, unlock tokens; losing it loses queued jobs (re-requested on the next `/thumb`) and logs every keyring out | |
| `/app/config` | optional: your own `lookups.yaml`, `i18n/`, `menu.yaml` over the bundled ones | |

Storage on a network file system works (every write is `tmp` + `fsync` + `link`/`rename` within
the same directory tree); the server and the worker must see the same tree.

## The worker

The worker is a second process of the same image (`node dist/worker.js`), consuming the BullMQ
queue on Redis: thumbnails, OCR, the expired-upload sweep, the statistics refresh, audit
pushes ([ARCHITECTURE.md § 6](ARCHITECTURE.md#6-the-worker-and-its-queues)). It needs
`VOLA_DATABASE_URL`, `VOLA_REDIS_URL`, the same `VOLA_STORAGE_PATH` (the same volume), the same
`VOLA_QUEUE_PREFIX`, the key file for `tenant`-encrypted derivatives, and the memento
variables if the audit is on. Migrations are the server's job: start the worker after the
server is healthy (compose does). It logs `vola worker ready` and exits on `SIGTERM` after the
running jobs finish.

A deployment **without** a worker is supported: thumbnails render on `/thumb` (`200`, the real
image, a little slower), OCR does not run, nothing is recorded in `vola_processing_job`. Set
`VOLA_WORKER_ENABLED=0` in that case if Redis is configured — otherwise jobs are queued for
nobody and `/thumb` answers `202` with a grey placeholder forever.

## OCR

The image ships `tesseract-ocr` with English, Serbian and German and `poppler-utils`
(`pdftoppm`). A worker on another host needs the same:
`apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-srp tesseract-ocr-deu poppler-utils`.
`VOLA_OCR_LANGS` names the languages (`eng+srp+deu`); a language the installed tesseract lacks
stops the worker at start with a clear line. OCR runs only on plain and `tenant`-encrypted
files; `keyring` / `caller` files get none ([CRYPTO.md § 11](CRYPTO.md#11-thumbnails-and-ocr-of-encrypted-files-phase-63)).
To turn it off everywhere: `VOLA_OCR_ENABLED=0` on the server (no job is created).

## Behind a reverse proxy

- Set `VOLA_PUBLIC_URL=https://files.example.com` so share links are built on the public origin
  (the `url` of `POST /shares`, the examples site's links).
- Set `VOLA_TRUST_PROXY=true` only when the proxy sets `X-Forwarded-For` (the demo rate limit
  and the logs use the client address).
- Allow WebSocket upgrades on `<prefix>/udc/subscribe` (nginx: `proxy_http_version 1.1`,
  `Upgrade` / `Connection` headers; a read timeout above the heartbeat, 30 s by default).
- Raise the proxy's body limit to at least `VOLA_MAX_UPLOAD_BYTES` (512 MiB) for multipart
  uploads, or point large uploads at the resumable protocol (`/uploads`), whose chunks are as
  small as the client makes them (`@vol-a/react` uses 8 MiB).
- Do not buffer responses on download routes (`proxy_buffering off` for `<prefix>/files`,
  `<prefix>/s`, `<prefix>/public`): `Range` and streaming media depend on it.
- Pass `Authorization`, `X-Api-Key`, `X-Tenant-Slug`, `X-User-Id`, `X-Vola-Unlock`,
  `X-Vola-Content-Key`, `X-Share-Password`, `X-Share-Secret` and the `Tus-*` / `Upload-*`
  headers through unchanged. Never log `X-Vola-Content-Key` or `X-Vola-Unlock` at the proxy.
- The examples site, if served, is the same container at `/` (`VOLA_UI_DIR`); the API lives
  under `VOLA_PREFIX`.

## Backups

Durable data lives in **two places that must be backed up together**: PostgreSQL (the rows —
which blob belongs to which file of which tenant, folders, shares, keyrings, OCR text) and
`VOLA_STORAGE_PATH` (the bytes). A database without the blobs is a catalogue of nothing; blobs
without the database are unnamed hashes (and, for encrypted files, unreadable ones). The key
and pepper files are the third place, kept **apart** from the other two ([above](#the-key-file-and-the-pepper-file)).

```sh
# 1. the database
docker compose -f docker-compose.yaml exec -T postgres pg_dump -U vola -Fc vola > vola-$(date +%F).dump
# 2. the storage (the blobs are immutable; a file-level incremental backup works well)
docker run --rm -v jsvola_vola-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/vola-data-$(date +%F).tgz -C /data storage
# 3. the key and pepper files: secrets/vola.key, secrets/vola.pepper — elsewhere
```

Order matters a little: dump the database **first**, then the storage. A blob uploaded between
the two is an orphan on disk (harmless; never served) rather than a row whose blob is missing
(`500 blob_missing` on download). `storage/tmp` and `storage/uploads` can be left out — a
restore only loses uploads that were in flight. Redis needs no backup: the queue is
re-populated by requests, unlock tokens are meant to die, the password counters reset.

**Restore**: start PostgreSQL, `pg_restore -d vola vola-….dump`, restore `storage/` onto the
volume, put the key and pepper files in place, start the server (it runs any pending migration)
and the worker. Check with `vola keys-status` / `vola pepper-status` (no `NO LINE`) and
`GET /stats/storage` with an admin key (the physical numbers against the expectation).

## Upgrades and migrations

All `@vol-a/*` packages and the image share one version; the changelog is [CHANGELOG.md](../CHANGELOG.md).

1. Read the release notes for the version you are jumping to (a migration, a changed default,
   a new variable).
2. Back up ([above](#backups)).
3. `docker compose -f docker-compose.yaml pull && docker compose -f docker-compose.yaml up -d --wait`.
   The new `vola` container **applies the pending Drizzle migrations at start**, before it
   listens; the worker waits for it to be healthy. Migrations are forward-only and additive in
   1.x (new columns, new tables, widened CHECKs) and run inside a transaction each.
4. `curl …/vola/health/ready`, then the logs of `vola` (`migrations applied` / the list) and
   `vola-worker` (`vola worker ready`).

Rolling back means restoring the backup of step 2: the schema has no down migrations. For a
larger deployment run the migration explicitly before the new servers start —
`docker compose -f docker-compose.yaml run --rm --no-deps vola vola migrate` — and then roll
the processes. `@vol-a/client` and `@vol-a/react` follow semantic versioning against the server's
API; a `1.x` client speaks to any `1.y` server.

## Scaling

- **Several server processes** share PostgreSQL, Redis and the storage volume; file events
  travel through Redis pub/sub, so a client subscribed on one process sees uploads made through
  another. Put them behind one proxy; no sticky sessions are needed (the unlock token is in a
  header, the WebSocket stays on the process that accepted it).
- **Several workers**: `docker compose -f docker-compose.yaml up -d --scale vola-worker=3`;
  BullMQ hands each job to one of them. Thumbnails of one file may be rendered by different
  workers; each writes its own derived file.
- The repeatable jobs (sweep, stats refresh) are scheduled once in the queue whoever starts
  them, and run on any worker.
- PostgreSQL is the limit for lists and `subscribe` fan-out; the disk for downloads. Encrypted
  downloads cost one AES-GCM pass per segment read.

## The examples site (profile `demo`)

The same image serves the examples site at `/`. Switch it on with the two demo keys and the
`demo` profile, whose `seeder` fills the demo instance with the pack at every `up`:

```sh
docker compose -f docker-compose.yaml run --rm --no-deps vola vola demo-keys     # VOLA_DEMO_API_KEY / VOLA_DEMO_WRITE_KEY → .env
echo VOLA_EXAMPLES=true >> .env
docker compose -f docker-compose.yaml --profile demo up -d --wait
curl -s localhost:8300/vola/examples/config | jq .tenant                           # "demo"
```

Design, limits, the purge and the stage deploy: [EXAMPLES-SITE.md](EXAMPLES-SITE.md).

On podman, `--wait` (here and in the upgrade steps) fails on the worker, which runs without a
health check, even though the stack is fine; leave it out and poll `/vola/health/ready`, as the
quick start does. Rootless podman also needs
`podman unshare chown 1000:1000 secrets` before `vola keys-generate` can write there
([EXAMPLES-SITE.md](EXAMPLES-SITE.md#stage-deploy)).

## The website

`https://stage.vol-a.com/` is `apps/website` (`@vol-a/website`): vola's own website, Astro +
Starlight, static files served by nginx on the stage VM. It is **not part of the image** (the
Dockerfile's turbo filters leave it out) and has no server: one build, swapped in under a symlink.
The examples stack is separate and lives at `https://examples.stage.vol-a.com/`
([EXAMPLES-SITE.md](EXAMPLES-SITE.md#stage-deploy)).

The build reads two variables (`apps/website/src/site.mjs`); the defaults are production's:

| variable | | default | stage |
|---|---|---|---|
| `SITE_URL` | the site's own origin (canonical links, sitemap) | `https://vol-a.com` | `https://stage.vol-a.com` |
| `EXAMPLE_URL` | the examples site ("Open the live examples") | `https://examples.stage.vol-a.com` | the same |

No production examples instance exists yet, so `EXAMPLE_URL` defaults to stage; the default moves
when one does.

On the stage VM, from any copy of the repository:

```bash
deploy/website/stage.sh --install                    # once: links the vhost, nginx -t, reload, deploy
deploy/website/stage.sh                              # every deploy: builds origin/main and swaps it in
deploy/website/stage.sh --branch <name>              # a branch before review
REPO_URL=/home/digital/work/jsvola deploy/website/stage.sh --branch main   # commits not pushed yet
```

It clones or fetches the repository into `/home/digital/sites/stage.vol-a.com/src`, checks out
`origin/<branch>`, installs `@vol-a/website` and its dependencies only (`pnpm install
--frozen-lockfile --filter @vol-a/website...`, pnpm from `packageManager` through corepack, Node 24
from nvm), builds with the stage variables, copies `apps/website/dist` to `releases/<short sha>/`,
repoints `current` atomically, keeps three releases, and fails unless `/` answers 200 and a missing
page the site's 404 through nginx on 127.0.0.1, and `/` answers this build through the edge. The
same commit with the same variables rebuilds nothing. `deploy/website/stage.sh --help` has the
options and exit codes.

The vhost is `deploy/website/nginx/stage.vol-a.com.conf`, linked into
`/etc/nginx/sites-enabled/stage.vol-a.com` from the deployed checkout: `:80` only (TLS ends at the
edge), `server_name stage.vol-a.com;`, `root …/current`, `/_astro/` cached for a year
(content-hashed), the rest `no-cache`, `error_page 404 /404.html`, `absolute_redirect off`.

How the site is put together, and how to record its snippets and screenshots:
[`apps/website/README.md`](../apps/website/README.md).

## Checking a deployment

```sh
curl -fsS https://files.example.com/vola/health/live
curl -fsS https://files.example.com/vola/health/ready                # database and redis
docker compose -f docker-compose.yaml exec vola vola keys-status      # no NO LINE
docker compose -f docker-compose.yaml exec vola vola pepper-status
curl -H "Authorization: Bearer $ADMIN" https://files.example.com/vola/stats/storage   # physical: blobs, derived, uploads
VOLA_E2E_URL=https://files.example.com/vola pnpm test:e2e              # the whole suite against it (creates e2e-… tenants; staging only)
```

A `202` that never turns into a `200` on `/thumb` means a queue nobody consumes: start the
worker or set `VOLA_WORKER_ENABLED=0`. A `503 encryption_unavailable` means a missing key file,
pepper file or Redis — [CRYPTO.md § 7](CRYPTO.md#7-troubleshooting) walks through every
`409` / `423` / `429` / `503`.
