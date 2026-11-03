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

## 2. The keys

```sh
make setup
```

[`scripts/setup.sh`](scripts/setup.sh) makes a tenant called `desk` in both services through their
CLIs, the four keys below, writes them to `.env` and restarts the stack with them. Safe to run
again: a key `.env` already has is kept. `make clean` drops all the data and `.env` with it.

| in `.env` | who holds it | scopes |
|---|---|---|
| `MEMENTO_SERVER_KEY` | the backend | `write`: it pushes the events |
| `VOLA_SERVER_KEY` | the backend | `files:read`: it reads the name of an attached file |
| `MEMENTO_BROWSER_KEY` | the browser | `read`: the feed |
| `VOLA_BROWSER_KEY` | the browser | `files:*`, `folders:*`, `shares:write`: uploads go straight to vola |

There is no login in this program, so the browser gets its two keys from the backend. A real
application hands them out to signed-in users only, and the backend would check the user itself.
