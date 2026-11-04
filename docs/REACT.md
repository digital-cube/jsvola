# React UI — `@vol-a/react` (plan 7.2)

The components an application embeds to get the whole vola surface: the file browser of an
instance (live, on `@jsudc/react`'s data view), uploads with resumable progress, thumbnails,
the keyring PIN gate with its auto-lock, and the share dialog. Everything goes through
`@vol-a/client` ([CLIENT](../packages/client/README.md)), so no key, token or secret is ever in
a URL. The package's own README — [`packages/react/README.md`](../packages/react/README.md) —
is the reference (props, hooks, tests); this page is the map.

```tsx
import "@jsudc/react/styles.css";
import "@vol-a/react/styles.css";
import { VolaClient } from "@vol-a/client";
import { VolaFileBrowser, VolaPinGate, VolaProvider } from "@vol-a/react";

const vola = new VolaClient({ baseUrl: "/vola", apiKey, userId: "user-42" });

<VolaProvider client={vola} locale="sr">
  <VolaPinGate>
    <VolaFileBrowser instanceType="tickets" instanceId={ticketId} onOpen={(file) => preview(file)} />
  </VolaPinGate>
</VolaProvider>;
```

| | what it is | where it talks to |
|---|---|---|
| `VolaProvider` | the client, i18n (`en`, `sr`), the `@jsudc/react` providers, the keyring store + auto-lock, the `blob:` cache | — |
| `VolaFileBrowser` | breadcrumbs, subfolders, `<UdcDataView collection="files">` scoped to the instance and folder, row actions, drop zone | `POST /udc/describe|list` (scoped), `GET /udc/subscribe`, `/folders`, `/files` |
| `useVolaUpload`, `VolaUploadButton` | plain upload under 8 MiB, resumable above, progress, cancel, resume after reload | `POST /files/:type/:id`, `/uploads` (tus) |
| `VolaThumb` | the thumbnail as a cached `blob:` URL; 202 placeholder + backoff, never cached | `GET …/thumb/:size` |
| `useVolaKeyring`, `VolaPinGate`, `VolaKeyringStatus` | PIN setup / unlock / change / recover / reset, lock-out countdown, auto-lock | `/keyrings/me/*`, the `pagehide` beacon |
| `VolaShareDialog` | password, expiry, most downloads, the link once, list, revoke, the warning for an encrypted file | `/shares` |

## How the browser stays live

`VolaFileBrowser` opens one WebSocket to `/udc/subscribe` ([REALTIME](REALTIME.md)) with the
same `{instance_type, instance_id, folder_path}` filter its lists carry. An `udc.row.upsert`
of a row a cached page holds is patched into the TanStack cache in place (`patchRowInList`),
so a rename, a move or a new `processing_status` shows without a request; a row the cache does
not have (a new upload) or an `udc.row.remove` makes the lists refetch. The socket reconnects
with backoff and refetches once on every reconnect. `live={false}` opens no socket.

The data view's list keys do not carry the scope, so each browser holds its own TanStack
cache per (instance, folder) and scopes `list` through a `ScopedUdcClient` rather than through
the view's own filters (which the person can edit).

## What a lock does (the Notes rules, [notes-crypto-for-vola](notes-crypto-for-vola.md) § 3, § 4, § 6.9)

1. Every `blob:` URL of the provider's cache is revoked and the cache emptied — synchronously,
   before anything else — and the generation counter is bumped, so a thumbnail answer that
   was in flight is dropped when it arrives.
2. The token is forgotten (it only ever lived in the client's memory; a reload is a lock).
3. The server is told (`DELETE /keyrings/me/unlock`; on `pagehide` the `sendBeacon` alias).

A lock comes from the Lock button, the auto-lock (120 s idle + 10 s countdown, a slept tab, a
tab away for 30 s), `pagehide`, a status read that says the token expired, or any `423` a
component sees. An unlock makes every locked thumbnail ask again.

## Styling

`@vol-a/react/styles.css` reads `@jsudc/react`'s design tokens (`--background`, `--foreground`,
`--border`, `--primary`, `--sem-*`, light and `.dark`) with a fallback, so the components sit
next to a UDC data view without a seam. Every class starts with `vola-`; no Tailwind in the
package. Dialogs and menus are keyboard-complete and labelled (`role="dialog"`, `aria-modal`,
a focus trap, `menu`/`menuitem`).

## Out of scope here

The examples application (plan 8.1) shows all of this running against a stage server.
