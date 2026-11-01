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

## Container

```sh
docker compose -f docker-compose.yaml up -d --build
curl localhost:8300/vola/health/live    # {"status":"ok"}
curl localhost:8300/vola/health/ready   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

Configuration is environment only, every variable prefixed `VOLA_` — see `.env.example`.

## License

MIT
