# Encryption in JSVola

How an encrypted file is stored, who holds which key, what a dump reveals and what to do when
something answers `409`, `423`, `429` or `503`. The model is the one thilo's Notes service
uses, adopted in [PLAN.md](PLAN.md) and **stated here in full** —
[notes-crypto-for-vola.md](notes-crypto-for-vola.md) is kept as the historical source and is not
needed to read this document. The one place vola departs from Notes as it runs today is the
**segmented blob format** (§ 2), which is what makes `Range` requests and constant memory
possible; § 14 lists every other difference. § 0 is the whole model on one page; § 15 is what an
operator has to do. Phase 6.1 (TCKK5UTHJX) ships the format, the
per-file key and the `tenant` provider; phase 6.2 (TCKFT692JH) the `keyring` provider (§ 8: a
PIN per principal, unlock tokens, recovery, brute force, reset, encrypted folders); phase 6.3
(TCKQ7JWCRJ) the `caller` provider (§ 9), the resumable upload sealed segment by segment
(§ 10), encrypted thumbnails and OCR (§ 11), the share grant (§ 12) and `client` blobs (§ 13).

Code: `packages/server/src/crypto/` (pure, no I/O, unit-tested in `test/crypto.test.ts`,
`test/keyring-crypto.test.ts` and `test/crypto3.test.ts`), `packages/server/src/services/
encryption.ts` (the row-level operations and the HTTP mapping), `services/keyrings.ts` and
`services/unlock.ts` (the keyring rows and the tokens), `routes/send-file.ts` (download),
`services/files.ts` (upload), `services/upload-crypto.ts` (the resumable upload),
`services/derivatives.ts` (thumbnails and OCR of encrypted files), `services/shares.ts` (the
grant), `services/transfer.ts` (re-wrap). Integration tests: `test/encryption.test.ts`,
`test/keyrings.test.ts`, `test/encryption3.test.ts` (a real Redis and a real worker).

## 0. The model on one page

**What is protected, against whom.** A copy of the disk, the database and the backups — taken
by whoever runs the storage, the database or the backup system, or by whoever steals a backup —
reveals the *structure* of what is stored (tenants, instances, folders, sizes, dates, who
uploaded) and nothing of its *content*: no file name, type, bytes, thumbnail or OCR text. A
`tenant` file additionally needs the key file the operator holds; a `keyring` file needs its
owner's PIN (or recovery key) on top of that; a `caller` file needs a key the server never kept;
a `client` blob was never opened by the server at all. What the model does **not** protect: a
live server compromised while it holds a key (the request's unlock, the key file in memory), and
the structural columns of a row (someone writing to the database can move or mis-size a file,
not read it). § 5 has the table of what each dump reveals.

**One format, one random key per file.** Every encrypted file is a `JSV` blob (§ 2): a 24-byte
header and AES-256-GCM segments of 1 MiB under a **file key (FK)** drawn at upload and never
reused. Its name, MIME type and the caller's metadata are sealed under the same FK (`meta_ct`);
so are its thumbnails and OCR text (§ 11). The row shows `<id>.bin`, `application/octet-stream`
and the plaintext `size`; the blob hash is the hash of the ciphertext, so there is no dedup and
no "which tenants hold this document" leak. Everything that changes — PIN change, recovery,
rotation, transfer, share, crypto-shred — touches only the 60–64 bytes of a wrapped key, never
the blob.

**Four ways to wrap the file key** (§ 3), one of them per file, chosen at upload:

| mode | choose it when | the key material | the request carries | what it costs you |
|---|---|---|---|---|
| `tenant` | the host application has no per-user secret and wants dumps and backups to be useless without the server's key — the default choice | a key line in `VOLA_KEY_FILE`, HKDF per tenant | nothing | one file to generate, back up and rotate (§ 4); the worker needs it too |
| `keyring` | a person's private files that even the operator must not open (thilo Notes) | a master key per `(tenant, principal)` behind a 6-digit PIN (Argon2id + pepper) and a recovery key | `X-Vola-Unlock`, a short-lived token (§ 8.2) | the pepper file as well; Redis; a PIN UI (`@vola/react`'s `VolaPinGate`) |
| `caller` | server-to-server, the caller already manages keys and wants vola to hold nothing | a 32-byte key per request, never stored | `X-Vola-Content-Key` (scope `encryption:caller`, never from a browser) | losing the key loses the file; no share from the server, no OCR |
| `client` | end-to-end: the client seals the blob itself and the server is bytes only | the client's | a `fk_ct` the server never opens, on `POST /uploads` | no thumbnail, OCR, share, rename or transfer |

`vola tenant-set --slug <s> --default-encryption tenant` makes a tenant's uploads encrypted
without any client change. The modes are not mixed within one file; a folder with a keyring
policy (§ 8.6) decides before the client does.

**Glossary.** *FK* — the per-file key. *KEK* — a key-encryption key: for `tenant` the HKDF of
the key line and the tenant id; for `keyring` the Argon2id of the PIN. *MK* — a keyring's master
key, wrapping the FKs of that principal's files. *kid* — four bytes of SHA-256 of a key line or
pepper line, a hint which line wrapped something. *AAD* — what AES-GCM authenticates without
encrypting: every wrap and every segment is bound to the file id (and the segment index, the
share id, the keyring id, …), so nothing can be moved between rows. *`fk_ct`, `meta_ct`,
`fk_share_ct`, `ocr_ct`* — the wrapped FK, the sealed metadata, the FK wrapped for a share, the
sealed OCR text. *Unlock token* — a keyring opened for one principal for `VOLA_UNLOCK_TTL_S`,
held in Redis, sent in `X-Vola-Unlock`. *Policy folder* — a folder whose new uploads are keyring
files. *Share grant* — a share link whose fragment holds the secret the FK is wrapped under.
*Crypto-shred* — deleting the wrapped keys (purge, reset, revoke) so the bytes become noise.
*Lazy rotation* — a new key line is prepended; files move to it as they are read.

**Where to look.** § 1–2 keys and the blob format · § 3–4 providers, the key file, rotation ·
§ 5 what a dump reveals · § 6–7 HTTP behaviour and troubleshooting · § 8 keyrings · § 9 the
`caller` mode · § 10 the encrypted resumable upload · § 11 thumbnails and OCR · § 12 the share
grant · § 13 `client` blobs · § 14 the client side and the differences from Notes · § 15
operations.

## 1. Keys

```
VOLA_KEY_FILE line (32 B)  ──HKDF-SHA256(salt "vola-tenant-kek", info tenant_id)──►  KEK_tenant
KEK_tenant                 ──AES-256-GCM, AAD "<file id>:key:tenant:<tenant id>"──►  fk_ct   (vola_file.fk_ct)
FK (32 B random, per file) ──AES-256-GCM, AAD "<file id>:meta"──────────────────────►  meta_ct (vola_file.meta_ct)
FK                         ──AES-256-GCM per segment (§ 2)──────────────────────────►  the blob on disk
```

| Key | Made how | Lives where | Code |
|---|---|---|---|
| **key line** | `vola keys-generate`: 32 random bytes, standard base64, one per line of `VOLA_KEY_FILE` (default `/run/secrets/vola.key`, mode `0600`); the FIRST line is active, the rest are older keys | on the host (or a Docker/Compose secret), **never in the database** | `crypto/tenant.ts` `parseKeyFile`, `KeyFile` |
| **KEK of a tenant** | HKDF-SHA256(key line, salt `vola-tenant-kek`, info = tenant id) → 32 B | nowhere: derived on every call | `deriveTenantKek` |
| **FK** (file key) | `randomBytes(32)` per upload, never reused for another file, never stored in the clear | only as `fk_ct` = `kid (4 B) ∥ nonce (12 B) ∥ AES-GCM(KEK, FK) (32 B) ∥ tag (16 B)` = 64 B; `kid` = SHA-256(key line)[0..4], a hint which line wrapped it | `aead.ts` `newFileKey`, `tenant.ts` `TenantWrapProvider` |
| **meta_ct** | AES-256-GCM(FK, JSON `{v: 1, filename, mime, metadata, sniffed}`, AAD `<file id>:meta`), nonce in front | `vola_file.meta_ct` | `meta.ts` |

