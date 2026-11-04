# @vol-a/client

The JSVola SDK: a `fetch`-based client for the `@vol-a/server` API. Runs in **Node 24+ and in
browsers**, depends on `@vol-a/core` (the protocol: Zod schemas and types) and `@jsudc/core`
(the UDC client behind `vola.udc`) and on nothing else. `fetch` can be injected.

```bash
pnpm add @vol-a/client
```

```ts
import { VolaClient } from "@vol-a/client";

const vola = new VolaClient({
  baseUrl: "https://files.example.com/vola", // the mount prefix included
  apiKey: process.env.VOLA_API_KEY,          // `Authorization: Bearer …`
  userId: "user-42",                          // `X-User-Id`: attribution, and the keyring owner
  // tenantSlug: "acme",                      // `X-Tenant-Slug`, for an ADMIN key
  // fetch: myFetch,                          // tests, retries, a proxy
  // validate: true,                          // check every answer against its @vol-a/core schema
});
```

Every answer is typed by the `@vol-a/core` schema of its route (`FileInfo`, `FolderListing`,
`ShareCreated`, `KeyringStatus`, …). `validate: true` also parses it (a mismatch is a
`VolaError` with code `invalid_response`); off by default.

## Errors

A non-2xx answer throws a `VolaError` carrying the server's envelope:

```ts
import { VolaError, VolaLockedError, VolaIntegrityError } from "@vol-a/client";

try {
  await vola.files.info("tickets", id, fileId);
} catch (error) {
  if (error instanceof VolaLockedError) {
    // 423 vola_locked: a keyring file without its unlock, a caller file without its key
  } else if (error instanceof VolaIntegrityError) {
    // 409 vola_integrity: a wrong key or secret, or damaged bytes
  } else if (error instanceof VolaError) {
    error.status;     // 404
    error.code;       // "file_not_found" — snake_case, stable
    error.message;
    error.retryAfter; // seconds, when the server said so (429, lock-outs)
    error.details;    // the rest of the envelope: `required` scopes, `attempts`, `reason`…
    error.requestId;  // `X-Request-Id`
  }
}
```

Transport failures (no network, a refused connection) throw what `fetch` throws. An aborted
`signal` rejects with the `AbortError` of the platform.

No secret — the API key, an unlock token, a content key, a share secret, a PIN — is ever put
in a URL, an error message or a log line by the SDK.

## Files

```ts
// Upload: a File/Blob, a Uint8Array/Buffer, an ArrayBuffer, a ReadableStream or any async
// iterable of bytes (a Node Readable) — streams go up without being buffered.
const info = await vola.files.upload("tickets", ticketId, file, {
  filename: "Izveštaj.pdf",      // required unless the source is a File
  contentType: "application/pdf",
  folderPath: "docs/q4",         // created when missing; or folderId
  parentId: previousVersionId,   // a new version
  metadata: { year: 2026 },
  encryption: "tenant",          // "none" | "tenant" | "keyring" | "caller"
});
await vola.files.putSlug("user_profiles", userId, "avatar", blob, { filename: "me.png" });

// Download: a streaming Response, never a buffer.
const response = await vola.files.download("tickets", ticketId, info.id);
response.body;                                   // ReadableStream
await response.blob();
const part = await vola.files.download("tickets", ticketId, info.id, {
  range: { start: 0, end: 1023 },               // 206; also { suffix: 100 } or "bytes=0-99"
  ifNoneMatch: '"<etag>"',                       // 304 resolves (empty body)
  download: true,                                // Content-Disposition: attachment
});
await vola.files.head("tickets", ticketId, info.id);
await vola.files.byPath("tickets", ticketId, "docs/q4/Izveštaj.pdf");
await vola.files.bySlug("user_profiles", userId, "avatar");
await vola.files.public(fileId);                 // GET /public/:fileId, no key

// Metadata
const detail = await vola.files.info("tickets", ticketId, info.id, { ocr: "full" });
detail.processing_status; detail.ocr.text;
const page = await vola.files.list("tickets", ticketId, { limit: 50, cursor });
for await (const file of vola.files.iterate("tickets", ticketId)) { /* every page */ }
await vola.files.versions("tickets", ticketId, info.id);
await vola.files.patch("tickets", ticketId, info.id, { folder_path: "archive", is_public: true });
await vola.files.delete("tickets", ticketId, info.id);        // soft
await vola.files.purge("tickets", ticketId, info.id);         // rows and blobs

// Thumbnails: a 202 is NOT the image.
const thumb = await vola.files.thumb("tickets", ticketId, info.id, 256, { crop: "fit" });
if (thumb.status === "ready") img.src = URL.createObjectURL(thumb.blob);
else if (thumb.status === "generating") setTimeout(retry, 1000); // the worker is on it
else if (thumb.status === "failed") showPlaceholder();            // the file cannot be rendered
vola.files.thumbUrl("tickets", ticketId, info.id, 128);  // a URL WITHOUT credentials
vola.files.downloadUrl("tickets", ticketId, info.id);
vola.files.publicUrl(fileId);
```

