# vola examples

Every capability of vola behind one sidebar: a Vite + React 19 app on **`@vola/react`** and
**`@jsudc/react`**, one page per capability, over a **demo instance** with the server's
**read-only visitor key** — served by `@vola/server` itself at `/` and `/en/`
(`VOLA_UI_DIR`). The design, the write proxy and the stage deploy are in
[`docs/EXAMPLES-SITE.md`](../../docs/EXAMPLES-SITE.md); the demo pack in [`ASSETS.md`](ASSETS.md).

| route | page |
|---|---|
| `/` | redirect to `/examples/browse` |
| `/examples/browse` | [Browse](#browse) — `VolaFileBrowser`, live (`?folder=images`) |
| `/examples/upload` | [Upload](#upload) — multipart and resumable, through the write proxy |
| `/examples/thumbnails` | [Thumbnails](#thumbnails) — every size × crop, `202 → 200`, Regenerate |
| `/examples/streaming` | [Range & streaming](#range--streaming) — `<video>`, `<audio>`, a Range probe |
| `/examples/share` | [Share](#share) — `VolaShareDialog`, the last link |
| `/examples/encrypted` | [Encrypted files](#encrypted-files) — `tenant` and `keyring` modes |
| `/examples/api` | [API](#api) — the routes, `curl` with the demo key |
| `/udc/:collection` | any collection the server lists (`files`, `menu`) as a plain `UdcDataView` |
| anything else | redirect to `/` |

## Run it

From the repository root, with the development infrastructure (`compose.yaml`) up:

```bash
pnpm install && pnpm db:migrate
pnpm vola demo-keys                          # two keys for .env: VOLA_DEMO_API_KEY, VOLA_DEMO_WRITE_KEY
pnpm vola keys-generate --path secrets/vola.key          # encrypted files (optional)
pnpm vola pepper-generate --path secrets/vola.pepper     # keyrings (optional, needs Redis)

# terminal 1: the server with the examples on (it creates the `demo` tenant and stores the keys)
VOLA_EXAMPLES=true VOLA_DEMO_API_KEY=vola_live_… VOLA_DEMO_WRITE_KEY=vola_live_… \
VOLA_KEY_FILE=secrets/vola.key VOLA_PEPPER_FILE=secrets/vola.pepper pnpm dev
# terminal 2: the worker (thumbnails 202 → 200, OCR)
pnpm dev:worker
# once: the demo pack
pnpm vola demo-seed --url http://localhost:8300/vola --key vola_live_…write… --assets apps/examples/assets

# terminal 3: the site
cd apps/examples && pnpm dev                 # http://localhost:5174, /vola proxied to :8300
```

The page opens Browse already connected: with no key of its own it asks
`GET /vola/examples/config` and uses the server's read-only key; writes go to
`/vola/examples/write/…`. Without `VOLA_EXAMPLES` the route answers 404 and the page asks for
a key (Settings). `VOLA_SERVER=http://localhost:8310 pnpm dev` points the proxy elsewhere;
`.env.example` lists `VITE_VOLA_BASE_URL` and `VITE_VOLA_API_KEY` for development.

Or skip Vite: `pnpm --filter @vola/examples build` and start the server with
`VOLA_UI_DIR=apps/examples/dist` — the site at `http://localhost:8300/`. The Docker image does
exactly that (`/app/ui`); `docker compose -f docker-compose.yaml --profile demo up -d` is the
whole stack with the seeder.

## The pages

### Browse

`<VolaFileBrowser instanceType instanceId folderPath urlState="window">` over the demo
instance: breadcrumbs and folders, the `files` UDC data view (search, filters, infinite rows),
`VolaThumb` in the thumbnail column, the row menu (download, rename, move, delete, versions,
share, visibility), the whole surface a drop zone. One WebSocket to `/udc/subscribe` keeps it
live — open the page twice and watch. The seeded files answer `403` to a rename or delete;
what a visitor uploads is theirs for 24 h.

### Upload

`useVolaUpload()` shared by a `VolaUploadButton`, a drop zone and the `VolaUploadList`. Under
1 MiB one multipart `POST files/demo/<id>`; above it `POST /uploads` + `PATCH` in 256 KiB
chunks with progress, cancel and resume (the fingerprint survives a reload). Both through the
write proxy, within its limits (5 MiB, images / PDF / short media / text, 60 writes per ten
minutes per address). Files land in `uploads/`.

### Thumbnails

A picker over the images and PDFs of the instance, then a table: rows `/thumb/64 … 512`,
columns `?crop=cover | fit | attention`, each cell a `VolaThumb` with its state (`202`
`generating`, `200` `ready`, `404` `none`, `failed`). **Regenerate** calls
`POST /vola/examples/regenerate/:fileId` (the server drops the renditions) and empties the
provider's blob cache, so every tile asks again: `202` and the placeholder first, `200` when
the worker is done. A server without a worker renders inline and shows `200` at once.

### Range & streaming

The seeded clip and tone are `is_global_public`: `<video>` and `<audio>` load
`/vola/public/:id` without a key, and the browser seeks with `Range`. The **Range probe**
makes the same request from the page (`GET` with `Range: bytes=from-to`, or `HEAD`) and shows
the status (`206`), `Content-Range`, `Content-Length`, `Accept-Ranges` and the bytes it got;
it runs once by itself so the page shows a `206` before anyone touches it.

### Share

A picker and `<VolaShareDialog file>`: password, expiry, most downloads, the link shown once
with Copy, the list of links, revoke. Through the proxy (`shares:write`), which caps the
expiry at the demo TTL. The last link made is shown with "Open in a new tab" and a `curl`.

### Encrypted files

**tenant**: the seeded files uploaded with `encryption=tenant` — thumbnail and download work
like any other, the row says `encryption: tenant`, the server decrypts on the way out.
**keyring**: `<VolaPinGate>` over `<VolaFileBrowser folderPath="private/<visitor>"
encryption="keyring">`: set a PIN once (the recovery key shown once), unlock, upload — every
file is wrapped under the visitor's keyring. `VolaKeyringStatus` plus a countdown of
`unlock_expires_in` (the server's sliding TTL, 150 s by default); Lock, the auto-lock, a
hidden tab or leaving the page empties the view and every `blob:` URL. The keyring and its
files are purged after 24 h. Needs Redis and the pepper file on the server (the page says so
otherwise).

### API

A table of the routes behind the pages (method, path, scope, what) and `curl` examples with
the demo key and the absolute base URL: health, config, list, info with OCR, download with
`Range`, thumbnail, folders, a UDC `list`, lookups, a write through the proxy, and a write
with the demo key (`403`). Copy buttons.

## Structure

```
src/
  main.tsx                 styles (@jsudc/react, @vola/react, app.css) and <App />
  App.tsx                  settings → connection → VolaClient(demoFetch) → VolaProvider → routes
  connection.tsx           GET /examples/config, Connection, needsProxy, demoFetch, SettingsProvider
  settings.ts              localStorage settings, the visitor id (sessionStorage), formatBytes
  i18n/messages.ts         EN / SR strings (APP, MENU, one section per page)
  shell/                   TopBar (EN/SR), Settings popover, AppShell + Connected, MenuTree + menu.ts
  examples/<page>/         one directory per page; shared.tsx: PageHeader, useDemoFiles, FilePicker, Code, SeedHint
assets/ + manifest.json    the demo pack (ASSETS.md); scripts/make-assets.mjs regenerates it
test/                      Vitest + Testing Library: fake.ts plays the server (config, UDC, files, thumbs, Range, the proxy)
```

`pnpm test` (48 tests), `pnpm typecheck`, `pnpm build`.