The row of an encrypted file says nothing: `filename` is `<id>.bin`, `mime_type`
`application/octet-stream`, `extension` NULL, `kind` `other`, `metadata` `{}`. `size` is the
**plaintext** length — quotas and the UI count what the user stored, not the 16 B per segment of
GCM tags — and `hash` is the SHA-256 of the **ciphertext** (the plaintext hash is never computed
or stored: it would say which tenants hold the same document). Because FK and the nonce prefix
are random, the same file uploaded twice is two blobs: there is no deduplication of encrypted
files, by design.

Why a key per file (the Notes lesson): rotation, transfer between tenants, the PIN of phase 6.2
and crypto-shred all touch 64 bytes of `fk_ct`, never the blob. Deleting the row (purge) makes
the blob permanently unreadable even if a copy of the disk survives.

## 2. Blob format `JSV` v1, byte by byte

```
offset  size  field
     0     3  magic  "JSV"
     3     1  version  0x01
     4     4  segment_size S, u32 big-endian — default 1 MiB (1048576); 64 KiB ≤ S ≤ 64 MiB, a multiple of 1024
     8     8  nonce_prefix, random per file
    16     8  plaintext_length L, u64 big-endian — or FFFF FFFF FFFF FFFF = "deferred" (see below)
    24        segment 0
    24 + i·(S+16)   segment i
```

```
segment i, i = 0 … n−1,  n = max(1, ceil(L / S))         (an empty file is one empty segment: its tag alone)
  ct_i ∥ tag_i = AES-256-GCM(FK, nonce_i, plaintext[i·S … min((i+1)·S, L)), aad_i)
  nonce_i      = nonce_prefix (8 B) ∥ i (u32 BE)                                     — derived, not stored
  aad_i        = header (24 B, as stored) ∥ file_id (UTF-8 of the UUID) ∥ i (u32 BE) ∥ last (u8: 1 for i = n−1)
                 ∥ L (u64 BE)  — ONLY on the last segment
blob length = 24 + L + 16·n
```

**When the length is not known up front.** A multipart upload is a stream; its length is known
when it ends, and the header has already been written. The decision (the ticket left it open
between a footer and a header written last): the header carries the deferred marker and the
length is **derived** when reading — `n = ceil((|blob| − 24) / (S + 16))`,
`L = (n − 1)·S + |last segment| − 16` — and then **authenticated** by the AAD of the last
segment, which carries `last = 1` and L. A resumable upload knows its length (`Upload-Length`),
so its header carries the real L and the reader checks it against the blob before reading a
segment. Both variants are the same format; a reader handles either.

What this makes fail (`test/crypto.test.ts`): a blob cut anywhere (an earlier segment becomes
"last" and its tag was computed with `last = 0`; a cut inside a segment breaks that tag); an
appended segment (the real last one becomes a middle one; the new one has no valid tag);
reordered segments (the index is in the AAD); a blob copied onto another row (the file id is in
the AAD); any change to the header (it is in every AAD, and a different `segment_size` also
breaks the arithmetic); an unknown version (`IntegrityError` before any AES runs — the version
is read and dispatched, unlike Notes where it was only written). One limit to know: a `Range`
request that never reaches the last segment of a **deferred-length** blob cannot see a cut at an
exact segment boundary on its own (early segments do not bind the total); the server closes
that by passing the row's `size` as `expectedLength`, checked against the derived length before
the first segment is read.

**Range.** Plaintext bytes `a … b` live in segments `floor(a/S) … floor(b/S)`; the server reads
exactly that ciphertext span (`ciphertextRangeFor`: start `24 + first·(S+16)`, end clamped to the
blob), decrypts those segments, cuts the slice, and answers `206` with `Content-Range` in
**plaintext** coordinates. Memory: one segment plus one plaintext segment per request. The first
needed segment is verified **before** the status line goes out, so a damaged blob is a `409`,
not a connection that dies mid-body (`test/encryption.test.ts` spies on `StorageBackend.open`
and sees two reads: the header and the needed span).

**Nonces.** 8 random prefix bytes per file plus a 32-bit counter: 2³² segments per file (4 PiB at
1 MiB) and a prefix collision chance of 2⁻⁶⁴ per pair of files under the same key — and FK is
never shared, so that pair does not exist.

