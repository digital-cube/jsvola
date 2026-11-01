# Real-time: `GET /vola/udc/subscribe` (plan 3.2)

A client that shows the files of an instance (or of one folder of it) sees changes as they
happen: a new upload, a delete, a move, a rename, a visibility change and, from plan 4.1, a
change of `processing_status`. The channel is a WebSocket speaking the UDC envelope shape;
what it carries are the rows `list` would answer, so a data view applies them without
reloading.

```
POST /vola/files/…  ─┐                                             ┌─▶ {instance_type: tickets, instance_id: 42}
PATCH, DELETE, …     ┤ commit ─▶ FileEventBus ─▶ files source ─────┼─▶ {…, folder_path: "docs"}
POST /vola/uploads   │          Redis: vola:files:<tenant id>      │   (row read from PG, masked, filtered)
worker (4.1)        ─┘          (or in-process without Redis)      └─▶ admin: {instance_type: tickets}
```

`@jsudc/server` 0.2 declares the `capabilities.subscribe` flag but ships no transport for
it, and jsudc's own plan keeps live updates to polling. The transport here is vola's own
(`SubscribableSource` in `@vola/server`), shaped so a future `@jsudc/*` one can replace it:
a source gets `subscribe(filter, sink)` next to `list`, the sink receives `upsert(row)` /
`remove(id)`, and the wire messages are UDC envelopes (`udc.row.upsert`, `udc.row.remove`).

## Connecting

