# Audit trail: vola events in memento (plan 5.2)

JSVola can record its destructive and security-relevant operations as events in a
[memento](https://github.com/digital-cube/jsmemento) instance. The integration is **optional**
and **one-directional**: vola pushes, memento stores, renders and streams. Nothing in vola
reads memento back.

## Switching it on

```sh
VOLA_MEMENTO_URL=https://memento.example.com/memento   # the memento API base; vola posts to <url>/events
VOLA_MEMENTO_API_KEY=mem_…                             # a memento API key with the `write` scope
```

Both or neither: one without the other is a configuration error at start. Without them the
audit is off — one INFO line (`audit disabled`), nothing logged as an error, no request ever
made. The same two variables go to the **worker** container: with Redis the server only queues
the event, the worker pushes it.

Every event is one `POST <VOLA_MEMENTO_URL>/events` with `Authorization: Bearer <key>` and the
memento `EventCreate` body:

```json
{
  "event_type": "VOLA_FILE_DELETED",
  "instance_type": "vola_file",
  "instance_id": "<file id>",
  "actor_type": "user",
  "actor_id": "u-42",
  "payload": { "tenant": "acme", "file_id": "…", "filename": "report.pdf", "size": 12345, "mime_type": "application/pdf", "kind": "document", "…": "…" },
  "occurred_at": "2026-11-01T12:00:00.000Z"
}
```

One memento key per vola installation: every vola tenant's events land in the memento tenant
of that key, with the vola tenant's slug in `payload.tenant`. Mapping vola tenants to memento
tenants is out of scope.

## Delivery

- **With Redis** (`VOLA_REDIS_URL`, the normal deployment): the server enqueues an `audit` job
  on the `vola-processing` BullMQ queue and answers the request at once. The worker pushes it
  with **5 tries** and exponential backoff (1 s, 2 s, 4 s, 8 s); a `5xx`, `408`, `429` or a
  network failure is retried, any other `4xx` (a bad key, a body memento refuses) is dropped
  after the first try with a WARN line. A worker without `VOLA_MEMENTO_*` drops audit jobs
  (one WARN line) — configure both containers alike.
- **Without Redis:** one direct push, fire and forget, **2 s timeout**. A failure is a WARN
  line (`audit event not delivered`).
- In both modes the vola request **never waits for memento and never fails because of it**:
  the change is already committed when the event goes out.
- The CLI (`vola create-key`, `create-admin-key`, `revoke-key`, `transfer`) pushes directly
  and waits for the push before it exits.

## The actor

| situation | `actor_type` | `actor_id` |
|---|---|---|
| request with `X-User-Id` | `user` | the header's value (the host application's principal) |
| request without it | `api_key` | `key:<prefix>…<last4>`, e.g. `key:vola_live…k3Qz` |
| the CLI | `cli` | `cli:<$USER>` (`cli:cli` when unknown) |

## Events

`instance_type` is what the event happened to; `instance_id` its id. Every payload carries
`tenant` (the vola tenant slug) and the ids it is about. What a payload **never** carries: a
share token, a password (or its hash), an API key (plaintext or hash), a file key — and the
`filename` of an encrypted file (`encryption != none`; the name of such a file is protected
content, plan 6).

| `event_type` | `instance_type` | when | payload (besides `tenant`) |
|---|---|---|---|
| `VOLA_FILE_DELETED` | `vola_file` | `DELETE …/:fileId` (soft delete); every file a recursive `DELETE /folders/…?recursive=1` soft-deletes (then also `folder_path`, `recursive: true`); not on the idempotent repeat | `file_id`, `instance_type`, `instance_id`, `folder_id`, `slug`, `size`, `mime_type`, `kind`, `encryption`, `filename`* |
| `VOLA_FILE_PURGED` | `vola_file` | `DELETE …/:fileId/purge` | the file facts above, `versions` (the ids of the whole chain removed), `files` (rows removed), `blobs` (blobs removed from disk) |
| `VOLA_FILE_VISIBILITY_CHANGED` | `vola_file` | `PATCH …/:fileId` changed `is_public` or `is_global_public` (a move or rename alone does not) | the file facts, `is_public`, `is_global_public`, `previous: {is_public, is_global_public}` |
| `VOLA_SHARE_CREATED` | `vola_share` | `POST /shares` | `share_id`, `file_id` / `folder_id`, `scope`, `has_password`, `expires_at`, `max_downloads`, `download_count`, `created_at` |
| `VOLA_SHARE_REVOKED` | `vola_share` | `DELETE /shares/:id` (the first time) | the same, with `revoked_at` |
| `VOLA_KEY_CREATED` | `vola_key` | `POST /keys`; `vola create-key`, `vola create-admin-key` | `key_id`, `name`, `prefix`, `last4`, `scopes`, `is_admin`, `expires_at`, `created_at`, `created_by` (`tenant: null` for an admin key) |
| `VOLA_KEY_REVOKED` | `vola_key` | `DELETE /keys/:id` (the first time); `vola revoke-key` | the same, with `revoked_at` |
| `VOLA_INSTANCES_TRANSFERRED` | `vola_tenant` (`instance_id` = the **destination** slug) | `POST /admin/transfer`, `vola transfer` (not a dry run) | `from_tenant`, `to_tenant`, `instances: [{instance_type, instance_id}]`, `files`, `folders`, `merged_folders`, `shares`, `jobs`, `uploads`, `user_map_entries` |

