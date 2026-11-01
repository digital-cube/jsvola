# The examples site — `apps/examples` (plan 8.1)

One public site that shows every capability of vola, one page per capability, over a **demo
tenant** with a **read-only key for the visitor** — the way `examples.stage.memento-service.org`
does for memento. The server serves the built site itself (`VOLA_UI_DIR`), so one container
is the API and the site; the compose `demo` profile fills the demo instance with a pack of
files. This page is the design and the operator's guide; [`apps/examples/README.md`](../apps/examples/README.md)
is the developer's.

## What a visitor sees

| route | page | what it shows |
|---|---|---|
| `/examples/browse` | Browse | `VolaFileBrowser` over the demo instance: folders, the `files` UDC data view, thumbnails, the row menu, a drop zone, kept live through `/udc/subscribe` (`?folder=images` opens a folder) |
| `/examples/upload` | Upload | one multipart `POST` under 1 MiB, the resumable protocol above it with progress, cancel and resume; the demo's limits |
| `/examples/thumbnails` | Thumbnails | every size (64–512) × every crop (`cover`, `fit`, `attention`) of a file, each tile's state; **Regenerate** drops the renditions so the `202 → 200` sequence can be watched again |
| `/examples/streaming` | Range & streaming | `<video>` and `<audio>` on `GET /public/:id`; a Range probe that shows the `206`, `Content-Range` and `Accept-Ranges` the page itself got |
| `/examples/share` | Share | `VolaShareDialog`: password, expiry (capped at the demo TTL), most downloads, the link once, list, revoke; the last link opens in a new tab |
| `/examples/encrypted` | Encrypted files | `tenant` mode on seeded files (transparent); `keyring` mode behind `VolaPinGate` over the visitor's private folder, the unlock token counting down, a lock that empties the view |
| `/examples/api` | API | the routes behind the pages and `curl` examples with the demo key |
| `/udc/:collection` | Collections | any collection the server lists (`files`, `menu`) as a plain `UdcDataView` |

The sidebar is the repository's [`menu.yaml`](../menu.yaml), served as the `menu` UDC
collection; the site keeps a built-in copy for a server without it. EN / SR in the header.
**Settings** (header): the API base URL, the visitor's own key (replaces the demo key),
another instance, and the **visitor id** with a "New identity" button.

## How it works

### Keys: a read-only key for the visitor, the server writes for them

- **`VOLA_DEMO_API_KEY`** — read-only (`files:read`, `folders:read`). `GET /vola/examples/config`
  hands it to every visitor (together with the demo instance, the limits and which features
  the server has), so nobody pastes a key. It exists only when **`VOLA_EXAMPLES=true`**;
  otherwise that route and everything below are 404 and the site asks for a key.
- **`VOLA_DEMO_WRITE_KEY`** — `files:write`, `folders:write`, `shares:write`,
  `keyrings:write` (and the reads). It **never leaves the server**: a visitor's write goes to
  **`/vola/examples/write/<route>`** without a key, and the server replays it against
  `<route>` under this key.
- At startup the server **creates the `demo` tenant when missing and stores both keys** (by
  hash, with those scopes) when they are new; a key that exists is checked — a visitor key
  with any write scope, a write key short of one, a key of another tenant, a revoked one:
  the server refuses to start and says why. So a stage `.env` with two keys from
  `vola demo-keys` is a complete deployment; nothing has to be created by hand first.

### The write proxy (`packages/server/src/examples/`)

`ANY /vola/examples/write/<route>` (no key) → the policy (`policy.ts`, `demoAction`) says
what a visitor may do, **on the demo instance only**:

