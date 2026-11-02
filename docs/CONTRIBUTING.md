# Contributing to JSVola

## Dev setup

Node 24+, pnpm 11 (`corepack enable`), Docker or podman.

```sh
pnpm install
cp .env.example .env              # the defaults match compose.yaml
docker compose up -d              # PostgreSQL 16 + Redis 7; the init script also creates vola_test
pnpm db:migrate && pnpm db:migrate:test
pnpm dev                          # @vola/server from source (tsx watch), http://localhost:8300/vola
pnpm dev:worker                   # the worker, in a second terminal
pnpm vola create-tenant --slug acme --name "Acme Inc"
pnpm vola create-key --tenant acme --name local --env test
```

`.env` is not loaded automatically: export the variables (`set -a; . ./.env; set +a`) or rely on
the defaults. The examples site: `cd apps/examples && pnpm dev` (Vite on :5174, proxying
`/vola` to :8300 — `VOLA_SERVER` to change it) or `pnpm --filter @vola/examples build` and `VOLA_UI_DIR=apps/examples/dist`.

## Repository layout

[ARCHITECTURE.md § 1](ARCHITECTURE.md#1-repository-layout). Packages resolve each other from
source through the `@vola/source` export condition (`tsx --conditions=@vola/source`, the
Vitest config), so no build is needed between edits; `pnpm build` produces `dist/` for the
image, the E2E suite and npm.

## Running checks

| | |
|---|---|
| `pnpm lint` / `pnpm format` | Biome (`biome.json`) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm build` | Turbo, dependency order |
| `pnpm test` | Vitest; `@vola/server` and `@vola/cli` need PostgreSQL at `VOLA_DATABASE_URL_TEST` (migrated) and Redis at `VOLA_REDIS_URL` for the keyring, worker and `subscribe` suites |
| `pnpm test:cov` | the same with coverage; CI enforces ≥ 80 % lines per package (HTML in `packages/*/coverage/`) |
| `pnpm test:e2e` | builds the packages (Turbo), then starts the built server on a free port against the compose databases — or targets a running one with `VOLA_E2E_URL` |
| `pnpm --filter @vola/server test -- test/files.test.ts` | one file |
| `node tools/check-links.mjs` | every relative link and anchor in the Markdown documents resolves |
| `pnpm -r --filter './packages/*' exec pnpm pack --dry-run` | what each public package would publish |

The OCR tests need `tesseract` with `eng`, `srp`, `deu` and `pdftoppm` (poppler-utils) on the
machine, as CI installs them; without tesseract the "OCR with tesseract" suite is skipped. The
suites that need Redis (keyrings, the worker, `subscribe`, the share-password limiter) are
skipped when `VOLA_REDIS_URL` is unset.

### E2E

`packages/e2e` drives the **built** server over HTTP: files, folders, tus with `tus-js-client`,
the WebSocket, shares, encryption, the SDK, the examples site. `VOLA_E2E_URL=http://localhost:8300/vola`
points it at a running server (the `docker-compose.yaml` stack, a staging host); it creates
`e2e-…` tenants and never deletes data, so staging, not production.

## Docker locally

```sh
docker build -t jsvola:dev .
VOLA_IMAGE=jsvola:dev docker compose -f docker-compose.yaml up -d --wait
curl localhost:8300/vola/health/ready
VOLA_E2E_URL=http://localhost:8300/vola pnpm test:e2e
docker compose -f docker-compose.yaml down -v
```

## Changing things

- **A route**: the Zod schema in `@vola/core` first (body and answer), then the service in
  `packages/server/src/services`, then the route, then the `@vola/client` method and the
  table in [API.md](API.md). A new error code goes into `@vola/core`'s constants and the table
  in API.md.
- **The schema**: edit `packages/server/src/db/schema.ts`, `pnpm db:generate` writes the
  migration into `packages/server/drizzle/`, `pnpm db:migrate && pnpm db:migrate:test`
  applies it. Migrations are additive in 1.x.
- **A variable**: `config.ts`, `.env.example`, `docker-compose.yaml`, the table in
  [DEPLOYMENT.md](DEPLOYMENT.md#environment-variables), `turbo.json`'s `globalEnv` if tests
  read it.
- **The vocabulary**: `lookups.yaml` and `i18n/translations.csv`, then `pnpm vola lookups validate`.
- **Documents**: every relative link must resolve (`node tools/check-links.mjs` runs in CI);
  the README's `curl` examples are meant to be run against the compose stack as they stand.
- User-visible changes get a line under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat: …`, `fix: …`, `docs: …`,
  `ci: …`, `refactor: …`, `test: …`.
- Open the PR against `main`. CI must be green: *Lint, type check, build, test* (with the pack
  dry-run and the link check) and *Docker image + E2E against docker-compose.yaml*.

## Releasing

All `@vola/*` packages, `apps/examples`, `packages/e2e` and the image share one version; the
tag must equal it.

1. Bump `version` in the root `package.json`, every `packages/*/package.json` and
   `apps/examples/package.json` to the same `X.Y.Z` (and `CLI_VERSION` in
   `packages/cli/src/program.ts`).
2. Move the `[Unreleased]` entries of `CHANGELOG.md` under `## [X.Y.Z] - <date>` and update
   the compare links at the bottom.
3. Merge to `main`, then tag that commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The *Release* workflow (`.github/workflows/release.yml`) then checks that every package version
equals the tag, runs lint, typecheck, build and the unit tests, does `pnpm pack --dry-run` of
every public package, pushes `ghcr.io/digital-cube/jsvola:X.Y.Z` (and `X.Y`, `X`, `latest`;
`edge` on every push to `main`) with provenance, creates the GitHub release with the changelog
section as notes, and publishes `@vola/core`, `@vola/lookups`, `@vola/server`, `@vola/client`,
`@vola/react` and `@vola/cli` to npm with `--provenance`. The npm step needs the **`NPM_TOKEN`**
repository secret — an npm *automation* token of an account that may publish to the `@vola`
scope (the `@vola` organisation on npmjs.com must exist and that account must be a member) —
and is skipped with a warning when the secret is absent, so a tag without it still produces
the image and the GitHub release. `packages/e2e` and `apps/examples` are `private` and never
published.