**A client could produce this format itself** (phase 6.3's `encryption: "client"`): nothing in
the header or the AAD depends on a server secret, only on the file id the client receives.

## 3. Providers (`WrapProvider`)

```ts
interface WrapProvider {
  mode: "tenant" | "keyring" | "caller";
  wrap(fk, ctx): Promise<Buffer>;              // fk → fk_ct
  unwrap(fkCt, ctx): Promise<{ fk, rewrapped? }>; // fk_ct → fk; rewrapped: a fresh fk_ct under the active key
}
// ctx: { fileId, tenantId, keyringId?, unlock?, callerKey? }
// wrap AAD: "<file id>:key:<mode>:<tenant id | keyring id>"
```

| mode | wraps FK under | protects against | the request carries | status |
|---|---|---|---|---|
| `tenant` | the tenant's KEK from `VOLA_KEY_FILE` | a dump of disk, database and backups taken without the key file | nothing | 6.1 |
| `keyring` | a principal's master key, itself behind a PIN (Argon2id + pepper) and a recovery key | the above plus a database operator; opened only during an unlock | `X-Vola-Unlock` | 6.2, § 8 |
| `caller` | a 32-byte key the caller sends on every request; nothing is kept | everything vola itself holds | `X-Vola-Content-Key` (scope `encryption:caller`, never from a browser) | 6.3, § 9 |
| `client` | nobody here: the CLIENT made the blob and wrapped the key; the server stores both opaque | everything, the server included | nothing — it is bytes | 6.3, § 13 |

The `unwrap` result's `rewrapped` is how rotation retires old keys lazily (§ 4): the service
stores it on the row (`UPDATE … WHERE fk_ct = <old>`, so a concurrent re-wrap cannot clobber)
and the download goes on whether that write succeeded or not.

Choosing the mode: a folder with an encryption policy (§ 8.6) decides first; then the
`encryption` multipart field (sent **before** the `file` part — the mode decides what is written
to disk while the part streams; a field after the part is accepted only when it agrees, `422`
otherwise), the `X-Vola-Encryption` header, the `encryption` pair of `Upload-Metadata` (tus), or
the tenant's `default_encryption` (`vola tenant-set --slug acme --default-encryption
none|tenant|keyring|caller`). `client` is accepted only on `POST /uploads` with its `fk_ct`
pair (§ 13); anything else is `422`.

## 4. The key file and rotation

```sh
vola keys-generate                      # writes VOLA_KEY_FILE (0600); refuses to overwrite
vola keys-status                        # how many files depend on which line; never prints a key
vola tenant-set --slug acme --default-encryption tenant
```

- The file is read on first use and re-read when its mtime changes (one `stat` per operation);
  the server **starts without it** — encrypted uploads, downloads and `info` then answer
  `503 encryption_unavailable`, plain files work, lists show encrypted rows masked. Put the
  file in place and the next request works, no restart.
- **Rotate by prepending a line**, never by replacing one:

  ```sh
  (echo "$(openssl rand -base64 32)"; cat /run/secrets/vola.key) > vola.key.new && install -m 600 vola.key.new /run/secrets/vola.key
  ```

  New uploads wrap under the new first line at once. An existing file opens with whichever
  line wrapped it (the `kid` hint is tried first, then every line) and is re-wrapped under the
  active line on its next download or `info`. `vola keys-status` shows how many files still
  depend on each older line; a line may be removed only when its count is zero — a file whose
  line is gone is `409 vola_integrity` forever (`keys-status` prints `NO LINE` and a warning
  for exactly that).
- A **transfer** between tenants (`POST /admin/transfer`, `vola transfer`) re-wraps every
  `tenant` file's key for the destination tenant inside the same transaction (`services/
  transfer.ts`); the metadata record is bound to the file id only and needs nothing. Without
  the key file the whole transfer is `503`; a key that does not open is `409`. An instance
  that holds a **`keyring` file is refused with `409 encrypted_transfer_unsupported`**, by
  design and not only for now: a keyring belongs to a principal OF A TENANT (the wrap AAD
  carries the keyring id, the keyring row the tenant id), and only its owner's PIN opens the
  master key — a server-side re-wrap for another tenant would need a key nobody but that
  person holds. Move such files by downloading them under an unlock and uploading them in the
  destination tenant (under that tenant's keyring of the same person, if any). `caller` files
  are refused for the same reason (6.3).
- Back the file up. Without it every `tenant`-encrypted file of every tenant is noise, with no
  recovery path — that is the point.

## 5. What a dump reveals

| Dump | Sees | Does not see |
|---|---|---|
| **Database** (`vola_file`) | the structure: tenant, instance, folder, slug, version chain, `size` (plaintext length), `created_at`, who uploaded, `encryption` / `enc_format`, that a file is encrypted, which key line wrapped it (`kid`); `fk_ct` and `meta_ct` as ciphertext | the name, the MIME type, the caller's metadata, FK, any key line; without `VOLA_KEY_FILE` nothing opens |
| **Disk** (`<storage>/blobs`) | `JSV` headers (segment size, nonce prefix, sometimes the plaintext length), ciphertext sizes (≈ plaintext + 16 B per segment), when blobs were written; no derived files — the worker never touches an encrypted file | contents, names, types; which tenant a blob belongs to (that is a database fact) |
| **Database + disk**, no key file | the above, joined | the same: `fk_ct` is under a KEK nobody can derive |
| **Database + disk + key file** | everything of `tenant` mode | — for `tenant` files (this is the operator); a **`keyring`** file still needs its owner's PIN or recovery key: `fk_ct` is under the master key, the master key under Argon2id(PIN, pepper) — without `VOLA_PEPPER_FILE` not even a brute force over the 10⁶ PINs can start, with it each try costs 64 MiB and ~0.1 s (§ 8.7) |
| **Redis** | `vola:unlock:<token>` → `{tenant_id, principal, keyring_id, mk}` for every keyring unlocked RIGHT NOW (TTL ≤ `VOLA_UNLOCK_TTL_S`), the index sets, the attempt mutexes; file events and job payloads (ids only) | the master key: `mk` is wrapped under the key file (`wrapForStore`, HKDF salt `vola-unlock-kek`, bound to the token). **Redis + the key file** = the master key of every principal unlocked at that moment — the one live-server scenario the model does not cover |
| **Logs, memento audit, UDC events** | file ids, sizes, `encryption`, `application/octet-stream` as the MIME of an encrypted file, counts; keyring ids, attempt counters, token fingerprints (16 hex of SHA-256) | the real name or type of an encrypted file (`fileAuditPayload` leaves `filename` out; the server never logs a decrypted name), FK, `fk_ct`, key lines, a PIN, a recovery key, an unlock token, a master key |

What is **not** authenticated: the row's structural columns (`folder_id`, `slug`, `size`,
`is_public`, …) — someone writing to the database can move a file or change its recorded size
(a wrong `size` makes the download `409`), as in Notes. What the disk shows since 6.3: next to
an encrypted blob its **sealed** derivatives (`<blob>.enc-<file id>-thumb-…`, § 11), and under
`uploads/` the ciphertext `.part` and the sealed `.partial` of an upload in flight (§ 10) — a
derivative or a part file never holds a byte of plaintext. The model protects dumps and
backups, not a live server that is compromised while it holds the key.

## 6. HTTP behaviour

| | plain file | encrypted file |
|---|---|---|
| `ETag` | `"<sha256 of the bytes>"` | `"<file id>"` (the plaintext never changes; the blob hash is not a plaintext key) |
| `Cache-Control` | `private, no-cache` | `no-store` (also on `…/info`) |
| `Content-Disposition` | `inline` for images, video, audio, PDF | `inline` ONLY for a PNG / JPEG / GIF / WebP the **bytes** identified; everything else `attachment; filename*=` with the decrypted name |
| `Range` | `206`, `Content-Range` in file bytes | the same, in **plaintext** coordinates; the blob is read in whole segments |
| `/public/:fileId`, `is_global_public` | — | never: `409 encrypted_not_public`, the public route answers `404` |
| `/thumb/:size` | `200` / `202` | `200` decrypted from the sealed sibling, `no-store`, `ETag` of the file id; `202` only for a `tenant` file the worker is rendering; `404 no_thumbnail` for a `client` file or one above `VOLA_ENC_INLINE_DERIVE_MAX_BYTES` (§ 11) |
| share link | — | a share GRANT: the `url` ends in `#<secret>`, the download needs `X-Share-Secret` (§ 12); `409 encrypted_share_requires_grant` for `caller` without `fk_share_ct` and for `client` |
| `X-Vola-Encryption` on a download | — | the mode (`client`: the body is the `JSV` blob itself) |
| UDC `files` row | real values | real `filename`, `mime_type`, `extension`, `kind` when the server holds the key; `<encrypted>` / null otherwise; filters, sorts and cursors always see the mask |
| `PATCH {filename}` | `409 file_exists` on a collision | the metadata record is re-sealed; no collision rule (the stored name stays `<id>.bin`) |
| a `keyring` file without the owner's `X-Vola-Unlock` | — | download, `info`, `PATCH {filename}`, `/thumb`, `POST /shares`, every PATCH of a resumable upload: `423 vola_locked`; lists, UDC rows and subscriptions: the mask (`<encrypted>`), never an error |
| a `caller` file without `X-Vola-Content-Key` | — | the same `423`; with an `Origin` header `400 caller_key_from_browser`; without the `encryption:caller` scope `403` |
| a `client` file | — | download: the blob as uploaded (`application/octet-stream`, `Range` in ciphertext bytes); `info`, lists: the mask; `/thumb` `404`; share `409`; `PATCH {filename}` `409 client_opaque` |

## 7. Troubleshooting

**`503 encryption_unavailable`** — "encryption mode "tenant" is not available: the server has no
key material for it". The server cannot read `VOLA_KEY_FILE`: it is missing, unreadable by the
server's user, or malformed (a line that is not base64 of 32 bytes — the log has a `key file
unusable` warning with the line number). Fix the file; no restart is needed. The CLI (`transfer`,
`keys-status`) reads the same variable. In Compose, mount the file at `/run/secrets/vola.key` in
BOTH the `vola` and `vola-worker` services (`docker-compose.yaml` has the commented example).

**`409 vola_integrity`** — "The file could not be decrypted." Always this sentence; the server log
has the reason (`integrity failure` with `reason`). Causes, most likely first: the key line
that wrapped this file was removed from the key file (`vola keys-status` shows `NO LINE` —
restore the line); the blob on disk was modified, truncated or replaced (a restore from a
backup that does not match the database); `fk_ct` or `meta_ct` was edited; the file's row was
moved to another tenant by hand instead of through `/admin/transfer` (the wrap AAD carries the
tenant id — move it back, then transfer properly); the row's `size` differs from the blob
(`expectedLength` check). The row and the file's metadata are intact in every case but the
first; only the bytes are refused.

**A list shows `<id>.bin` / `<encrypted>` for a file that was fine yesterday** — the key file
went away or lost the line; `…/info` on that file says which (`503` or `409`).

**`422 encryption: send it before the file part`** — the client put the `encryption` field after
the `file` part and it disagrees with what was stored (the tenant default). Send the header
`X-Vola-Encryption` or put the field first.

**`423 vola_locked` on a `caller` file** — the request carried no `X-Vola-Content-Key` (or an
empty one). A wrong key is `409 vola_integrity`. **`400 caller_key_from_browser`** — the
request had an `Origin` header: the caller mode is server-to-server, a browser never holds that
key. **`403 forbidden` with `required: ["encryption:caller"]`** — the API key lacks the scope
(`vola key-create --scopes files:read,files:write,encryption:caller`).

**`410 upload_lost` on a PATCH of an encrypted upload** — the sealed tail (`<id>.partial`) or the
sealed head does not match the state the database committed (a crash between the two writes,
or a restore of one without the other): start a new upload. **`422 client_blob_invalid`** — a
`client` upload completed with bytes that are not a `JSV` blob (magic, version, segment size)
or whose lengths do not add up (the header promised more than arrived).

**`401 share_secret_required`** — the share is a grant (an encrypted file) and the request
carried no `X-Share-Secret`: the secret is the part after `#` in the link. A wrong secret is
`409 vola_integrity`.

**`SKIPPED` with "encrypted under a key the worker does not hold"** — a `keyring`, `caller` or
`client` file got a job (someone called `requestThumbnail` / `requestOcr` by hand): the worker
has no such key; `/thumb` renders those inline under the request's key. **"encrypted file above
VOLA_ENC_INLINE_DERIVE_MAX_BYTES"** — raise the limit (the whole plaintext is decrypted into
memory for a render) or live without the derivative.