\* only when `encryption` is `none`.

Phase 6.2 (TCKFT692JH) adds `VOLA_KEYRING_*` for the keyring lifecycle (created, unlocked,
locked, PIN changed, reset, recovery used) under `instance_type: vola_keyring`.

## On the memento side

memento stores any `event_type`; it renders a line for it only when its `lookups.yaml` knows
the type and a template exists. To get readable lines in the memento feed, add to that
memento's vocabulary and templates:

```yaml
# lookups.yaml (memento)
EventTypes:
  - VOLA_FILE_DELETED
  - VOLA_FILE_PURGED
  - VOLA_FILE_VISIBILITY_CHANGED
  - VOLA_SHARE_CREATED
  - VOLA_SHARE_REVOKED
  - VOLA_KEY_CREATED
  - VOLA_KEY_REVOKED
  - VOLA_INSTANCES_TRANSFERRED
InstanceTypes:
  - vola_file
  - vola_share
  - vola_key
  - vola_tenant
```

Suggested template lines (EN / SR), one per event type, in memento's template syntax:

| event | en | sr |
|---|---|---|
| `VOLA_FILE_DELETED` | `{{ actor_id }} deleted file {{ payload.filename \| default("(encrypted)") }} ({{ payload.size }} B) in {{ payload.tenant }}` | `{{ actor_id }} je obrisao fajl {{ payload.filename \| default("(šifrovan)") }} ({{ payload.size }} B) u {{ payload.tenant }}` |
| `VOLA_FILE_PURGED` | `{{ actor_id }} purged file {{ payload.filename \| default("(encrypted)") }}: {{ payload.files }} row(s), {{ payload.blobs }} blob(s)` | `{{ actor_id }} je trajno obrisao fajl {{ payload.filename \| default("(šifrovan)") }}: {{ payload.files }} red(ova), {{ payload.blobs }} blob(ova)` |
| `VOLA_FILE_VISIBILITY_CHANGED` | `{{ actor_id }} set public={{ payload.is_public }} global={{ payload.is_global_public }} on {{ payload.filename \| default("(encrypted)") }}` | `{{ actor_id }} je postavio public={{ payload.is_public }} global={{ payload.is_global_public }} na {{ payload.filename \| default("(šifrovan)") }}` |
| `VOLA_SHARE_CREATED` | `{{ actor_id }} created share {{ instance_id }} (password: {{ payload.has_password }}, max downloads: {{ payload.max_downloads }})` | `{{ actor_id }} je napravio share {{ instance_id }} (lozinka: {{ payload.has_password }}, max preuzimanja: {{ payload.max_downloads }})` |
| `VOLA_SHARE_REVOKED` | `{{ actor_id }} revoked share {{ instance_id }} after {{ payload.download_count }} download(s)` | `{{ actor_id }} je povukao share {{ instance_id }} posle {{ payload.download_count }} preuzimanja` |
| `VOLA_KEY_CREATED` | `{{ actor_id }} created API key {{ payload.prefix }}…{{ payload.last4 }} "{{ payload.name }}" ({{ payload.scopes \| join(", ") }})` | `{{ actor_id }} je napravio API ključ {{ payload.prefix }}…{{ payload.last4 }} "{{ payload.name }}" ({{ payload.scopes \| join(", ") }})` |
| `VOLA_KEY_REVOKED` | `{{ actor_id }} revoked API key {{ payload.prefix }}…{{ payload.last4 }} "{{ payload.name }}"` | `{{ actor_id }} je povukao API ključ {{ payload.prefix }}…{{ payload.last4 }} "{{ payload.name }}"` |
| `VOLA_INSTANCES_TRANSFERRED` | `{{ actor_id }} moved {{ payload.instances \| length }} instance(s), {{ payload.files }} file(s) from {{ payload.from_tenant }} to {{ payload.to_tenant }}` | `{{ actor_id }} je premestio {{ payload.instances \| length }} instanc(e/i), {{ payload.files }} fajl(ova) iz {{ payload.from_tenant }} u {{ payload.to_tenant }}` |

## Code

- `packages/server/src/audit/memento.ts` — `AuditEvent`, `AuditSink`, `NoopSink`,
  `MementoSink` (`POST`, 2 s timeout, `AuditDeliveryError` with `retryable`),
  `fileAuditPayload` (the one place that decides whether `filename` is in).
- `packages/server/src/audit/log.ts` — `AuditLog.emit()` (never throws, never awaited by a
  request; queue first, direct fallback), `actorOf`, `createAuditSink` (the INFO line).
- `packages/server/src/jobs/queue.ts` — `AUDIT_JOB`, `AUDIT_MAX_ATTEMPTS`, `enqueueAudit`;
  `jobs/worker.ts` — the `audit` job handler.
- Writers: `services/files.ts` (delete, purge, visibility), `services/folders.ts` (recursive
  delete), `services/shares.ts` (create, revoke), `routes/keys.ts` and `packages/cli`
  (keys), `services/transfer.ts` (transfer).
- Tests: `packages/server/test/audit.test.ts` (a fake memento HTTP server receives the exact
  events; memento down or `500` never fails a vola request; an encrypted file has no
  `filename`; the queued path retries through a real worker), `packages/cli/test/transfer.test.ts`.
