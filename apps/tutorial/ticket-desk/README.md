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

## 3. The backend

The tickets are one UDC collection ([`collections/tickets`](collections/tickets)): `schema.json`
says what a ticket is, `view.yaml` how the board shows it. `@jsudc/server` keeps the rows in
PostgreSQL and serves them at `POST /udc/*`, and [`src/server/tickets.ts`](src/server/tickets.ts)
adds the routes of the program:

| route | what it does |
|---|---|
| `POST /tickets` | a new ticket at the top of the first column |
| `GET /tickets/:id` | one ticket |
| `PATCH /tickets/:id/status` | moves it to another column |
| `POST /tickets/:id/assign` | gives it to somebody |

Every write needs `X-User-Id`, one of the users in [`src/shared/desk.ts`](src/shared/desk.ts). That
pick is the whole login of this program.

```sh
curl -X POST localhost:8080/tickets -H 'x-user-id: igor' -H 'content-type: application/json' \
  -d '{"title":"Printer on fire"}'
pnpm install && pnpm test    # the routes, on tickets kept in memory
```

## 4. The events

Everything that happens to a ticket is one event in memento. [`src/server/events.ts`](src/server/events.ts)
says which, and [`src/server/memento.ts`](src/server/memento.ts) sends it, with `POST /memento/events`:

| action | `event_type` | `payload` |
|---|---|---|
| `POST /tickets` | `TICKET_CREATED` | `title` |
| `POST /tickets/:id/comments` | `TICKET_COMMENTED` | `text` |
| `PATCH /tickets/:id/status`, or a card dragged on the board | `TICKET_STATUS_CHANGED` | `status`, `previous` |
| `POST /tickets/:id/assign` | `TICKET_ASSIGNED` | `assignee` |
| `POST /tickets/:id/files` | `TICKET_FILE_ATTACHED` | `file_id`, `filename`, `size`, `mime_type` |

All of them on the instance `tickets/<id>`, with the user as the actor. A comment has no table of
its own: the event is the comment.

The board writes through UDC's `POST /udc/mutate`, not through these routes, so
[`src/server/drag.ts`](src/server/drag.ts) puts two Fastify hooks around that route. A dragged card
gives the same event as the status route.

`templates/<EVENT_TYPE>.<locale>.hbs` are the sentences, in English and Serbian. `make setup` hands
them to `memento create-template`, so a reader sees a sentence instead of JSON:

```sh
make setup    # again: it adds the templates and keeps the keys
curl "localhost:8080/memento/entities/tickets/<id>/events?locale=sr" \
  -H "Authorization: Bearer $MEMENTO_BROWSER_KEY"
# "rendered": "igor komentariše: „On my way\""
```

## 5. The UI

```sh
docker compose up -d --build   # the desk serves the built frontend
open http://localhost:8080
```

The header picks who is signed in. Three pieces do the work, and all three are other people's
components:

| | component | talks to |
|---|---|---|
| the board ([`Board.tsx`](src/web/Board.tsx)) | `<UdcDataView collection="tickets">` with `@jsudc/react/kanban`: search, columns, drag and drop | the backend's `/udc/*` |
| the files ([`Files.tsx`](src/web/Files.tsx)) | `<VolaFileBrowser>` and `<VolaUploadButton>` on the instance `tickets/<id>`: thumbnails, folders, download, delete; **Share** in a file's menu opens `VolaShareDialog` | vola, directly, with `X-User-Id` |
| the feed ([`TicketPage.tsx`](src/web/TicketPage.tsx)) | `useMementoEvents` from `@memento/react` | memento, directly |

The backend ([`src/server/proxy.ts`](src/server/proxy.ts)) passes `/vola` and `/memento`, HTTP and
WebSocket, to the two services, so the browser sees a single origin. It gets its two keys from
`GET /config`. An upload goes straight to vola; when it lands, `onUploaded` tells the backend
(`POST /tickets/:id/files`), which is what records `TICKET_FILE_ATTACHED`.

For development with reloads: `make setup` once, then `pnpm dev` and `pnpm dev:web`, with the
backend's `.env` pointing at the services.

So far the feed is read once and read again after each of your own actions. Step 6 makes it live.

## 6. Live

[`Activity.tsx`](src/web/Activity.tsx) subscribes: `useMementoEvents` loads the newest events and
then gets every new one over memento's WebSocket (`/memento/ws`), so a write by anybody, in any
tab, shows up by itself and nothing reloads after an action any more. The feed's `onEvent` also
tells the board and the ticket page to read again: memento's stream is the one signal the whole
page follows.

There is one subscription to the whole desk, and [`feed.ts`](src/web/feed.ts) picks a ticket's part
of it. A filter on `tickets/<id>` alone would be shorter, but step 7 shows why it would miss things.

To see it: open the same ticket in two tabs, sign in as somebody else in one, and comment.
