# @vola/react

React components for a JSVola server: the file browser of an instance (live, on
`@jsudc/react`'s data view), uploads with resumable progress, thumbnails, the keyring PIN gate
with its auto-lock, and the share dialog. Built on [`@vola/client`](../client/README.md); every
request goes through its `VolaClient`, so an API key, an unlock token or a share secret is
never in a URL.

```bash
pnpm add @vola/react @vola/client @jsudc/react @jsudc/core @tanstack/react-query
# the peers @jsudc/react needs for its table: radix-ui lucide-react @tanstack/react-table
```

```tsx
import "@jsudc/react/styles.css";
import "@vola/react/styles.css";
import { VolaClient } from "@vola/client";
import { VolaFileBrowser, VolaPinGate, VolaProvider } from "@vola/react";

const vola = new VolaClient({ baseUrl: "/vola", apiKey, userId: "user-42" });

<VolaProvider client={vola} locale="sr">
  <VolaPinGate>
    <VolaFileBrowser instanceType="tickets" instanceId={ticketId} onOpen={(file) => preview(file)} />
  </VolaPinGate>
</VolaProvider>;
```

## `VolaProvider`

The root of everything: the client, i18n (`en`, `sr`), the `@jsudc/react` providers the file
browser draws with (`UdcProvider`, TanStack `QueryClientProvider`, `UdcI18nProvider`,
tooltips, toasts), the keyring store with its auto-lock, and the in-memory cache of decrypted
`blob:` URLs.

| prop | default | |
|---|---|---|
| `client` | — | a `VolaClient`; or `baseUrl` (+ `apiKey`, `userId`, `tenantSlug`, `fetch`, `validate`, `headers`) to build one |
| `locale` | `@jsudc/react`'s | `en` or `sr` |
| `messages` | — | strings layered over the package's: `{ VOLA: { UPLOAD: { en, sr } } }` |
| `lockAfterMs` | 120 000 | inactivity before the auto-lock countdown; `0` turns the auto-lock off |
| `lockCountdownMs` | 10 000 | the countdown's length |
| `awayMs` | 30 000 | a tab hidden this long locks when it comes back; `null`: never for that reason |
| `resumableThreshold` | 8 MiB (`VOLA_RESUMABLE_THRESHOLD`) | bytes from which an upload is resumable |
| `renderers` | the package's table | the `@jsudc/react` registry the file browser draws with |
| `queryClient` | `createUdcQueryClient()` | your app's TanStack client |
| `WebSocket` | the global one | the class of the live subscription (tests, polyfills) |

`useVola()` returns the client; `useVolaContext()` the client, the keyring store, the blob cache
and the settings.

## `VolaFileBrowser`

```tsx
<VolaFileBrowser
  instanceType="tickets"
  instanceId={ticketId}
  folderPath="docs"                 // the folder shown first; the browser follows a change
  onFolderChange={(path) => …}
  onOpen={(file) => …}              // the name was clicked
  columns={["thumb_url", "filename", "size", "created_at"]}   // default: the view's columns
  actions={["download", "share"]}   // default: download, rename, move, delete, versions, share, visibility
  encryptionChoices={["none", "tenant", "keyring"]}            // a select next to the upload button
/>
```

- Breadcrumbs, the subfolders of the folder (open, rename, delete), a "New folder" button.
- The `files` UDC collection as `<UdcDataView collection="files">` draws it — search, filter
  chips, the filter builder, infinite or paged rows — scoped to the instance and the folder
  through a `ScopedUdcClient` (every `list` is ANDed with the scope). The view's search and
  filters live in memory by default (`urlState="window"` puts them in the page's query
  string).
- **Live**: a WebSocket to `/udc/subscribe` (`docs/REALTIME.md`) keeps the rows current. A row
  a cached page holds is patched in place (a rename, a move, a new `processing_status`);
  anything else makes the lists refetch. The dot in the toolbar says `Live`, `Connecting…`
  or `Offline — reconnecting` (backoff 0.5 s → 15 s; one refetch on every reconnect).
  `live={false}` opens no socket.
- The table is the package's own renderer (`volaTableRenderer`, registered under `table`): the
  view's columns through `@jsudc/react`'s cells, the thumbnail through `VolaThumb` (so an
  encrypted file's preview works under an unlock), the name as the "open" link, a lock mark
  on an encrypted row, a row-actions menu at the end. Headers sort by `created_at`,
  `filename`, `size`.
- Row actions open dialogs: rename, move (a target path; a missing folder is created), delete
  (soft; the sentence says a purge removes it for good), versions (the chain, each
  downloadable), share (`VolaShareDialog`), visibility (`is_public`; `is_global_public` is
  refused for an encrypted file). Download fetches with the client's headers into a `blob:`
  URL and clicks an anchor.
- The whole surface is a drop zone: dropped files go to the current folder through
  `useVolaUpload`; the upload button next to the breadcrumbs shares the same list.
- Each browser has its own TanStack cache per (instance, folder): the data view's list keys
  do not carry the scope, so two folders must not share one.

## Uploads — `useVolaUpload()` and `VolaUploadButton`

```tsx
const { uploads, upload, cancel, resume, remove, clear, threshold } = useVolaUpload();
await upload(files, { instanceType, instanceId, folderPath, encryption: "keyring", onUploaded });
```

A file under `resumableThreshold` goes up as one multipart `POST /files/:type/:id`; a larger
one through the resumable protocol (`/uploads`, tus) chunk by chunk, with progress. `cancel`
aborts; a resumable upload keeps its fingerprint in `localStorage` (the SDK's default store)
and `resume` continues from the offset the server has — after a reload too: pick the same file
(same name, size and modification time) and it continues. `UploadItem` has `status`
(`queued`, `uploading`, `done`, `error`, `cancelled`), `uploaded`, `size`, `fileId`.

`<VolaUploadButton instanceType instanceId folderPath encryptionChoices={[…]} />` is a file
picker over the hook with an optional encryption select and `<VolaUploadList>` under it
(progress bar, cancel, resume, remove). `uploads={…}` lets it share a list with a drop zone.

## `VolaThumb`

```tsx
<VolaThumb file={fileInfoOrRow} size={128} crop="fit" />
```

Fetches `…/thumb/:size` with the client's credentials (the key is a header, so a bare
`<img src>` could not carry it) into a `blob:` URL kept in the provider's in-memory cache.
The rules of the thumbnail route:

- `200 ready` → the image, cached under (file, size, crop);
- `202 generating` → a placeholder, retried with backoff (1, 2, 4 … s, at most 30 s and
  `maxRetries` times); **the 202 body is never cached**. A change of the row's
  `processing_status` (the live subscription) asks again at once;
- `failed`, `404 no_thumbnail` → a placeholder saying so;
- `423` → a "locked" placeholder, and the keyring store is told (the page locks).

An encrypted file's thumbnail is decrypted per request under the unlock token. A lock
revokes every `blob:` URL, and a generation counter drops an answer that arrives after it.

## Keyring — `useVolaKeyring()`, `VolaPinGate`, auto-lock

```tsx
const k = useVolaKeyring();
k.hasPin; k.unlocked; k.status; k.lockPhase; k.lockRemainingMs;
await k.setup(pin);          // → { recovery_key }: shown once, kept nowhere
await k.unlock(pin);         // the client keeps the token in memory
await k.lock();              // revokes every blob: URL first, then tells the server
await k.changePin(cur, next); await k.recover(key, newPin); await k.reset();
k.stay();                    // cancels a running countdown
```

`<VolaPinGate>` shows its children while unlocked; otherwise the PIN screen (six one-digit
fields; typing advances, Backspace goes back, a paste fills them):

- no keyring → setup: the PIN twice, then the recovery key shown this once with a checkbox
  "I have saved the recovery key" before "Continue";
- unlock: `403 pin_wrong` shows the attempts in a row (and the wait, when there is one);
  `429 too_many_attempts` shows a countdown from `retry_after` with the fields disabled —
  also for the right PIN; `422 pin_invalid` says why (length, digits, trivial);
- "Forgot your PIN?" → the recovery key and a new PIN → a NEW recovery key, shown once;
- "Reset the keyring" → an `alertdialog` with what a reset shreds (files, bytes), the
  sentence that nothing brings it back, and the word `RESET` typed to confirm.

**Auto-lock** (the Notes policy, `docs/notes-crypto-for-vola.md` § 3): `lockAfterMs` without
a pointer, key, touch, wheel or scroll event → a `lockCountdownMs` countdown (the gate shows
"Locking in N s" with "Stay unlocked") → lock. Activity during the countdown goes back to
live. A tab that slept through the countdown locks at once; a tab hidden for `awayMs` locks
when it comes back. On `pagehide` the client's beacon ends the token on the server and every
`blob:` URL is revoked. Every `423` the components see locks the page too. The token is
never in storage: a reload is a lock.

`<VolaKeyringStatus />` is a toolbar line: locked / unlocked, Lock, Change PIN.

## `VolaShareDialog`

```tsx
<VolaShareDialog file={file} open onClose={…} onCreated={(share) => …} />
```

Password, expiry (`datetime-local` → ISO), most downloads → `POST /shares`; the link is shown
this once with a Copy button (`navigator.clipboard`). For an encrypted file a note says what
the link means: the recipient gets the plain content, and the secret after `#` is in the link
alone — the server keeps nothing of it; revoking shreds the grant. The existing links of the
file are listed (created, downloads of max, expiry, password, encrypted) with Revoke.

## Styling and accessibility

`@vola/react/styles.css` is optional. Every class starts with `vola-`; the sheet reads
`@jsudc/react`'s tokens (`--background`, `--foreground`, `--border`, `--primary`, `--sem-*`,
light and `.dark`) with a fallback, so the components sit next to a UDC data view without a
seam. No Tailwind in the package. Dialogs are `role="dialog"` / `alertdialog` with
`aria-modal`, labelled by their title, the focus trapped inside, Escape and the overlay close
them, and the opener gets the focus back; menus are `menu` / `menuitem` with arrow keys.

## i18n

Every string is a term of the `VOLA` section (`VOLA_MESSAGES`, `en` and `sr`), resolved
through `@jsudc/react`'s `useI18n` — `useVolaT()` gives `t(term, vars)`. Override a term or
add a locale through the provider's `messages`.

## Tests

`pnpm --filter @vola/react test`: Vitest + jsdom + Testing Library against a fake `fetch`
(`test/fake.tsx`: a route table that records every call) and a fake WebSocket:

- the browser renders rows from a fake UDC `describe`/`list`, scoped to the instance and the
  folder; navigates into a subfolder; renames through the row menu; subscribes to
  `/udc/subscribe` and patches a live `processing_status`; uploads what is dropped;
- the upload hook sends a small file as one `POST` and a large one through `/uploads` chunk
  by chunk; cancels and resumes from the server's offset with the fingerprint in
  `localStorage`;
- `VolaThumb`: 202 → placeholder → retry → image, the 202 body never cached; 404 and
  `failed` placeholders; the cache hit; the re-ask on `DONE`;
- the PIN gate: a wrong PIN shows the attempts, a 429 its countdown with the fields disabled,
  the right PIN shows the content and the token goes on every later request; setup shows the
  recovery key once behind the checkbox; reset wants the word;
- lock: `decideLock`, `BlobCache` (every URL revoked, the generation refuses a late answer),
  a lock revokes the thumbnails' URLs and the next fetch carries no token, a late thumbnail
  answer is dropped, the auto-lock counts down and locks (and activity keeps it open), the
  `pagehide` beacon;
- the share dialog's warning for an encrypted file, the link with its fragment, copy, list,
  revoke; `ScopedUdcClient`; the live hook's subscribe, patch, invalidate and reconnect.
