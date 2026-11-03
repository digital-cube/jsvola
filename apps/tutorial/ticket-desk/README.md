# Ticket desk

A small help desk built on two services that do one thing each:

- **[vola](https://github.com/digital-cube/jsvola)** keeps the files of a ticket;
- **[memento](https://github.com/digital-cube/jsmemento)** keeps who did what, when.

The tickets themselves are one [jsudc](https://github.com/digital-cube/jsudc-example) collection,
which gives the kanban board out of the box. Each step below is one commit (`step N: …`) in the
history of this program.

## 1. The stack

Node 24, TypeScript, pnpm. A Fastify 5 backend, a Vite + React 19 frontend. vola and memento are
separate services from their Docker images, reached over HTTP; neither is embedded.

```sh
cp .env.example .env     # optional: DESK_PORT, 8080 by default
docker compose up -d --build
curl localhost:8080/health
# {"ok":true}
```

| service | what it is |
|---|---|
| `vola`, `vola-worker` | files; the worker makes the thumbnails |
| `memento` | the events |
| `postgres` | one database each for vola, memento and the desk (`docker/init-databases.sql`) |
| `redis` | vola's job queue, memento's event stream |
| `desk` | this program, the only service with a port |

`@vola/*` and `@memento/*` are not on npm yet: `vendor/` holds their client packages as tarballs
(see [vendor/README.md](vendor/README.md)).