## Folders

```ts
await vola.folders.create("tickets", ticketId, "docs/q4");          // and missing parents
const { folder, subfolders, files } = await vola.folders.list("tickets", ticketId, "docs");
await vola.folders.rename("tickets", ticketId, "docs/q4", "q4-final");
await vola.folders.move("tickets", ticketId, "docs/q4-final", "archive");
await vola.folders.setDefaultKeyring("tickets", ticketId, "private", "me"); // encrypted folder
await vola.folders.delete("tickets", ticketId, "archive", { recursive: true });
```

## Resumable uploads

```ts
const { fileId } = await vola.uploads.resumable("tickets", ticketId, file, {
  filename: "video.mp4",
  chunkSize: 8 * 1024 * 1024,
  onProgress: ({ uploaded, total }) => setPercent((100 * uploaded) / total),
  signal: controller.signal,
  // fingerprint: "my-key", store: myStore, folderPath, parentId, slug, metadata, encryption…
});
```

The source must be sliceable (a `File`/`Blob`, a `Uint8Array`/`Buffer`, an `ArrayBuffer`; in
Node, `openAsBlob(path)` from `node:fs`). The upload is remembered under a fingerprint
(`localStorage` in a browser, memory in Node, or any `{get, set, remove}` store you pass): an
abort or a network failure in the middle of a chunk rejects, and the next call with the same
source `HEAD`s the server for its offset and `PATCH`es from there. The fingerprint is forgotten
once the file exists. The steps are available on their own: `uploads.create`, `uploads.status`,
`uploads.append`, `uploads.abort`, `uploads.protocol`.

## Shares

```ts
const share = await vola.shares.create({
  file_id: info.id,                 // or folder: { instance_type, instance_id, path }
  password: "lozinka",
  expires_at: "2026-12-31T00:00:00Z",
  max_downloads: 10,
});
share.url;   // https://files.example.com/vola/s/<token>  — for an ENCRYPTED file: …#<secret>
await vola.shares.list({ fileId: info.id });
await vola.shares.get(share.id);
await vola.shares.revoke(share.id);

// The recipient's side: anonymous, the fragment becomes `X-Share-Secret`.
const response = await VolaClient.openShare(share.url, { password: "lozinka", range: { start: 0 } });
const listing = await vola.shares.listing(folderShareUrl);                  // a folder share
await vola.shares.open(folderShareUrl, { path: "sub/report.pdf" });         // a file inside it
```

A `caller`-encrypted file (Node only) can be shared with a grant the caller makes itself,
since the server never holds that file's key: `vola.shares.createCallerGrant(fileId, fileKey)`
wraps the file key under a fresh secret with WebCrypto and returns a `url` with the fragment.

## Keyrings (PIN) and unlock

```ts
const { recovery_key } = await vola.keyrings.setup("493817");   // show it ONCE
const { expires_in } = await vola.keyrings.unlock("493817");    // the token is kept in memory
await vola.files.upload("tickets", ticketId, file, { filename: "Tajna.pdf", encryption: "keyring" });
await vola.files.download("tickets", ticketId, fileId);         // `X-Vola-Unlock` goes along
await vola.keyrings.status();                                   // locked, unlock_expires_in, attempts…
await vola.lock();                                              // DELETE the token, forget it
await vola.keyrings.changePin("493817", "271828");              // every token dies
await vola.keyrings.recover(recovery_key, "271828");            // a NEW recovery key comes back
await vola.keyrings.deletePreview();
await vola.keyrings.reset();                                    // the crypto-shred — re-authenticate first

const other = vola.withUnlock(token);   // a second instance that sends a token you obtained elsewhere
const off = vola.lockOnUnload();        // browser: `navigator.sendBeacon` ends the unlock on pagehide
```

