# `vola` CLI

```sh
pnpm vola --help                  # every command, examples, environment, scopes
pnpm vola <command> --help        # options of one command
docker compose -f docker-compose.yaml exec vola vola --help      # the same CLI inside the image
```

`@vola/cli` is the `vola` command (`packages/cli`). Every administrative command talks to
PostgreSQL directly (`VOLA_DATABASE_URL`) and connects only when it runs, so `--help`,
`--version` and usage errors never open the database. `demo-seed` is the one command that talks
to a running server over HTTP. Put `--json` **before** the command for machine-readable output
(`vola --json list-keys`). Exit code 0 on success, 1 on any error (the message on stderr, one
line, never a secret).

| command | |
|---|---|
| `migrate` | apply pending database migrations (the server does this at start too) |
| `create-tenant --slug <slug> [--name <name>]` | create a tenant |
| `tenant-set --slug <slug> --default-encryption none\|tenant\|keyring\|caller` | how an upload that names no mode is stored |
| `create-key --tenant <slug> --name <label> [--env live\|test] [--scopes a,b] [--expires <iso>] [--created-by <who>]` | a tenant API key; the plaintext printed **once** |
| `create-admin-key --name <label> [--expires <iso>] [--created-by <who>]` | a cross-tenant admin key (`vola_admin_…`, selects a tenant with `X-Tenant-Slug`); printed once |
| `list-keys [--tenant <slug>] [--admin]` | the keys: id, display form, name, tenant, scopes, dates, flags — never the plaintext or the hash |
| `revoke-key <id \| vola_live…k3Qz>` | revoke a key by id or display form; it stops working at once |
| `transfer --from <slug> --to <slug> --instance type:id [--instance …] [--user-map file.json] [--dry-run]` | move instances between tenants |
| `keys-generate [--path <file>]` | write a new tenant-encryption key file (0600); refuses to overwrite |
| `keys-status [--path <file>]` | how many encrypted files depend on which line of the key file |
| `pepper-generate [--path <file>]` | write a new keyring pepper file (0600); refuses to overwrite |
| `pepper-status [--path <file>]` | how many keyrings depend on which line of the pepper file |
| `demo-keys [--env live\|test]` | a fresh key pair for the examples site's `.env` |
| `demo-seed [--url] [--key] [--assets <dir>] [--instance-type] [--instance-id] [--wait <s>]` | upload the examples site's demo pack into the demo instance over HTTP |
| `lookups validate [--translations <file>]` | check `lookups.yaml` and the translations CSV |
| `lookups candidates [--dir <dir>]` | list unknown values recorded at upload |
| `lookup-promote [--dir] [--translations] [--only Section.TERM…] [--dry-run]` | move candidates into `lookups.yaml` and the CSV |

Environment the commands read:

| variable | used by |
|---|---|
| `VOLA_DATABASE_URL` | every database command (default `postgresql://vola:vola@localhost:5432/vola`) |
| `VOLA_REDIS_URL` | `transfer` announces the move to live subscribers of both tenants |
| `VOLA_MEMENTO_URL` + `VOLA_MEMENTO_API_KEY` | `create-key`, `create-admin-key`, `revoke-key`, `transfer` write audit events to memento (one direct push, awaited) with the actor `cli:<$USER>` |
| `VOLA_KEY_FILE` | `keys-generate`, `keys-status`, `transfer` (re-wraps `tenant` files); default `/run/secrets/vola.key` |
| `VOLA_PEPPER_FILE` | `pepper-generate`, `pepper-status`; default `/run/secrets/vola.pepper` |
| `VOLA_LOOKUPS_PATH` | the vocabulary commands (default: the repository's `lookups.yaml`) |
| `VOLA_URL`, `VOLA_DEMO_WRITE_KEY`, `VOLA_DEMO_ASSETS`, `VOLA_DEMO_INSTANCE_TYPE`, `VOLA_DEMO_INSTANCE_ID` | `demo-seed` |

In a checkout, `pnpm vola …` runs the CLI from source (`tsx --conditions=@vola/source`); after
`pnpm build`, `node packages/cli/dist/main.js`; from npm, `npx @vola/cli …` or the `vola` binary
of a global install.

## Tenants and keys

```sh
vola migrate
#   migrations applied
vola create-tenant --slug acme --name "Acme Inc"
#   created tenant acme (Acme Inc) id=0192…
vola tenant-set --slug acme --default-encryption tenant
#   tenant acme: default_encryption = tenant
```

A slug is 2–63 lowercase letters, digits and dashes, not starting with a dash; the name defaults
to the slug in title case.

```sh
vola create-key --tenant acme --name backend --env live --scopes files:read,files:write,folders:read,folders:write,shares:write
#   created key vola_live…k3Qz "backend" for tenant acme
#     id      0192…
#     scopes  files:read, files:write, folders:read, folders:write, shares:write
#
#     Plaintext key (shown ONCE — store it now, it cannot be recovered):
#
#     vola_live_…
#
vola create-key --tenant acme --name ci --env test --expires 2027-01-01T00:00:00Z --created-by igor
vola create-admin-key --name ops
#   created admin key vola_admin…7Hq2 "ops"
#     id      0193…
#     WARNING: an admin key reaches every tenant (X-Tenant-Slug). Guard it accordingly.
#   … vola_admin_…
vola list-keys --tenant acme
#   0192…  vola_live…k3Qz  backend  tenant=acme  scopes=files:read,files:write  created=2026-11-01  last_used=2026-11-02
#   0193…  vola_test…9pQ1  ci       tenant=acme  scopes=files:read              created=2026-11-01  never_used  [EXPIRED]
vola list-keys --admin
vola revoke-key vola_live…k3Qz            # or the id
#   revoked key vola_live…k3Qz "backend" (0192…)
```

`--env` is `live` (default) or `test` and only names the key's prefix (`vola_live_` /
`vola_test_`): both work against the same server and tenant, the prefix tells deployments
apart in logs. `--scopes` defaults to `files:read,files:write,folders:read,folders:write`; the
scopes are `files:read`, `files:write`, `folders:read`, `folders:write`, `shares:write`,
`keys:write`, `keyrings:write`, `encryption:caller` (and `admin`, which only
`create-admin-key` gives). A key with `keys:write` can mint further keys over HTTP
(`POST /keys`), limited to the scopes it holds itself. `list-keys` marks `[ADMIN]`,
`[REVOKED]`, `[EXPIRED]`.

