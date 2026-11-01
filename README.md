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

## Container

```sh
docker compose -f docker-compose.yaml up -d --build
curl localhost:8300/vola/health/live    # {"status":"ok"}
curl localhost:8300/vola/health/ready   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

Configuration is environment only, every variable prefixed `VOLA_` — see `.env.example`.

## License

MIT