**`503 encryption_unavailable` on a keyring route or a `keyring` file** — one of three things is
missing: Redis (`VOLA_REDIS_URL`; the unlock tokens live there, and without it the keyring
provider does not exist — the start-up log says `encryption: tenant provider (no Redis: no
keyring provider)`), the pepper file (`VOLA_PEPPER_FILE`, `vola pepper-generate`), or the key
file (the master key is wrapped under it while it sits in Redis). All three are re-checked on
every call; no restart.

**`423 vola_locked`** — the request touched a `keyring` file without a usable unlock: no
`X-Vola-Unlock`, an expired one (`VOLA_UNLOCK_TTL_S` without a request), one of another
principal, tenant or keyring, or one dropped by a PIN change, recovery, reset or `DELETE
…/unlock`. Always this one answer. Unlock again (`POST /keyrings/me/unlock {pin}`) and send
the new token. An upload into a folder with an encryption policy needs the token of the
keyring the policy names — another principal's token is `423` too.

**`429 too_many_attempts`** — the keyring is locked out after wrong PINs (§ 8.4); the body and
`Retry-After` say for how long, and the right PIN is refused as well until then. A `429` with
`retry_after: 1` and no `locked_until` means another PIN check of the same principal was in
flight (one at a time).

**`vola pepper-status` prints `NO LINE`** — keyrings whose pepper line was removed from the
file: neither their PIN nor their recovery key opens them any more, and their files are
unreadable until the line is restored. Rotate by prepending, never by replacing.

## 8. The `keyring` provider (phase 6.2)

The PIN model of thilo's Notes service, stated here in full. A **keyring**
belongs to one principal of one tenant — the `X-User-Id` of the host application; one row of
`vola_keyring` per `(tenant_id, principal)`, soft-deleted by a reset. It holds a 32-byte random
**master key (MK)** twice wrapped and nothing else:

```
PIN          ──Argon2id(kdf.salt, secret = pepper)──► KEK_pin ──AES-256-GCM, AAD "<keyring id>:mk:pin"──────► mk_pin_ct
recovery key ──Argon2id(recovery_salt, pepper)─────► KEK_rec ──AES-256-GCM, AAD "<keyring id>:mk:recovery"─► mk_recovery_ct
MK ──AES-256-GCM, AAD "<file id>:key:keyring:<keyring id>"──► fk_ct  (60 B: nonce ∥ ct ∥ tag; no kid, no lazy re-wrap)
FK ──► meta_ct, the JSV blob                                   (exactly as for a tenant file, § 1–2)
```