```js
const ws = new WebSocket("ws://localhost:8300/vola/udc/subscribe", ["vola.v1", `bearer.${apiKey}`]);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

- **Auth.** Browsers cannot set headers on a WebSocket, so the API key goes in the
  subprotocol list as `bearer.<api_key>`; offer `vola.v1` next to it and the server selects
  that one, so the key is not echoed back (`bearerSubprotocols(key)` in `@vola/core`).
  Non-browser clients may send `Authorization: Bearer <key>` or `X-Api-Key` instead. The key
  needs `files:read`; an admin key selects the tenant with `X-Tenant-Slug`. The key is
  **never** read from the query string (the jsmemento rule: a URL is logged, a header is not).
- **Refusals happen before the upgrade**, as ordinary HTTP responses with the usual error
  envelope: `401 unauthorized`, `403 forbidden` (with `required: ["files:read"]`),
  `400 tenant_required`. A plain `GET` without `Upgrade` is `400 bad_request`.
- **Tenant isolation.** The tenant is the key's; nothing on the wire can change it. Events
  travel on a Redis channel per tenant, the source reads the row under the tenant's id, and a
  subscription only ever sees rows of that tenant.

## Messages (JSON text frames)

Schemas: `ClientMessageSchema`, `ServerMessageSchema` in `@vola/core` (`src/subscribe.ts`).
Every message is `{kind, id, payload}`; for a subscription `id` is the one the client chose in
its `udc.subscribe`, so several views can share one connection.

**Server → client**

| kind | when | payload |
|---|---|---|
| `udc.welcome` | first message; from now on subscriptions are answered | `{protocol_version: "1", tenant, heartbeat_interval_ms, max_buffered_messages, max_subscriptions}` |
| `udc.subscribe.ok` | the subscription is live: every change from now on is delivered | `{collection, filter}` |
| `udc.subscribe.err` | refused | `{code, message, details?}` — `validation_error` (no `instance_type`, unknown field, duplicate id, too many), `not_found` (collection), `unsupported_op` (collection without `subscribe`), `internal` (feed down; the connection then closes with 1011) |
| `udc.row.upsert` | a row now matches the filter: put it in place by `__meta.id` | `{collection, row, event}` — `row` exactly as `list` / `read` would answer it |
| `udc.row.remove` | a row the client may have no longer matches: take it out | `{collection, id, event}` |
| `udc.unsubscribe.ok` | the subscription ended | `{}` |
| `udc.pong` | answer to `udc.ping` | `{}` |
| `udc.error` | a client message the server could not act on; the connection stays open | `{code, message}` |

`event` is what the publisher saw: `created`, `updated`, `deleted`, `restored`, `purged`,
`processing` (`FILE_EVENT_KINDS`). `restored` is reserved (no route restores a soft-deleted
file yet); `processing` is published by the worker of plan 4.1 (`publishProcessingStatus`).

**Client → server**

| kind | payload | |
|---|---|---|
| `udc.subscribe` | `{collection: "files", filter}` | `filter` is the UDC filter a `list` would take; `id` names the subscription |
| `udc.unsubscribe` | — | ends the subscription `id` |
| `udc.ping` | — | application-level ping, answered with `udc.pong` |

### What a `files` subscription delivers

The filter is validated like a `list`'s and must pin `instance_type` with a top-level `eq`
(unlike `list`, which answers an empty page without one, a subscription is refused — there is
nothing it could ever deliver). `instance_id` narrows it to one instance; without it (an
admin's view) every instance of the type is followed. `folder_path`, `filename`, `kind`,
`mime_type`, `size`, `created_at`, … work as in `list`; `include_deleted eq true` keeps
soft-deleted rows in (a soft delete is then an `upsert` with `deleted_at` set instead of a
`remove`).

For every file event of the tenant whose instance the subscription pins, the source reads the
row from the database — soft-deleted too, `null` once purged — through the same masking and
`decorateRow` as `list` (an encrypted row stays `<encrypted>`), and evaluates the subscription's
whole filter against it (`evaluateFilter` of `@jsudc/core`, the client-side twin of the SQL
compiler):

- the row matches → `udc.row.upsert` with the row;
- it does not (deleted, purged, moved to another folder, renamed out of a `filename contains`,
  …) → `udc.row.remove` with its id — **except for `created`**, which a client cannot have had;
- a `remove` for a row the client never had is harmless and expected (the server does not
  track what each client holds).

Events are dispatched one after another per tenant, so every client sees them in publish order.
A move from `docs` to the root is therefore a `remove` on a `folder_path = "docs"` subscription
and an `upsert` on a `folder_path = ""` one, in that order of arrival.

## Who publishes what

Every writer announces its change **after its transaction committed**, through
`publishFileEvent` (`FilesDeps.events`); a failed publish is logged, never raised — the change
is durable and the request must not fail because a client will have to reload.

| operation | events |
|---|---|
| `POST /files/:type/:id`, `PUT …/slug/:slug`, a completed resumable upload (`PATCH /uploads/:id`), a new version (`parent_id`) | `created` for the new row; `deleted` for every live file of `slug` it replaced |
| `PATCH …/:fileId` (move, rename, visibility) | `updated` |
| `DELETE …/:fileId` | `deleted` (only when it was live) |
| `DELETE …/:fileId/purge` | `purged` for the row and every version of its chain |
| `PATCH /folders/…` (rename or move of a folder) | `updated` for every live file of the subtree (its `folder_path` changed) |
| `DELETE /folders/…?recursive=1` | `deleted` for every file it soft-deleted |
| worker (plan 4.1) | `processing` — `publishProcessingStatus(deps, file)` |

An event carries ids only (`tenantId`, `instanceType`, `instanceId`, `folderId`, `fileId`,
`kind`); the row is read at dispatch time, so nothing an encrypted row hides crosses Redis.

## Lifecycle

| | |
|---|---|
| connect | auth → upgrade → `udc.welcome` |
| subscribe | `udc.subscribe` → the source validates the filter, subscribes the tenant's feed (first subscription of a tenant in this process subscribes its Redis channel) → `udc.subscribe.ok` |
| heartbeat | every 30 s (`VOLA_WS_HEARTBEAT_MS`) a WebSocket ping; a client that has not answered the previous one (pong, or any message) is terminated. Browsers and `ws` answer pings automatically. |
| slow consumer | messages not yet written to the client's socket are counted; when 1000 (`VOLA_WS_MAX_BUFFERED`) are pending the next one is not queued: a warning `slow consumer threshold exceeded; disconnecting` is logged and the connection is closed with **4008 `slow consumer`** (terminated 5 s later if the close does not get through). Other clients are not affected. |
| limits | 32 subscriptions per connection (`MAX_SUBSCRIPTIONS_PER_CONNECTION`), 64 KiB per client message |
| disconnect | every subscription of the connection ends; the last one of a tenant in this process unsubscribes its channel |
| shutdown | every connection is closed with **1001 `server shutting down`** |
| feed down | a subscription that cannot reach the feed is refused with `internal` and the connection closed with **1011** |

Reconnect after any close, with backoff, then re-subscribe and reload the list once (what
happened while you were away is not replayed).

## Deployment

- **With `VOLA_REDIS_URL`** every server process (and the worker) publishes on
  `vola:files:<tenant id>` and subscribes, on one dedicated connection, to the channels of
  the tenants it has clients for (`RedisFileEventBus`). A change made through any process
  reaches the clients of every process. ioredis reconnects and re-subscribes by itself.
- **Without `VOLA_REDIS_URL`** a `LocalFileEventBus` delivers in-process: one server streams
  its own changes (development, tests).
- **Embedded:** `volaPlugin` takes `events` (a bus of your own, or `false` for none) and
  `subscribe` (`{heartbeatIntervalMs, maxBufferedMessages}`, or `false` for no route). If the
  host app already registered `@fastify/websocket` it is reused; register it before the vola
  plugin. `createFileEventBus(redisUrl)` builds the default bus for a worker process.
