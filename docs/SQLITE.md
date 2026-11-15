# Running JSVola on SQLite

JSVola runs on PostgreSQL or on a single SQLite file. This guide covers SQLite from an empty
directory to a running server: when to choose it, the quick start, embedding the Fastify plugin,
the worker for thumbnails and OCR, operating the file, and what SQLite cannot do. For
everything that is the same on both databases (the image, every `VOLA_*` variable, the key
files, the reverse proxy), see [DEPLOYMENT.md](DEPLOYMENT.md).

Contents: [SQLite or PostgreSQL](#sqlite-or-postgresql) · [Quick start](#quick-start-a-server-on-a-sqlite-file) ·
[Embedded](#embedded-the-plugin-in-your-application) · [With a worker](#with-a-worker-thumbnails-and-ocr) ·
[Operations](#operations) · [Limits](#limits-and-known-differences) ·
[Moving between the databases](#moving-between-the-databases)

> SQLite support is in **1.1.0** and later (`CHANGELOG.md`, `[1.1.0]`): the `@vol-a/*` packages
> and the image `ghcr.io/digital-cube/jsvola:1.1.0`. `@vol-a/server` 1.0.1 refuses a `file:` URL.

## SQLite or PostgreSQL

| | PostgreSQL (default) | SQLite (`file:<path>`) |
|---|---|---|
| what it needs | a PostgreSQL 16 service | nothing: Node's built-in `node:sqlite` (Node 24+), one file on a local disk |
| files, folders, versions, slugs, shares, tenants, keys, `Range`, tus uploads, `tenant` / `caller` / `client` encryption, UDC lists and `subscribe`, statistics, transfer, the CLI | yes | yes |
| `keyring` encryption (PINs) | needs Redis | needs Redis (same) |
| thumbnails | by the worker, or inline on the first `/thumb` | by the worker, or inline on the first `/thumb` |
| OCR and the OCR text search | yes: worker + tesseract; `tsvector` + GIN | yes: worker + tesseract; FTS5 ([how it differs](#how-the-ocr-search-differs-from-postgresql)) |
| the worker and Redis | optional; the worker on any host | optional; the worker **on the server's host**, opening the same file |
| processes | any number of servers and workers | **one server process** and at most one worker, one writer at a time |
| hosts | any | **one** (the file, the server and the worker on the same machine) |
| backup | `pg_dump` + the storage | `VACUUM INTO` (or a copy while stopped) + the storage |
| scaling | more servers behind a proxy, more workers | none: one process. Move to PostgreSQL when it is not enough |
| moving to the other database | no tool | no tool ([below](#moving-between-the-databases)) |

**Choose SQLite** for a small installation that must not depend on a database service: a team's
file store, an application that embeds vola and ships as one process, a demo, an edge box. The
server and the CLI open the file directly; there is nothing to install, start or upgrade beside
Node.

**Choose PostgreSQL** when you need more than one server process (for availability or load),
a worker on another machine, storage shared over the network, or a database your operations
already back up and monitor. It is the default (`docker-compose.yaml`) and has every feature.

## Quick start: a server on a SQLite file

Node 24+ (`node --version`) and `curl`. No Docker, no database service, no Redis.

```sh
mkdir my-vola && cd my-vola
npm install @vol-a/server @vol-a/cli
```

The database and the storage are two paths. A relative `file:` path is relative to the
working directory; `file:///var/lib/vola/vola.db` is an absolute one.

```sh
export VOLA_DATABASE_URL=file:data/vola.db
export VOLA_STORAGE_PATH=data/storage
```

Apply the migrations, then create the first tenant and its API key with the CLI. Each command
opens the file directly, so no server has to be running yet. The server would also migrate at
start; `vola migrate` creates the file and its directory now.

```sh
npx vola migrate
#   migrations applied
ls -la data
#   -rw-r--r-- 1 digital digital 237568 Nov 15 15:17 vola.db

npx vola create-tenant --slug acme --name "Acme Inc"
#   created tenant acme (Acme Inc) id=01a1dfc8-d467-7dc9-b2b0-922fa7dc3bb1

npx vola create-key --tenant acme --name backend --env live \
    --scopes files:read,files:write,folders:read,folders:write,shares:write
#   created key vola_live…xalH "backend" for tenant acme
#     id      01a1dfc8-db9e-79ae-901f-86d88490c7c4
#     scopes  files:read, files:write, folders:read, folders:write, shares:write
#
#     Plaintext key (shown ONCE — store it now, it cannot be recovered):
#
#     vola_live_aHlB1snbGMfCQFPuoiyHaII6nwFfxalH

export KEY=vola_live_aHlB1snbGMfCQFPuoiyHaII6nwFfxalH    # yours, from the line above
```

Start the server. It listens on `0.0.0.0:8300` by default; this run used port 8310:

```sh
export VOLA_PORT=8310
node node_modules/@vol-a/server/dist/server.js
#   {"level":30,…,"reason":"no VOLA_REDIS_URL","effect":"thumbnails are rendered inline on /thumb; OCR does not run","msg":"background jobs disabled"}
#   {"level":30,…,"key_file":"/run/secrets/vola.key","keyring":null,"msg":"encryption: tenant and caller providers (no Redis: no keyring provider)"}
#   {"level":30,…,"prefix":"/vola","storage":"…/my-vola/data/storage","redis":false,"msg":"vola configured"}
#   {"level":30,…,"msg":"Server listening at http://127.0.0.1:8310"}
```

The log is JSON on stdout. Two warnings, `lookups.yaml not found` and `menu.yaml not found`,
are expected for an npm install: the controlled vocabulary and the menu are optional files
(`VOLA_LOOKUPS_PATH`, `VOLA_MENU_PATH`). In a second terminal, with the same variables:

```sh
curl -s localhost:8310/vola/health/ready
#   {"status":"ok","checks":{"database":"ok"}}

echo "Hello from SQLite" > hello.txt
export TICKET=$(uuidgen | tr A-F a-f)       # the host application's entity: tickets/<uuid>
curl -s -H "Authorization: Bearer $KEY" -F file=@hello.txt localhost:8310/vola/files/tickets/$TICKET \
    | tee file.json | jq '{id, filename, size, mime_type, hash}'
#   {
#     "id": "01a1dfc9-37bf-79fd-a4ad-41a74ac530ef",
#     "filename": "hello.txt",
#     "size": 18,
#     "mime_type": "text/plain",
#     "hash": "5c46b5c51a42ef6d99fa7316dccdb74046cf6f0348097635e5e4b485fb1330bb"
#   }
export FILE=$(jq -r .id file.json)

curl -s -H "Authorization: Bearer $KEY" localhost:8310/vola/files/tickets/$TICKET | jq '.files | length'
#   1
curl -s -H "Authorization: Bearer $KEY" localhost:8310/vola/files/tickets/$TICKET/$FILE
#   Hello from SQLite

find data/storage -type f
#   data/storage/blobs/5c/46/b5/5c46b5c51a42ef6d99fa7316dccdb74046cf6f0348097635e5e4b485fb1330bb
ls -la data
#   drwxrwxr-x 3 digital digital     60 Nov 15 15:17 storage
#   -rw-r--r-- 1 digital digital 237568 Nov 15 15:17 vola.db
#   -rw-r--r-- 1 digital digital  32768 Nov 15 15:17 vola.db-shm
#   -rw-r--r-- 1 digital digital      0 Nov 15 15:17 vola.db-wal
```

From here the API is the one in [API.md](API.md), and the README's quick start works with
`localhost:8310` in place of `localhost:8300`. Stop the server with `Ctrl-C` (`SIGINT`) or
`SIGTERM`. It closes the database cleanly, and `vola.db-wal` and `vola.db-shm` disappear.

## Embedded: the plugin in your application

`volaPlugin` (`packages/server/src/plugin.ts`) mounts every route inside your own Fastify
application. The application owns the database handle: `connect()` picks SQLite from the
`file:` URL, `runMigrations()` brings the file up to date, and the plugin receives the `db`.
This complete application keeps its files in `data/desk.db` and `data/storage`. On its first
start it creates its tenant and a key:

```sh
mkdir ticket-desk && cd ticket-desk
npm install @vol-a/server @vol-a/core fastify@5
```

```js
// app.mjs: a host application with JSVola mounted under /vola, on one SQLite file.
import Fastify from "fastify";
import {
  connect,
  createApiKey,
  createTenant,
  findTenantBySlug,
  LOG_REDACT,
  loadConfig,
  runMigrations,
  volaPlugin,
} from "@vol-a/server";

// Every VOLA_* variable still applies; these two get defaults of the application's own.
const config = loadConfig({
  VOLA_DATABASE_URL: "file:data/desk.db",
  VOLA_STORAGE_PATH: "data/storage",
  ...process.env,
});
const database = connect(config.databaseUrl); // file: → SQLite (WAL, one writer)
await runMigrations(database.db); // creates data/desk.db on the first start

// First start: the application's tenant and the key its frontend will use.
if (!(await findTenantBySlug(database.db, "desk"))) {
  const tenant = await createTenant(database.db, { slug: "desk", name: "Ticket desk" });
  const { key } = await createApiKey(database.db, {
    tenantId: tenant.id,
    name: "desk-frontend",
    env: "live",
    scopes: ["files:read", "files:write", "folders:read"],
  });
  console.log(`tenant "desk" created; its API key (shown once): ${key}`);
}

const app = Fastify({ logger: { level: "warn", redact: [...LOG_REDACT] } });
app.get("/", async () => ({ app: "ticket desk", files: "/vola" }));
await app.register(volaPlugin, { prefix: "/vola", config, db: database.db });
app.addHook("onClose", async () => database.close());

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 3000) });
console.log(`listening on http://127.0.0.1:${process.env.PORT ?? 3000}`);
```

```sh
node app.mjs
#   tenant "desk" created; its API key (shown once): vola_live_pcXexO3BOajPrnBCayzv4Q2yGwXA9ryw
#   {"level":40,…,"msg":"lookups.yaml not found: the vocabulary is empty"}
#   listening on http://127.0.0.1:3000
```

In a second terminal:

```sh
KEY=vola_live_pcXexO3BOajPrnBCayzv4Q2yGwXA9ryw
curl -s localhost:3000/
#   {"app":"ticket desk","files":"/vola"}
curl -s localhost:3000/vola/health/ready
#   {"status":"ok","checks":{"database":"ok"}}
echo "embedded attachment" > note.txt
curl -s -H "Authorization: Bearer $KEY" -F file=@note.txt localhost:3000/vola/files/tickets/$(uuidgen | tr A-F a-f) \
    | jq '{filename, size, instance_type}'
#   {
#     "filename": "note.txt",
#     "size": 20,
#     "instance_type": "tickets"
#   }
ls data
#   desk.db  desk.db-shm  desk.db-wal  storage
```

After `Ctrl-C`, only `desk.db` and `storage` remain. A second `node app.mjs` finds the tenant
and prints no new key. An instance id must be a UUID: `…/files/tickets/42` answers
`422 {"error":{"code":"validation_error","message":"instance_id: must be a UUID"}}`.

Notes on embedding:

- Your application **is** the one server process the file allows. Do not also run
  `server.js` on the same file. You may run `vola` CLI commands next to it.
- `connect()` opens one database per process: a second `connect()` with a PostgreSQL URL in
  the same process throws a `ConfigError`.
- Everything else the plugin takes (`redis`, `storage`, `events`, `audit`, `encryption`,
  `decorateRow`, `extend`) is in `VolaPluginOptions`, and works the same on both databases.
- `buildApp({ config, db })` is the standalone server without your own routes: the plugin
  under `config.prefix`, with pino and the redaction already set up.

## With a worker: thumbnails and OCR

Without Redis everything runs inside the server. Thumbnails render on the first `/thumb`
request, and no OCR job is ever created. An `ocr` search can still run, but with no OCR text
it finds nothing. For OCR, and to take thumbnails off the request path, add Redis and run the
worker **on the same host**, opening the same file.

You need:

- **Redis 7**. Any instance will do; this run started a private one:
  `redis-server --port 6390 --save '' --appendonly no`.
- **`tesseract`** with the languages of `VOLA_OCR_LANGS` (default `eng+srp+deu`; Debian/Ubuntu:
  `apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-srp tesseract-ocr-deu`). If
  one of the languages is missing, the worker stops at start.
- **`pdftoppm`** (`poppler-utils`) for PDF thumbnails and OCR of PDFs.

Start the server and the worker with the **same** `VOLA_DATABASE_URL`, `VOLA_STORAGE_PATH` and
`VOLA_REDIS_URL`, from the same working directory if the paths are relative:

```sh
export VOLA_DATABASE_URL=file:data/vola.db VOLA_STORAGE_PATH=data/storage VOLA_PORT=8310
export VOLA_REDIS_URL=redis://localhost:6390/0

node node_modules/@vol-a/server/dist/server.js     # terminal 1
#   {"level":30,…,"msg":"background jobs: async (worker)"}
#   {"level":30,…,"msg":"encryption: tenant, keyring and caller providers"}
#   {"level":30,…,"msg":"Server listening at http://127.0.0.1:8310"}

node node_modules/@vol-a/server/dist/worker.js     # terminal 2
#   {"level":30,…,"name":"vola-worker","version":"tesseract 5.5.0","langs":"eng+srp+deu","maxPages":20,"timeoutS":120,"msg":"OCR enabled"}
#   {"level":30,…,"name":"vola-worker","concurrency":2,"queue":"vola:vola-processing","storage":"…/my-vola/data/storage","ocr":"tesseract 5.5.0",…}

curl -s localhost:8310/vola/health/ready
#   {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

Upload an image with text (this one was made with ImageMagick:
`convert -size 1400x300 xc:white -font DejaVu-Sans -pointsize 64 -fill black -annotate +60+130 'INVOICE 2026-0042' -annotate +60+240 'Payment due in 30 days' invoice.png`),
then read its OCR block and its thumbnail:

```sh
curl -s -H "Authorization: Bearer $KEY" -F file=@invoice.png localhost:8310/vola/files/tickets/$TICKET \
    | tee inv.json | jq '{id, filename, kind, processing_status}'
#   {
#     "id": "01a1dfca-a649-7304-a953-579603ce589e",
#     "filename": "invoice.png",
#     "kind": "image",
#     "processing_status": "PENDING"
#   }
INV=$(jq -r .id inv.json)

# a few seconds later
curl -s -H "Authorization: Bearer $KEY" localhost:8310/vola/files/tickets/$TICKET/$INV/info | jq -c .ocr
#   {"status":"DONE","lang":"eng+srp+deu","pages":1,"text_preview":"INVOICE 2026-0042\nPayment due in 30 days"}
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -H "Authorization: Bearer $KEY" \
    localhost:8310/vola/files/tickets/$TICKET/$INV/thumb/256
#   200 image/webp
```

The OCR text search is the `ocr` filter of the UDC `files` collection:

```sh
for q in "invoice 0042" "PAYMENT days" "invoice refund" "2026-0042" "invoice OR refund"; do
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" localhost:8310/vola/udc/list -d '{
  "collection": "files",
  "filter": {"and": [
    {"field": "instance_type", "op": "eq", "value": "tickets"},
    {"field": "ocr", "op": "contains", "value": "'"$q"'"}
  ]}
}' | jq -c '{total: .payload.total, files: [.payload.rows[].filename]}'; done
#   {"total":1,"files":["invoice.png"]}     invoice 0042: both words occur
#   {"total":1,"files":["invoice.png"]}     PAYMENT days: case does not matter
#   {"total":0,"files":[]}                  invoice refund: every word must occur
#   {"total":1,"files":["invoice.png"]}     2026-0042: two words, 2026 and 0042
#   {"total":0,"files":[]}                  invoice OR refund: OR is a word, not an operator
```

How the two processes share the file: each takes its turn at the file's write lock. Every
write the worker makes is one short statement, and tesseract runs with no transaction open. A
process waiting for the other's lock waits on a timer, up to 10 s, and keeps serving
meanwhile. The expired-upload sweep stays in the server, because the upload a tus `PATCH` is
streaming is held in the server's memory. A `tenant`-encrypted file is OCRed too, but its text
is sealed and never searchable, on either database
([CRYPTO.md § 11](CRYPTO.md#11-thumbnails-and-ocr-of-encrypted-files-phase-63)).

With Redis set but no worker running, jobs wait for nobody and `/thumb` answers `202` forever.
Set `VOLA_WORKER_ENABLED=0` in that case, exactly as on PostgreSQL.

### How the OCR search differs from PostgreSQL

The API, the filter and the answers are the same. The index is different: on PostgreSQL it is
`ocr_tsv`, a `tsvector` under a GIN index. On SQLite it is `vola_file_ocr_fts`, a contentless
FTS5 table that triggers keep in step with `vola_file_metadata`
(`drizzle-sqlite/0001_ocr_fts.sql`; the migration also indexes text that was already there).

| | PostgreSQL | SQLite |
|---|---|---|
| tokenizer | `to_tsvector('simple', …)` | FTS5 `unicode61`, `remove_diacritics 0` |
| every word must occur, any order | yes | yes |
| case | folded | folded, beyond ASCII (`Ž` = `ž`) |
| diacritics | kept: `č` ≠ `c` | kept: `č` ≠ `c` |
| stemming, ranking | none | none |
| a hyphenated word (`e-mail`) | indexed as `e-mail`, `e` and `mail` | indexed as `e` and `mail`. A query `e-mail` asks for both, so it matches the same text |
| what a word is | PostgreSQL's parser (it also knows e-mail addresses, URLs, numbers with dots) | a run of letters and digits; every other character separates words |
| the user's query syntax | `plainto_tsquery`: plain words | each word quoted by the server: `"`, `*`, `:`, `OR`, `NEAR` and `-` are plain text |
| indexed text | the first 500 000 characters | the first 500 000 characters |

In practice the same words find the same files. The differences show only with punctuation
inside a word: an e-mail address, a URL, a version number like `1.2.3`, which SQLite splits
into its parts. The server refuses to start on a SQLite build without FTS5. Node's built-in
SQLite has it.

## Operations

**The files.** `vola.db` is the database. While a process has it open, `vola.db-wal` (the
write-ahead log) and `vola.db-shm` (shared memory for the processes on this host) sit next to
it. They are part of the database: never delete them while the server or worker runs, and
never copy `vola.db` alone while they exist. A clean stop folds the log back into `vola.db` and
removes both. Keep the database on a local disk, next to `VOLA_STORAGE_PATH`. In the Docker
image that is the `/data` volume (`VOLA_DATABASE_URL=file:/data/vola.db`; see
[DEPLOYMENT.md § Volumes](DEPLOYMENT.md#volumes)).

**Permissions.** The file holds key hashes, keyrings' wrapped keys, file names and OCR text.
It is created with the process's umask (`-rw-r--r--` above), so make the directory private:
run vola as its own user and `chmod 700` the data directory. SQLite creates the `-wal` and
`-shm` files next to the database, so that directory must be writable for the server, and for
the worker and the CLI too. Run all three as the same user.

**Backup.** Back up the database **and** the storage, the database first: a blob that arrives
between the two copies is a harmless orphan, but a row whose blob is missing is a `500`. Keep
the key and pepper files apart from both
([DEPLOYMENT.md](DEPLOYMENT.md#the-key-file-and-the-pepper-file)). There are two ways to copy
the database:

- **While it runs:** `VACUUM INTO` writes a consistent, compacted copy into a new file,
  including the OCR index. With Node:

  ```sh
  mkdir -p backup
  node -e 'const [from, to] = process.argv.slice(1); new (require("node:sqlite").DatabaseSync)(from).prepare("VACUUM INTO ?").run(to)' \
      data/vola.db backup/vola-$(date +%F).db
  ls -la backup
  #   -rw-r--r-- 1 digital digital 237568 Nov 15 15:20 vola-2026-11-15.db
  node -e 'const db = new (require("node:sqlite").DatabaseSync)(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT (SELECT count(*) FROM vola_file) AS files, (SELECT count(*) FROM vola_file_ocr_fts WHERE vola_file_ocr_fts MATCH ?) AS ocr_hits").get("invoice"))' \
      backup/vola-$(date +%F).db
  #   [Object: null prototype] { files: 2, ocr_hits: 1 }
  ```

  With the `sqlite3` shell the same is `sqlite3 data/vola.db "VACUUM INTO 'backup/vola.db'"`.
  To read the OCR index from that shell, it must be built with FTS5 (Debian's and Ubuntu's
  are). The target file must not exist yet.
- **While it is stopped:** stop the server and the worker, then copy `vola.db`. After a clean
  stop there is no `-wal` or `-shm`; if there is one, copy it with the file.

Then copy the storage (`tar`, `rsync`; the blobs never change, so incremental copies work well).
`storage/tmp` and `storage/uploads` hold only uploads in flight and can be left out.

**Restore.** Stop the server and the worker. Put the copy in place as `vola.db`, with no stale
`-wal` or `-shm` next to it, restore the storage, then start the server, and the worker after
it. This run did exactly that from the `VACUUM INTO` copy above:

```sh
mv data/vola.db data/vola.db.old && cp backup/vola-2026-11-15.db data/vola.db
node node_modules/@vol-a/server/dist/server.js & sleep 2
curl -s -H "Authorization: Bearer $KEY" localhost:8310/vola/files/tickets/$TICKET | jq -c '[.files[].filename]'
#   ["invoice.png","hello.txt"]
```

**Upgrades.** Back up first. The new server applies pending migrations from
`drizzle-sqlite/` at start, before it listens; `vola migrate` does the same by hand. Start the
worker after the server. Migrations are forward-only, so rolling back means restoring the
backup.

**What not to do:**

- **Do not put the file on NFS, SMB or any other network file system.** SQLite's locking is
  not reliable there, and the database gets corrupted. The storage can be on one; the database
  cannot.
- **Do not open the file from two hosts.** The locks and the `-shm` shared memory exist only
  within one machine. Two containers on one host sharing the `/data` volume work; a worker on
  another machine does not.
- **Do not start a second server process on the file.** Nothing stops you, and it starts and
  answers: this was tried. But each process guards the resumable uploads it is streaming in
  its own memory, and it is not a supported setup. Use PostgreSQL for more than one server.
- **Do not delete `-wal` / `-shm`** while a process has the file open, and do not restore a
  `vola.db` next to stale ones.
- **Do not use `:memory:`** outside tests. It is one process's private database: no CLI, no
  worker, and gone at exit (`VOLA_WORKER_ENABLED=true` with it is refused at start).

## Limits and known differences

- **One server process, at most one worker, one host.** This is the price of having no
  database service. There is no failover and no horizontal scaling.
- **One writer at a time.** Every transaction is `BEGIN IMMEDIATE`, and the server's
  transactions take turns. Reads outside a transaction use a second, read-only connection and
  do not wait. A writer that gets no turn within 10 s fails the request (`500`); with one
  server and one worker, each holding the lock for short statements, that should not happen.
  A `vola` CLI command next to the server waits up to 10 s too.
- **Resumable uploads (tus).** On PostgreSQL a `PATCH` holds the upload's row lock. On SQLite
  it streams outside any transaction and the server guards the upload in memory. A second
  `PATCH` to the same upload is `409 upload_locked` on both databases.
- **The OCR search** tokenizes punctuation inside words differently
  ([above](#how-the-ocr-search-differs-from-postgresql)).
- **Case-insensitive filters** (`case_insensitive: true`) fold every letter, not only ASCII.
  Case-sensitive `contains` is case-sensitive, as on PostgreSQL.
- **Schema.** The tables are the PostgreSQL ones column for column, in SQLite types: UUIDs as
  TEXT, timestamps as epoch milliseconds, JSON as TEXT. Write SQL of your own against them
  with that in mind ([ARCHITECTURE.md § 3](ARCHITECTURE.md#3-database-schema-postgresql-or-sqlite--drizzle)).
- **The worker's expired-upload sweep** runs in the server instead (see above). Statistics
  refresh, audit pushes and thumbnails are the worker's job as on PostgreSQL.
- **FTS5 is required.** The server refuses a SQLite build without contentless-delete FTS5
  tables. Node 24's built-in SQLite has it.

## Moving between the databases

There is **no tool yet** to move an installation from SQLite to PostgreSQL or back: no
export/import of the rows, and the two migration sets (`drizzle/`, `drizzle-sqlite/`) are not
interchangeable. Pick the database when you install. If a SQLite installation outgrows one
process, the way today is a new PostgreSQL installation with the files uploaded again through
the API. File ids, shares and keyrings do not carry over that way.