| Key | Made how | Lives where | Code |
|---|---|---|---|
| **pepper** | a line of `VOLA_PEPPER_FILE` (default `/run/secrets/vola.pepper`; `vola pepper-generate`; same format as the key file: base64 32-byte lines, the FIRST active) — the Argon2 `secret` of every PIN and recovery key | on the host, never in the database; `kdf.pepper_line` holds the `kid` (SHA-256 prefix, hex) of the line the PIN wrap was last made with — a hint, not a secret | `crypto/keyring.ts` `deriveKek`, `freshKdf`, `pepperLineId`; `KeyFile` |
| **KEK_pin** | Argon2id(PIN, 16 B salt, pepper), **64 MiB / t = 3 / p = 1**, 32 B out (RFC 9106's second profile) — in libuv's thread pool, never on the event loop | nowhere; derived at every unlock | `deriveKek` |
| **KDF parameters** | `{alg: "argon2id", salt, m, t, p, pepper_line}` written **per keyring** at setup and read at unlock: raising the cost (`KeyringsDeps.kdfCost`) changes new wraps only, no migration | `vola_keyring.kdf` (jsonb) | `freshKdf`, `kdfSalt` |
| **MK** | `randomBytes(32)`, one per keyring, **never rotated** (a PIN change re-wraps the MK, not the files) | only wrapped: `mk_pin_ct`, `mk_recovery_ct`; while unlocked, in Redis wrapped under the key file (§ 8.2); in the clear only in process memory for one request, zeroed after | `newMasterKey`, `wrapMasterKey`, `unwrapMasterKey` |
| **recovery key** | 20 random bytes as 32 base32 characters in 8 groups of 4 (`K7QM-2P9X-…`), shown ONCE at setup and after every recovery; typed input is normalised — upper case, spaces and dashes dropped, `0 → O`, `1 → I` | nowhere; `recovery_salt` (16 B, its own) and the wrap | `newRecoveryKey`, `normalizeRecoveryKey`, `isRecoveryKeyShaped` |
| **FK** | per file, as always | `vola_file.fk_ct` under the MK; `vola_file.keyring_id` names the keyring | `KeyringWrapProvider` |

### 8.1 Routes — `/vola/keyrings`, scope `keyrings:write`, principal = `X-User-Id` (`400 user_required` without one)

| | | |
|---|---|---|
| `GET` | `/keyrings/me/status` | `{keyring_id, has_pin, locked, unlock_expires_in, locked_until, attempts, pin_set_at}`; reads the token of the request **without extending it** |
| `POST` | `/keyrings/me` `{pin}` | `201 {keyring_id, recovery_key}` — the key this once; `409 keyring_exists`; `422 pin_invalid` with `reason: length \| digits \| trivial` |
| `PUT` | `/keyrings/me/pin` `{current_pin, new_pin}` | `204`; the MK is re-wrapped under the new PIN with a fresh salt, **no file is touched** (`fk_ct` identical before and after — `test/keyrings.test.ts` checks the bytes), every token of the principal dies; the current PIN is checked like an unlock (§ 8.4) |
| `POST` | `/keyrings/me/recover` `{recovery_key, new_pin}` | `{keyring_id, recovery_key}` — a NEW recovery key (the old one was typed somewhere and is retired), new PIN wrap, counter cleared, every token dropped; a wrong key is `403 recovery_wrong` and is **never counted** as a PIN attempt (160 bits are not guessable, and counting would let PIN guessing lock the owner out of recovery too) |
| `POST` | `/keyrings/me/unlock` `{pin}` | `{token, expires_in}`; `403 pin_wrong {attempts, retry_after}`; `429 too_many_attempts` + `Retry-After` |
| `DELETE` | `/keyrings/me/unlock` | ends the token of `X-Vola-Unlock`; `204`, idempotent |
| `POST` | `/keyrings/me/unlock/close` `{token}` (or the bare token as `text/plain`) | the `navigator.sendBeacon` alias: **no API key** — holding the token is the whole authority and all it can do is end it; `204` |
| `POST` | `/keyrings/me/reset` `{confirm: "RESET"}` | the crypto-shred (§ 8.5): `{keyring_id, files, blobs}` |
| `GET` | `/keyrings/me/delete-preview` | `{keyring_id, files, live_files, bytes}` from the rows alone, nothing decrypted |
| `GET` / `POST` | `/keyrings/by-principal/:principal/status`, `…/reset` | an **admin** key (`X-Tenant-Slug`) for another principal — status and reset only, never an unlock |

### 8.2 The unlock token

`POST …/unlock` with the right PIN writes to Redis

```
vola:unlock:<token>                       →  {tenant_id, principal, keyring_id, mk}   EX VOLA_UNLOCK_TTL_S
vola:unlock-index:<tenant id>:<principal> →  SET of the principal's tokens            EX 86400
```

`token` = 32 random bytes, base64url (43 characters); `mk` = `kid ∥ nonce ∥ ct ∥ tag` under
HKDF-SHA256(active key line, salt `vola-unlock-kek`, info = tenant id), AAD = the token
(`wrapForStore`) — a dump of Redis alone opens nothing, and an entry copied under another token
does not open either. The client sends the token in **`X-Vola-Unlock`** on every request that
touches a `keyring` file (download, `info`, `PATCH {filename}`, an upload with `encryption =
keyring` or into a policy folder, the UDC `list` / `read`, the `subscribe` upgrade — the
subscription reveals rows under the token of ITS OWN upgrade, never the uploader's). **Never in a
URL**: not a query parameter, not a path, not a share link.

The TTL **slides**: every request that resolves the token sets it back to the full
`VOLA_UNLOCK_TTL_S` (default **150 s**; Notes' clients lock at 120 + 10 s, the server TTL is the
backstop for a tab that died). `GET …/status` reads the remaining seconds without sliding, so a
"still open?" poll does not keep the keyring open. One `423 vola_locked` for everything short of
a token that is exactly this principal's, this tenant's and this file's keyring's — missing,
expired, malformed, another principal's, another tenant's, another keyring's, an entry that does
not open — so a token reveals nothing about any other.

**Without Redis there is no keyring provider**: every keyring route and every `keyring` file
answers `503 encryption_unavailable` (the start-up log says so); `tenant` files and plain files
are unaffected. The same `503` for a missing pepper file or key file.

### 8.3 PIN

Exactly **6 digits** (`PIN_LENGTH` in `@vola/core`, one constant — a host that wants a
passphrase changes one place); trivial ones refused at setup, PIN change and recovery: all the
same digit, or a run up or down by one (`123456`, `654321`, `000000`) — `422 pin_invalid` with
`reason`. An unlock checks only the shape (a typed PIN is compared to the keyring, not judged).

### 8.4 Brute force

The counter (`attempts`) and `locked_until` live **in the keyring row**, so they survive a
restart; a **mutex per principal** (`SET vola:attempt-lock:<tenant>:<principal> NX EX 15`)
serialises PIN checks, so twenty parallel guesses cannot all read `attempts = 0` (a second one
in flight is `429` with `retry_after: 1`). The order of one check (`services/keyrings.ts`
`checkPin`): shape → mutex → `locked_until` in the future is `429 too_many_attempts` with
`Retry-After` **whatever the PIN** → the wrap is tried under every pepper line (the hinted one
first) → wrong: `attempts + 1`, `locked_until = now + delay`, log `vola_unlock_failed`, `403
pin_wrong {attempts, retry_after}`; from the tenth also `vola_locked_out` and the audit event
`VOLA_KEYRING_LOCKED_OUT` → right: counter and lock cleared, and when an older pepper line
opened it the PIN wrap is re-made under the active line (lazy pepper rotation).

| wrong PINs in a row | wait | |
|---|---|---|
| 1–2 | 0 | `FREE_ATTEMPTS = 3` |
| 3 | 1 s | |
| 4 | 5 s | |
| 5–9 | 30 s | |
| 10 | 1 h | `LOCKOUT_AT = 10`, `LOCKOUT_BASE_S = 3600` |
| 11, 12, … | 2 h, 4 h, … (capped at two years) | `LOCKOUT_BASE_S · 2^(n − 10)` |

`crypto/keyring.ts` `attemptDelayS`; the table is the Notes one (`crypto.py::attempt_delay_s`).
`GET …/status` returns `locked_until` so a client can draw the countdown.

### 8.5 Reset — the crypto-shred

`POST …/reset {confirm: "RESET"}`: re-authenticating the person is the **caller's** job (in
thilo the password through svc_tenants); vola asks for the scope and the confirmation and then
removes every file under the keyring — every version, soft-deleted rows included (they hold a
wrapped key too) — **storage first, then the row** (under the advisory lock uploads commit
under; an encrypted blob is never shared, the check is for the one row of another file that
could still cite its hash), then soft-deletes the keyring and drops every token. A blob that
cannot be removed keeps its row (nothing is left on disk without a trace) and the call ends in
`500 blob_not_removed` after the others; the keyring stays and the call can be repeated. The
next setup makes a new keyring with a new master key: the old files are gone by design, with
or without the PIN. `GET …/delete-preview` gives the counts for the dialog, decrypting nothing.
Audit: `VOLA_KEYRING_RESET {keyring_id, files, blobs}`.

### 8.6 Encrypted folders — a policy, not a key

`PATCH /folders/:type/:id/*path {default_keyring: "me" | null}` sets `vola_folder.
default_keyring_id` to the keyring of the request's `X-User-Id` (`404 keyring_not_found` without
one), or clears it. From then on **every new upload into that folder or any folder below it is
a `keyring` file under that keyring** — `POST /files` (`folder_path`, `folder_id`, or a
`parent_id` whose folder is under the policy), `PUT …/slug/:slug`, and a resumable upload (the
policy is read at creation and again at completion). The uploader needs the token of THAT
keyring: another principal's token is `423`. The policy outranks an explicit `encryption`
(`none` / `tenant` in a policy folder is `422`), and like the `encryption` field the folder
must be named **before** the `file` part — a folder that arrives after the bytes were staged
plain is `422` ("send the folder field before the file part"). The nearest ancestor with a
policy wins (one query over the path prefixes, `services/folders.ts` `effectiveKeyringId`).
Moving a file into or out of a policy folder **does not touch its crypto**: a plain file moved
in stays plain, a keyring file moved out stays under its keyring. Files already in the folder
when the policy is set are not re-encrypted.

### 8.7 What a dump of a keyring reveals

`vola_keyring`: who has a keyring (tenant, principal), when the PIN was set, the KDF cost and
salts, `attempts` / `locked_until`, and the two wraps as ciphertext. Nothing in the row, the
file rows, the blobs or Redis is the master key, a file key, the PIN or the recovery key —
`test/keyrings.test.ts` "what a dump reveals" re-derives MK and FK the honest way and searches
every column, the blob and the Redis entry for them, raw, base64 and hex. Without the pepper
file a brute force over the 10⁶ PINs cannot even start (the pepper is the Argon2 `secret`); with
it each guess costs 64 MiB and ~0.1 s; the recovery wrap is under 160 bits. The window the model
does not cover: Redis + the key file + the database, together, while a principal is unlocked —
that is the master key of that principal for at most `VOLA_UNLOCK_TTL_S` after their last
request.

### 8.8 Operations

```sh
vola pepper-generate                 # VOLA_PEPPER_FILE (default /run/secrets/vola.pepper), 0600, refuses to overwrite
vola pepper-status                   # keyrings per pepper line; NO LINE = keyrings nobody can open any more
# rotate: prepend a line; old lines stay — a keyring moves to the active line at its next unlock
(echo "$(openssl rand -base64 32)"; cat /run/secrets/vola.pepper) > p.new && install -m 600 p.new /run/secrets/vola.pepper
```

Back up the pepper file **with** the key file: without the pepper no keyring can be unlocked
or recovered; without the key file no unlock entry in Redis opens (and no `tenant` file).
`VOLA_UNLOCK_TTL_S` (5 … 86400) is the server-side backstop; clients lock earlier. The audit
events `VOLA_KEYRING_CREATED`, `_PIN_CHANGED`, `_RECOVERED`, `_RESET`, `_LOCKED_OUT`
(`instance_type: vola_keyring`) and the log lines `vola_unlock_failed`, `vola_locked_out`,
`vola_recovery_failed` carry the keyring id and counters only.

Where this phase departs from the ticket's text: the ticket lists the delays as "0, 0, 0, 1 s,
5 s, 30 s ×5, 1 h, then doubling"; the document it defers to has 1–2 free, 3 → 1 s, 4 → 5 s,
5–9 → 30 s, 10 → 1 h — the document's table is implemented (`FREE_ATTEMPTS = 3` means fewer
than three cost nothing). `kdf.pepper_line` holds the `kid` of the line, not its index, because
an index changes when a line is prepended.

## 9. The `caller` provider (phase 6.3)

The third wrap provider over the same blob and the same `WrapProvider` interface
(`crypto/caller.ts`): the file key is wrapped under a 32-byte key the **caller** sends with every
request, and vola keeps nothing but `fk_ct`.