## Transfer

```sh
vola transfer --from acme --to beta --instance tickets:5c1b… --instance tickets:9e2f… --dry-run
#   would move 2 instance(s) from tenant acme to beta (dry run, nothing written)
#     files           12
#     folders         3 (1 merged into existing destination folders)
#     shares          2
#     jobs            40
#     metadata        4
#     uploads         0
vola transfer --from acme --to beta --instance tickets:5c1b… --user-map users.json
```

The same operation as `POST /admin/transfer` ([API.md](API.md#admin-transfer)), against the
database directly: every row of the listed instances moves in one transaction, blobs stay,
`tenant`-encrypted keys are re-wrapped (`VOLA_KEY_FILE` needed), an instance holding a
`keyring` / `caller` / `client` file is refused. `--instance` is `<instance_type>:<uuid>`,
repeatable; `--user-map` is a JSON object `{"<old user id>": "<new user id>"}` rewriting
`created_by` / `deleted_by` / `last_accessed_by`. With `VOLA_REDIS_URL` live subscribers of
both tenants are told; with the memento variables the move is audited.

## The key file and the pepper file

```sh
vola keys-generate                           # VOLA_KEY_FILE (default /run/secrets/vola.key), 0600, refuses to overwrite
#   wrote /run/secrets/vola.key (mode 0600, 1 key line)
#   Back it up somewhere safe: without this file every tenant-encrypted file is unreadable.
vola keys-status
#   /run/secrets/vola.key: 2 key line(s), line 0 active; 1520 tenant-encrypted file(s)
#     kid 3f9a1c2e  line 0 (active)  1498 file(s)
#     kid 8b0d77e1  line 1  22 file(s)
#   older lines are still in use: they retire lazily, one download or info at a time; keep them
vola pepper-generate                         # VOLA_PEPPER_FILE (default /run/secrets/vola.pepper)
#   wrote /run/secrets/vola.pepper (mode 0600, 1 pepper line)
#   Back it up somewhere safe: without this file no keyring can be unlocked or recovered.
vola pepper-status
#   /run/secrets/vola.pepper: 1 pepper line(s), line 0 active; 14 keyring(s)
#     kid c01e…  line 0 (active)  14 keyring(s)
```

Neither status command ever prints a key or a line. A `NO LINE` entry means files (or
keyrings) depend on a line that is not in the file any more — restore it; those files cannot be
decrypted until then. To **rotate**, do not run `*-generate` again: prepend a line
([DEPLOYMENT.md](DEPLOYMENT.md#the-key-file-and-the-pepper-file)). `--path` overrides the
variable.

## The examples site

```sh
vola demo-keys
#   # the examples site (VOLA_EXAMPLES=true): paste into the stage .env
#   VOLA_DEMO_API_KEY=vola_live_…       ← read-only (files:read, folders:read), handed to every visitor
#   VOLA_DEMO_WRITE_KEY=vola_live_…     ← the server writes with it; never leaves the server
#   (nothing is stored; the server stores both, by hash, at its next start with VOLA_EXAMPLES=true)
vola demo-seed --url http://localhost:8300/vola --assets apps/examples/assets
#   waiting for http://localhost:8300/vola/health/ready …
#   uploaded photos/mountain.jpg → 0192…
#   …
#   demo pack: 10 uploaded, 0 unchanged, 6 published
```

`demo-seed` uploads the pack described by `assets/manifest.json` ([`apps/examples/ASSETS.md`](../apps/examples/ASSETS.md))
with `@vola/client` under the write key — an upsert per slug, so the compose `seeder` may run
at every `up`; `--wait` (120 s) is how long it waits for `/health/ready`.

## Lookups

```sh
vola lookups validate                        # lookups.yaml + i18n/translations.csv; exit 1 on errors
#   /…/lookups.yaml: FileKinds (10), ProcessingStatuses (5), ProcessingKinds (2), ShareScopes (4), OcrLanguages (3), EncryptionModes (5)
#   ok: en, sr — 0 warning(s)
vola lookups candidates
#   FileKinds.webp	3	2026-11-01T10:00:00.000Z	2026-11-02T08:12:00.000Z
vola lookup-promote --dry-run
#   would promote FileKinds.WEBP (seen 3×; en: Webp, sr: Webp)
vola lookup-promote --only FileKinds.WEBP
#   promoted FileKinds.WEBP (seen 3×; en: Webp, sr: Webp)
```

A value the vocabulary does not know is never rejected by the server; it is recorded under
`VOLA_CANDIDATES_DIR` (`var/candidates/<Section>.yaml` plus a `translations_candidate.csv` for a
translator). `lookup-promote` appends the terms to `lookups.yaml` (comments kept) and their
rows to the sheet; `--dry-run` reports, `--only` picks.

## Errors

Usage errors (a missing option, a malformed slug or instance) print the message and the
command's help, exit 1. Database errors (`VolaError`: `tenant_not_found`, `validation_error`,
`encryption_unavailable`, …) print `error: <code>: <message>`. A key is printed only by the
command that created it and only once; no command prints a key, a hash, a key-file line or a
pepper line afterwards.