The token lives in the instance's memory only; `lock()`, `changePin()`, `recover()` and
`reset()` clear it. A `423` — `VolaLockedError` — means the request needed an unlock it did not
have (or the token expired: the server's TTL slides with every request that carries it).

## Caller encryption (server-to-server)

```ts
const contentKey = crypto.getRandomValues(new Uint8Array(32)); // yours to keep; vola stores nothing
const info = await vola.files.upload("tickets", id, buffer, { filename: "x", encryption: "caller", contentKey });
await vola.files.download("tickets", id, info.id, { contentKey });   // on EVERY read
```

`contentKey` is refused in a browser (`caller_key_from_browser`, before any request): the
server rejects every request with an `Origin`, and the key would live in the page.

## Stats, keys, admin, lookups, UDC

```ts
await vola.stats.tenant({ recompute: true });
await vola.stats.instance("tickets", ticketId);
await vola.stats.storage();
await vola.instanceTypes();
await vola.lookups("sr");                      // no key needed
await vola.live(); await vola.ready();
await vola.keys.create({ name: "ci", scopes: ["files:read"], env: "test" });
await vola.keys.list(); await vola.keys.revoke(id);
await vola.admin.transfer({ from_tenant: "a", to_tenant: "b", instances: [...], dry_run: true });

// The UDC collections (`files`, `menu`…) through @jsudc/core's UdcClient, same auth:
const { rows } = await vola.udc.list({ collection: "files", filter: { field: "kind", op: "eq", value: "image" } });
```

`vola.request(path, options)` and `vola.json(path, schema, options)` are the escape hatch every
group is built on — for a route this version of the SDK does not wrap yet.

## Migration from the vola-spp API

The API is new and not compatible with vola-spp (plan decision 1). Old route → SDK method:

| vola-spp | `@vol-a/client` |
|---|---|
| `POST /api/v1/files/{type}/id/{id}` (multipart, `folder_path` / `folder_id` / `parent_id`) | `vola.files.upload(type, id, source, { folderPath, folderId, parentId })` |
| `PUT /api/v1/files/{type}/id/{id}/slug/{slug}` | `vola.files.putSlug(type, id, slug, source)` |
| `GET\|HEAD …/id/{file_id}` (Range / 206) | `vola.files.download(type, id, fileId, { range })`, `vola.files.head(...)` |
| `GET …/path/{path}` | `vola.files.byPath(type, id, path)` |
| `GET …/slug/{slug}` | `vola.files.bySlug(type, id, slug)` |
| `GET …/info` | `vola.files.info(type, id, fileId)` |
| `GET …/thumb/{size}?crop=` (202 = placeholder) | `vola.files.thumb(type, id, fileId, size, { crop })` → `{status: "ready" \| "generating" \| "failed"}` |
| `PATCH …/visibility` | `vola.files.patch(type, id, fileId, { is_public, is_global_public })` |
| `PATCH …/move` | `vola.files.patch(type, id, fileId, { folder_path })` |
| `DELETE …` (soft) | `vola.files.delete(type, id, fileId)` |
| `DELETE …/purge` | `vola.files.purge(type, id, fileId)` |
| `POST /api/v1/folders/{type}/id/{id}/path/{path}` | `vola.folders.create(type, id, path)` |
| `GET …/folders/…/path/{path}` | `vola.folders.list(type, id, path)` |
| `PATCH …/folders/…/path/{path}` | `vola.folders.rename(...)`, `vola.folders.move(...)`, `vola.folders.patch(...)` |
| `DELETE …/folders/…/path/{path}` | `vola.folders.delete(type, id, path, { recursive })` |
| `POST /api/v1/share` | `vola.shares.create({ file_id \| folder, password, expires_at, max_downloads })` |
| `DELETE /api/v1/share/id/{id}` | `vola.shares.revoke(id)` |
| `GET\|HEAD /share/token/{t}[/download\|/path/{p}]` | `VolaClient.openShare(url, { password, path, download })`, `vola.shares.listing(url)` |
| `GET\|HEAD /public/file/{id}` | `vola.files.public(fileId)`, `vola.files.publicUrl(fileId)` |
| `GET /api/v1/stats/tenant` | `vola.stats.tenant()` |
| `GET /api/v1/stats/instance/{type}/id/{id}` | `vola.stats.instance(type, id)` |
| `GET /api/v1/stats/storage` | `vola.stats.storage()` |
| `GET /api/v1/instance-types` | `vola.instanceTypes()` |
| `POST /api/v1/keys` | `vola.keys.create(...)` (and `list`, `revoke`) |
| `POST /api/v1/admin/transfer` | `vola.admin.transfer(...)` |
| `POST /udc/list\|describe\|read` | `vola.udc.list(...)`, `vola.udc.describe(...)`, `vola.udc.read(...)` |
| `GET /api/lookups` | `vola.lookups(locale)` |
| `X-API-Key` header | `apiKey` option (sent as `Authorization: Bearer`); `X-Tenant-Slug` → `tenantSlug` |
| — (new) | `vola.uploads.resumable(...)`, `vola.keyrings.*`, `encryption` / `contentKey` on uploads, share grants |

What changed beyond the names: the id of an instance is in the path (`/files/:type/:id`, no
`/id/` segment); visibility and move are one `PATCH` with a JSON body; a share is created with
a JSON body and followed at `/s/<token>`; the error envelope is `{ error: { code, message } }`
with stable snake_case codes.