```
X-Vola-Content-Key (32 B, base64) ──AES-256-GCM, AAD "<file id>:key:caller:<tenant id>"──► fk_ct (60 B: nonce ∥ ct ∥ tag)
FK ──► meta_ct, the JSV blob                                                              (exactly as for a tenant file)
```

| | |
|---|---|
| who may | an API key with `files:write` / `files:read` **and `encryption:caller`**; a key without the scope is `403 forbidden` with `required: ["encryption:caller"]` |
| from where | server-to-server only: a request that carries an `Origin` header (a browser) is `400 caller_key_from_browser`, key or no key |
| on which requests | the upload (`POST /files`, `PUT …/slug`, and **every** `PATCH` of a resumable upload — each one unwraps the file key to seal its segments, § 10) and every read: download, `info`, `/thumb`, `PATCH {filename}`, the UDC `read` |
| without the key | `423 vola_locked` — the same answer a `keyring` file gives without its unlock; lists, UDC rows and subscriptions show the mask (`<encrypted>`), never an error |
| a wrong key | `409 vola_integrity`, the one fixed sentence |
| a malformed header | `400 bad_request` ("X-Vola-Content-Key: base64 of 32 bytes is required"), on every route |
| where the key goes | nowhere: not a column, not Redis, not a log line (the logger redacts `*.headers["x-vola-content-key"]` wherever a library logs request headers — `@fastify/multipart` does at `trace`; `test/encryption3.test.ts` reads every line of a trace-level logger for the key in base64, base64url and hex), not an error message. The request context's buffer is zeroed when the response is out (`auth.ts`, `onResponse`) — as far as Node lets a buffer be forgotten |
| rotation, recovery | none: there is no "active key" to move to and nobody but the caller holds the one there is. A caller that loses its key has lost the file, by design |
| share | `409 encrypted_share_requires_grant` — the server has no key to wrap under a secret at creation time. The exception: the caller sends its own grant, `fk_share_ct` = `nonce ∥ AES-256-GCM(S, FK, AAD "<file id>:key:share:caller")` (base64) in `POST /shares`; the `url` then carries no fragment and the caller appends `#<S base64url>` itself (§ 12) |
| transfer | `409 encrypted_transfer_unsupported`, like `keyring` (§ 4) |
| derivatives | made **in the request that holds the key** (`/thumb` renders inline), never by the worker; no OCR (§ 11) |
| tenant default | `vola tenant-set --slug acme --default-encryption caller` is allowed: every upload of that tenant then needs the key |

What a dump reveals for a `caller` file: database + disk + Redis + key file + pepper file open
**nothing** — the 60 bytes of `fk_ct` are under a key that never touched the server's storage.
The one place the key exists on the server is process memory, for the life of one request.

## 10. The encrypted resumable upload (phase 6.3)

Since 6.3 a resumable upload with `encryption != none` (`services/upload-crypto.ts`) seals the
incoming plaintext **segment by segment, as it arrives**: the part file is the `JSV` blob from
its first byte and the disk never holds more than one segment of the file outside the blob —
and that one sealed too. The 6.1/6.2 behaviour (a plaintext part file encrypted at
completion) remains only for the one case it has to: an upload created plain whose folder got a
keyring policy afterwards.

### 10.1 What one upload keeps between PATCHes

```
<uploads>/<upload id>.part     header (24 B) ∥ sealed segment 0 ∥ … ∥ sealed segment next_index − 1
<uploads>/<upload id>.partial  AES-256-GCM(FK, nonce = partial_prefix ∥ partial_writes, plaintext tail,
                               AAD "<file id>:partial:<next_index>:<partial_writes>")   — absent when the tail is empty
vola_upload.enc_state          {v: 1, mode, file_id, fk_ct, keyring_id, nonce_prefix, segment_size, next_index,
                               partial_bytes, partial_prefix, partial_writes, hash, head_ct}
vola_upload.offset             next_index · S + partial_bytes  — the PLAINTEXT offset `HEAD` reports
```

| field | what |
|---|---|
| `file_id` | the id the file will have — drawn at creation because it is in the AAD of every segment; `Vola-File-Id` on the `201` of the creation and on every `HEAD` |
| `fk_ct` | the file key wrapped under the mode's provider (base64), exactly as it will sit in `vola_file.fk_ct`; a `tenant` key that opened under an older key-file line is re-wrapped here too (lazy rotation) |
| `nonce_prefix`, `segment_size` | the blob header's (§ 2); the header itself is written into `.part` at creation and carries the real plaintext length (`Upload-Length` is known) |
| `next_index` | segments sealed and on disk |
| `partial_bytes`, `partial_prefix`, `partial_writes` | the sealed tail: how many plaintext bytes, the 8-byte random prefix of ITS nonces (never the blob's), how many times it was sealed |
| `hash` | the blob's SHA-256 midstate (`crypto/sha256.ts`: eight words, the unprocessed tail, the byte count) after the header and every sealed segment |
| `head_ct` | the first 4100 bytes of the plaintext sealed under FK (AAD `<file id>:head`): what MIME sniffing needs at completion |

### 10.2 One PATCH

1. The row is locked (`FOR UPDATE NOWAIT`, as before); the offset must match.
2. The file key is unwrapped under **this request's** material: the key file (`tenant`), the
   request's `X-Vola-Unlock` (`keyring` — `423` without the owner's token), the request's
   `X-Vola-Content-Key` (`caller` — `423` without, `409` wrong). Before a byte of the body is read.
3. The sealed tail is read back and opened; the sealed head likewise. Either not matching the
   committed state (a crash between the file write and the row commit, a restore of one without
   the other) is `410 upload_lost`: start a new upload.
4. The part file is cut back to `24 + next_index · (S + 16)` (a PATCH that died after writing a
   segment but before committing it).
5. The body is appended to the tail in memory. Segment `i` is complete at `S` bytes — the last
   one (`i = n − 1`, known from `Upload-Length`) at `L − (n − 1)·S` — and is sealed at once as
   `AES-256-GCM(FK, nonce_prefix ∥ i, plaintext, aad_i)` with the AAD of § 2 (`last = 1` and `L`
   on the last), written at its offset, and added to the running hash. The plaintext buffer is
   zeroed after sealing.
6. What is left (less than a segment) is sealed into `.partial` under the nonce
   `partial_prefix ∥ (partial_writes + 1)` — a counter, so re-sealing the growing tail never
   reuses a nonce under FK, neither with an earlier version of itself nor with the full segment
   it becomes (a different prefix). An empty tail removes the file.
7. The row commits `next_index`, the tail's size and counter, the hash state, the head, and the
   plaintext offset. A body that fails mid-way commits what arrived (the segments, the tail) and
   then reports the error, so the next `HEAD` is exact and the next PATCH resumes **from that
   byte** — not from the last segment boundary.
8. The key is zeroed.

Memory per PATCH: one segment plus one chunk. A body longer than the room left is
`400 upload_overflow` and nothing of it is committed (as for a plain upload).

### 10.3 Completion

`offset = length` completes the upload in the same transaction as the last PATCH: the state must
say `next_index = n` and `partial_bytes = 0` and the part must be exactly
`24 + L + 16·n` bytes (`410` otherwise); the hash comes out of the midstate — **nothing is read
twice** —, the head out of `head_ct`, and the part file is hard-linked into the store like any
staged blob (`storage.commit`). The row is written as in 6.1: `size` the plaintext length,
`hash` the blob's, `fk_ct` freshly wrapped by the mode's provider, `meta_ct` sealed from the
sniffed head and the metadata. A zero-length upload is one empty sealed last segment, written
at creation.

A folder whose keyring policy appeared after an **encrypted** upload was created — or names
another keyring than the one the segments are under — cannot be honoured: `422` at completion,
delete the upload and start again. (A **plain** upload in that situation is encrypted at
completion as in 6.2.)

### 10.4 What a dump of `uploads/` reveals

The `.part` of an encrypted upload is a `JSV` blob prefix: header (segment size, nonce prefix,
length) and sealed segments. The `.partial` is `ct ∥ tag` of at most one segment, under a nonce
and AAD only `enc_state` knows. Without the file key — a `tenant` key needs the key file, a
`keyring` key its owner's PIN, a `caller` key the caller — nothing of either opens.
`test/encryption3.test.ts` plants a random marker every 10 000 bytes of the plaintext and
searches every file under `uploads/` and `tmp/` for it after every PATCH and after a cut
connection.