| what | route | guard |
|---|---|---|
| upload | `POST files/demo/<id>` | `Content-Length` ≤ 5 MiB (+ 64 KiB of multipart) else `413`; after the upload the type must be on the list (images, PDF, mp4/webm, mp3/mp4/ogg/wav audio, plain text) else the file is purged again and the answer is `415 demo_mime_not_allowed` |
| resumable | `POST uploads`, `HEAD/PATCH/DELETE uploads/:id` | `Upload-Length` ≤ 5 MiB, the metadata's instance is the demo's; `Location` is rewritten to the proxy; the type is checked when the last `PATCH` completes |
| a visitor's own file / folder | `PATCH/DELETE files/…/:fileId[/purge]`, `POST/PATCH/DELETE folders/…` | a **seeded** file or folder (`created_by = seeder`) is `403`: the pack stays as it is for everyone |
| shares | `POST/GET shares`, `GET/DELETE shares/:id` | the file must be in the demo instance; `expires_at` is capped at `VOLA_DEMO_TTL_HOURS` |
| the visitor's keyring | `GET/POST/PUT/DELETE keyrings/me/*` | the visitor's own principal |

Every proxied request must carry **`X-User-Id: demo-<6–32 lowercase letters or digits>`** —
the site makes one per browser session and keeps it in `sessionStorage`. It is the
`created_by` of everything the visitor makes (what the purge selects on) and the principal
of their keyring. Writes are **rate-limited per address**: `VOLA_DEMO_RATE_LIMIT` (60) per ten
minutes, `429` with `Retry-After` beyond that (`VOLA_TRUST_PROXY=true` behind nginx, so the
address is the visitor's, not the proxy's). Anything else — keys, admin, stats, another
instance, another tenant's file — is `403 demo_forbidden`.

`POST /vola/examples/regenerate/:fileId` drops a demo file's thumbnail renditions
(`storage.removeDerived`), so the next `/thumb` answers `202` and queues the worker again:
the Thumbnails page's button. `POST /vola/examples/purge` (an admin key) runs the purge now.

### The purge (`purge.ts`)

Every `VOLA_DEMO_PURGE_INTERVAL_MIN` (15) minutes, and once at start, everything a visitor
left more than `VOLA_DEMO_TTL_HOURS` (24) ago goes: their **keyrings** (a crypto-shred, as
`POST /keyrings/me/reset` — the files under them go first), their **files** in the demo
instance (every version, soft-deleted rows too; a blob no other row cites is removed from
disk), then their **folders**. The seeder's files are never selected. Shares die with their
capped expiry.

### The site (`apps/examples`)

Vite + React 19 on `@vola/react` and `@jsudc/react`. `VolaProvider` gets a `VolaClient` whose
`fetch` is **`demoFetch`** (`src/connection.tsx`): a request that `needsProxy` — anything but
`GET`/`HEAD`, the whole `/uploads` protocol, `/shares`, `/keyrings/me/*` (not the
`unlock/close` beacon, not the UDC actions, not the demo routes) — is sent to the write proxy
without the key; everything else goes straight to the API with the read-only key. With a key
of the visitor's own nothing is rewritten. The resumable threshold is 1 MiB and the chunk
256 KiB, so the resumable path has room under the 5 MiB cap and the progress bar moves.

The server serves the build at `/` and `/en/` (`packages/server/src/ui.ts`: `index.html` on
every client route for a `GET` that accepts HTML, hashed `assets/*` immutable, JSON `404`
under the API prefix).

## Configuration

| variable | default | |
|---|---|---|
| `VOLA_UI_DIR` | — (image: `/app/ui`) | the built site; empty: API only |
| `VOLA_EXAMPLES` | `false` | the demo routes; `true` needs both keys |
| `VOLA_DEMO_API_KEY` | — | the visitor's read-only key |
| `VOLA_DEMO_WRITE_KEY` | — | the server's write key |
| `VOLA_DEMO_TENANT` | `demo` | the tenant, created when missing |
| `VOLA_DEMO_INSTANCE_TYPE` / `VOLA_DEMO_INSTANCE_ID` | `demo` / `00000000-0000-4000-8000-000000000001` | the one instance the site shows |
| `VOLA_DEMO_MAX_UPLOAD_BYTES` | 5 MiB | the proxy's upload cap |
| `VOLA_DEMO_TTL_HOURS` | 24 | a visitor's things live this long |
| `VOLA_DEMO_RATE_LIMIT` | 60 | writes per address per ten minutes |
| `VOLA_DEMO_PURGE_INTERVAL_MIN` | 15 | `0`: never |
| `VOLA_TRUST_PROXY` | `false` | `X-Forwarded-For` behind a reverse proxy |
| `VOLA_PUBLIC_URL` | — | the origin share links are built on (the stage hostname) |
| `VOLA_SECRETS_DIR` (compose) | `./secrets` | `vola.key` + `vola.pepper`, mounted at `/run/secrets/vola` |