## 11. Thumbnails and OCR of encrypted files (phase 6.3)

The rule: a derivative of an encrypted file is allowed only as a **sealed
sibling under the same file key**, made by whoever holds that key, never in the clear on disk,
in the database or in an index (`services/derivatives.ts`, `crypto/derived.ts`).

```
thumbnail  <blob>.enc-<file id>-thumb-<size>-<crop>  =  nonce ∥ AES-256-GCM(FK, webp, AAD "<file id>:thumb:<size>:<crop>")
OCR        vola_file_metadata.ocr_ct                 =  nonce ∥ AES-256-GCM(FK, {v: 1, text, lang, pages}, AAD "<file id>:ocr")
                                                        ocr_text / ocr_lang / ocr_pages stay NULL  →  ocr_tsv is empty
```

| mode | who holds the key | thumbnails | OCR |
|---|---|---|---|
| `tenant` | the server (the key file) — the **worker** too, it reads the same `VOLA_KEY_FILE` | by the worker in `async` mode (the four sizes after the upload, like a plain file; `/thumb` answers `202` while it renders), inline in `sync` mode or when the queue is unreachable | by the worker (`VOLA_OCR_ENABLED`, `tesseract`), the result sealed into `ocr_ct`; `…/info` shows `text_preview` / `?ocr=full` because the server has the key |
| `keyring`, `caller` | only the request (the unlock, the content key) | **inline, in the request that holds the key**: the first `/thumb` with the token / key renders, seals and stores the sibling; every later one decrypts it. Never `202` — no worker holds that key; `423` without it | **none in v1.0.** A background pass needs the key, and nobody in the background has it; an inline pass at upload time would hold a tesseract run (seconds per page) inside a request that holds a PIN unlock or a caller's key — and the result could only be read back under that same key, so there is no search to feed either. A later phase may run it inline on demand (`?ocr=run`) if a host wants it |
| `client` | nobody here | `404 no_thumbnail` | none |

Common to every mode:

- the plaintext is decrypted **into memory**, never onto disk: a raster image goes to sharp as a
  buffer; a PDF is rasterised through `pdftoppm`'s stdin and stdout (`-` for the input, no
  output root: `services/pdf-pages.ts`), page by page for OCR, and tesseract reads each page
  through `stdin`. The temporary directory of the plain-file path is not used;
- hence the limit `VOLA_ENC_INLINE_DERIVE_MAX_BYTES` (default 25 MiB): the whole plaintext has
  to be in memory. A larger file gets no derivative — `/thumb` is `404 no_thumbnail`, the worker
  marks the job `SKIPPED` ("encrypted file above VOLA_ENC_INLINE_DERIVE_MAX_BYTES"). `0` turns
  derivatives of encrypted files off;
- `/thumb` of an encrypted file first opens the file (`503` / `409` / `423` / `400` as a
  download would), checks the **real** MIME type from `meta_ct` (a text file is `404` whatever
  its stored `application/octet-stream` says), then serves the sibling decrypted with
  `Cache-Control: no-store` and an `ETag` of `"<file id>.thumb-<size>-<crop>.webp"` — never the
  blob hash, never a content key. `304` on `If-None-Match` works; a shared cache never sees the
  bytes;
- the sealed sibling carries no WebP magic (`test/encryption3.test.ts` reads it from disk) and
  opens for its file, size and crop only (the AAD);
- **search**: an encrypted file's OCR text is not in `ocr_tsv`, so the UDC `ocr` filter never
  matches it and the `ocr` flag says "no text". This is stated, not worked around: a full-text
  index of the plaintext would be the plaintext. A host that needs search over encrypted
  documents decrypts in its own process under its own key, as Notes does with titles;
- **purge** removes the blob and every `<blob>.*` sibling with it; the **crypto-shred** (a
  keyring reset, a purged row) covers the derivatives anyway — without FK a sibling is noise. An
  encrypted blob is never shared between rows (random key and nonce), so the "another row still
  cites this hash" rule of purge cannot keep a sealed sibling alive for a file that is gone.

## 12. The share grant (phase 6.3)

A share of an encrypted file carries the file key **re-wrapped
under a secret that lives only in the link**. The server makes the grant when it holds the key
and forgets the secret at once; the recipient gets plaintext — that is what a share is for, and
a UI must say so.

```
S (32 B random)  ──AES-256-GCM, AAD "<share id>:key"──►  fk_share_ct (vola_share_link, 60 B)     — S itself is NOT stored
url = <origin>/vola/s/<token>#<S base64url>            — the fragment never reaches a server
X-Share-Secret: <S base64url>                           — how the client sends it (never a query parameter)
```

| | |
|---|---|
| `POST /shares {file_id}` of a `tenant` file | the server unwraps FK under the key file, draws `S`, wraps, stores `fk_share_ct`, answers `201` with `url` ending in `#<S>` and `encrypted: true`; `503` without the key file |
| … of a `keyring` file | the same under the owner's `X-Vola-Unlock` (`423` without — the share is made by the principal who can open the file); the **recipient** needs no token, no PIN: the grant is theirs |
| … of a `caller` file | `409 encrypted_share_requires_grant`, unless the caller sends `fk_share_ct` it made itself (AAD `<file id>:key:share:caller`, § 9); then no fragment in `url` — the caller appends its own |
| … of a `client` file | `409` always |
| `GET /s/<token>` of a grant | password (`X-Share-Password`), expiry and revocation first, exactly as 5.1; then **`401 share_secret_required`** without `X-Share-Secret`, **`409 vola_integrity`** for one that does not open the grant (or is not 43 base64url characters); then `max_downloads` is consumed — a wrong secret is not a download — and the file is decrypted segment by segment: `Range` in plaintext coordinates, `Cache-Control: no-store`, `Content-Disposition` with the real name |
| `DELETE /shares/:id` | `revoked_at` **and `fk_share_ct = NULL`**: the crypto-shred of the grant. Whoever kept the link and its secret has nothing left to open; the owner's own `fk_ct` is untouched, the file reads on |
| `GET /shares`, `GET /shares/:id` | `encrypted: true` marks a grant; the secret is in no listing, no row, no log (`*.headers["x-share-secret"]` is redacted) |
| folder shares | unchanged: an encrypted file inside a shared folder is **not listed** and `404` by path — there is no grant per file in a folder |
| the AAD | `<share id>:key`: the share id is drawn before the insert, so a grant cannot be moved to another share row; a caller-made grant is bound to the file id instead (the caller cannot know the share id) and so could be copied between two grants of the SAME file — both open the same bytes, nothing is gained |

What a dump reveals: `vola_share_link` holds `fk_share_ct` as ciphertext under 256 bits the
server never had. A copy of the database, the disk and every key file opens no share grant. The
window that exists: a link **with** its fragment, in a mail or a chat — the thing the share was
made to send.

## 13. `client` mode — a blob the client made (phase 6.3)

The door the Notes analysis asked to leave open — end-to-end encryption in the client:
`encryption = client` on
`POST /uploads` stores a `JSV` blob the **client** produced and a wrapped key the client made,
and serves both back as they came. Nothing in the format depends on a server secret — only on
the file id, which the client learns from the creation (`Vola-File-Id`).

```
POST /uploads   Upload-Length: <blob length>   Upload-Metadata: …, encryption client, fk_ct <base64>, meta_ct <base64>?
                → 201, Vola-File-Id: <the id to put into every AAD>
PATCH …         the JSV blob (header with the real length or deferred; S between 64 KiB and 64 MiB)
GET …/:fileId   the blob, byte for byte: application/octet-stream, X-Vola-Encryption: client,
                Content-Length and Range in CIPHERTEXT bytes, ETag "<blob hash>", no-store,
                Content-Disposition: attachment; filename="<file id>.jsv"
```

- `fk_ct` (28–256 bytes) is **whatever the client's own key management produced** — the server
  never opens it; `meta_ct` (optional, ≤ 256 KiB) likewise: the row shows `<id>.bin` /
  `application/octet-stream` and `info`, lists and UDC rows stay masked for everyone;
- at completion the server checks what it can without a key: the header parses (magic, version
  1, a legal segment size) and the lengths add up — a header that promises more plaintext than
  the segments hold is `422 client_blob_invalid`. A tag it cannot verify: a blob that is
  well-formed but does not decrypt is the client's problem, as a lost `caller` key is;
- `size` is the plaintext length derived from the blob's arithmetic (quotas count what the
  user stored), `hash` the blob's SHA-256, `enc_format` the header's version;
- no thumbnail (`404`), no OCR, no share (`409`), no rename (`409 client_opaque`), no transfer
  (`409`), no `is_global_public` (`409`); `client` is not a tenant default (it needs a key per
  upload) and not accepted on a multipart upload (`422`: it goes through `/uploads`);
- a folder with a keyring policy refuses a `client` upload (`422`): the policy cannot be applied
  to bytes the server cannot open.

The client side (`@vola/client`) does not seal blobs yet: the server half is what this phase
ships, and `test/encryption3.test.ts` produces the blob with the server's own `encryptBuffer`
(the format is the same code). A follow-up for the client library: `createEncryptStream` in
WebCrypto (`AES-GCM`, 12-byte nonce `prefix ∥ index`, the AAD of § 2) and a `uploadEncrypted()`
that creates the upload, reads `Vola-File-Id`, seals and PATCHes — about 150 lines, no new
dependency; the wrapped key stays the host's concern.


## 14. The client side, and where vola differs from Notes

What a client of the `keyring` mode has to do — the rules thilo's Notes UI follows, implemented
in `@vola/react` (`VolaProvider`, `VolaPinGate`, `VolaThumb`; [REACT.md](REACT.md)) and available
to any other client through `@vola/client`:

- **Hold the token in memory only** — never `localStorage`, a cookie or a URL. `@vola/client`
  keeps it in the instance; `lock()` sends `DELETE /keyrings/me/unlock` and forgets it.
- **Lock early, on the client**: after 120 s without activity show a 10 s countdown with "stay
  unlocked", then lock; a tab hidden for more than 30 s locks when it comes back; a tab that
  slept locks at once; `pagehide` sends `navigator.sendBeacon` to `POST /keyrings/me/unlock/close`
  with the token (the one route that needs no API key). The server's `VOLA_UNLOCK_TTL_S`
  (150 s, sliding) is the backstop, not the rule.
- **A lock drops every decrypted artefact**: every `blob:` URL of a decrypted file or thumbnail
  is revoked, the in-memory cache is cleared, and a new "generation" starts so an answer that
  arrives for the previous one is thrown away.
- **`423 vola_locked` means ask for the PIN again**, whatever the request was; `403 pin_wrong`
  shows the attempts left before the wait; `429 too_many_attempts` disables the fields and counts
  down `retry_after` — the right PIN is refused too until then.
- **The recovery key is shown once**, at setup and after a recovery, behind a "I have saved it"
  checkbox; it is never shown again and never sent anywhere but `POST …/recover`.
- **Reset asks for the word `RESET`** and shows the counts from `GET …/delete-preview` first;
  re-authenticating the person is the host application's job before it calls vola.
- **A share of an encrypted file says what it does**: the recipient gets plaintext, the link
  (with its `#secret`) is shown once, and the secret never goes to any server but as
  `X-Share-Secret` to vola's `/s/:token`.
- **Never cache a thumbnail of an encrypted file** past the lock (`no-store` says so), and never
  by content hash (there is none a client can see).

Where vola **differs from the Notes service as it runs today** (the historical document
describes that original):

| Notes | vola | why |
|---|---|---|
| one AES-GCM message per file; the whole blob decrypted to serve it | the `JSV` segmented format, 1 MiB segments with the index and "last" in the AAD (§ 2) | `Range` / `206`, resumable uploads sealed as they arrive, one segment of memory per request |
| one mode: a PIN per user | four modes over one format and one `WrapProvider` interface (§ 3) | hosts without a per-user secret (`tenant`), server-to-server (`caller`), end-to-end (`client`) |
| one secret file (`notes.key`) that is both the pepper and the Fernet key wrapping the master key in Redis | two files — the key file (tenant KEKs and the Redis unlock entries, HKDF per tenant, § 1, § 8.2) and the pepper file (§ 8) — with `kid` hints and lazy re-wrap on read (§ 4, § 8.8) | multi-tenant; the operator's key and the users' pepper rotate independently |
| reset takes the account password | reset takes `{confirm: "RESET"}`; the host re-authenticates (§ 8.5) | vola has principals, not users or passwords |
| header `X-Notes-Unlock` | `X-Vola-Unlock`; the beacon alias and the sliding TTL kept | |
| the blob version is written, not read | the version is read and dispatched; an unknown one is an integrity error before any AES runs | a format change later is a new version, not a flag day |
| no derivatives of encrypted files | sealed sibling thumbnails for every mode but `client`; sealed OCR for `tenant` files (§ 11) | the file browser shows encrypted images; the operator's files stay searchable through `info` |
| no share link for an encrypted file | the share grant with the secret in the URL fragment (§ 12) | |
| everything a person has is under their keyring; nothing plain next to it | plain, `tenant` and `keyring` files coexist in one instance; a folder **policy** names the keyring new uploads go under (§ 8.6) | a host's folder tree mixes private and shared material; moving a file never re-encrypts it |

Everything else — the PIN rules, the recovery key format and its normalisation, the brute-force
table and the mutex, the unlock token in Redis with a sliding TTL, the beacon, the crypto-shred,
`application/octet-stream` and `<id>.bin` in the row, `no-store` and `nosniff`, `inline` only for
a sniffed raster image, no `is_global_public`, nothing secret in a log, a URL or an audit event —
is the Notes model unchanged.

## 15. Operations checklist

1. **Before the first encrypted upload**: create the key file and, if keyrings will be used, the
   pepper file (`vola keys-generate`, `vola pepper-generate`, or one `openssl rand -base64 32`
   line each, mode 0600); mount them read-only in the server **and the worker**
   ([DEPLOYMENT.md](DEPLOYMENT.md#the-key-file-and-the-pepper-file)). Keyrings also need Redis.
2. **Back both files up apart from the data** — a backup that holds the database, the blobs and
   the key file together is readable by whoever holds it; the data backup without the key file
   is what the encryption is for. Test the restore: `vola keys-status` and `vola pepper-status`
   against the restored files show no `NO LINE`.
3. **Decide the default**: `vola tenant-set --slug <s> --default-encryption tenant` for a tenant
   whose uploads should all be encrypted without the clients knowing; `keyring` or `caller` only
   when every client of that tenant sends the token or the key.
4. **Rotate by prepending** a line (§ 4, § 8.8), never by replacing one; remove an old line only
   when `keys-status` / `pepper-status` show zero files or keyrings on it. Files move to the
   active line as they are read; a keyring at its next unlock.
5. **Watch the logs** for `key file unusable`, `integrity failure`, `encryption: tenant provider
   (no Redis: no keyring provider)` and the counters `vola_unlock_failed` / `vola_locked_out`; a
   burst of `503 encryption_unavailable` means a mount or a permission went wrong, a burst of
   `409 vola_integrity` means a restore mixed a database and a disk of different dates or a key
   line was removed.
6. **Size `VOLA_ENC_INLINE_DERIVE_MAX_BYTES`** (25 MiB) to the memory you can spend per request:
   a thumbnail or OCR pass of an encrypted file decrypts the whole plaintext into memory.
7. **Transfers** between tenants re-wrap `tenant` files and need the key file; an instance with
   `keyring`, `caller` or `client` files is refused — have the owner download and re-upload
   (§ 4).
8. **If Redis is lost**, every keyring is simply locked (the tokens are gone); unlock again.
   **If the pepper file is lost**, no keyring can be unlocked or recovered. **If the key file is
   lost**, every `tenant` file and every keyring unlock is gone for good — purge the rows to
   reclaim the disk (`DELETE …/purge`), there is nothing else to do. That is the design, and the
   reason for step 2.
9. **Never log or forward** `X-Vola-Unlock`, `X-Vola-Content-Key`, `X-Share-Secret` or
   `X-Share-Password` at a proxy; the server redacts them itself (`LOG_REDACT`).