The demo pack and the seeder: [`apps/examples/ASSETS.md`](../apps/examples/ASSETS.md);
`vola demo-seed --help`.

## Stage deploy (for a person, after the merge)

The hostname, DNS record and server are the NON-AI ticket **TCK9D5KENM** (*Stage za jsvola
examples*); nothing in the repository names a host — the site is reached on whatever
`VOLA_PUBLIC_URL` says. In the stage checkout (compose project `jsvola`):

```bash
git pull

# one time: the key pair for .env (nothing is stored; the server stores them at its start)
docker compose -f docker-compose.yaml run --rm --no-deps vola vola demo-keys
#   VOLA_DEMO_API_KEY=vola_live_…
#   VOLA_DEMO_WRITE_KEY=vola_live_…

# one time: the key file and the pepper file (encrypted files and keyrings on the site)
mkdir -p secrets && chmod 700 secrets
docker compose -f docker-compose.yaml run --rm --no-deps -v "$PWD/secrets:/out" vola \
  sh -c 'vola keys-generate --path /out/vola.key && vola pepper-generate --path /out/vola.pepper'

docker compose -f docker-compose.yaml build vola
docker compose -f docker-compose.yaml --profile demo up -d      # vola, vola-worker, postgres, redis, seeder
docker compose -f docker-compose.yaml logs seeder               # "demo pack: 10 uploaded, …"
curl -s https://<host>/vola/examples/config | head -c 200       # the read-only key
```

(`podman-compose` works the same way.) The stage `.env`, next to `docker-compose.yaml`:

```bash
# the site
VOLA_EXAMPLES=true
VOLA_DEMO_API_KEY=vola_live_…            # from `vola demo-keys`
VOLA_DEMO_WRITE_KEY=vola_live_…          # from `vola demo-keys`
VOLA_PUBLIC_URL=https://<host>           # the stage hostname, no path, no trailing slash
VOLA_TRUST_PROXY=true                    # behind nginx / traefik
COMPOSE_PROFILES=demo                    # the seeder at every `up`
VOLA_SECRETS_DIR=./secrets               # vola.key + vola.pepper (default)
# the stack
POSTGRES_PASSWORD=<strong>
VOLA_HOST_PORT=8300                      # what the reverse proxy forwards to
# optional
VOLA_DEMO_TTL_HOURS=24
VOLA_DEMO_RATE_LIMIT=60
VOLA_OCR_ENABLED=auto
```

The reverse proxy forwards the hostname to `VOLA_HOST_PORT` with WebSocket upgrades allowed
(`/vola/udc/subscribe`) and a body limit of at least 6 MiB. After every later change:
`git pull && docker compose -f docker-compose.yaml build vola && docker compose -f docker-compose.yaml --profile demo up -d`.

## Verification

- `pnpm test` — `packages/server/test/examples.test.ts` (the configuration, the tenant and
  keys at startup, the config route, the policy, the proxy end to end, regenerate, the purge,
  the UI serving), `packages/cli/test/demo.test.ts` (`demo-keys`, `demo-seed` against a real
  server with the repository's pack), `apps/examples/test/*` (the shell, the connection and
  `demoFetch`, every page against a fake server).
- `pnpm build && pnpm test:e2e` — `packages/e2e/test/examples.e2e.ts`: the suite's own built
  server with the examples on serves the site at `/` and every page, `/examples/config`
  answers the key, the seeder runs twice, the visitor's key reads and cannot write, a
  thumbnail goes `202 → 200`, the public clip answers `206`, the proxy uploads / refuses /
  caps, and a second server without `VOLA_EXAMPLES` has none of it. Against the compose
  `demo` stack: `VOLA_E2E_URL=http://localhost:8300/vola VOLA_DEMO_API_KEY=… VOLA_DEMO_WRITE_KEY=… pnpm test:e2e`.

## Out of scope

The production site; self-service registration (memento's `service.`); the hostname, DNS
and server (TCK9D5KENM).
