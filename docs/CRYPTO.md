# Encryption in JSVola

How an encrypted file is stored, who holds which key, what a dump reveals and what to do when
something answers `409`, `423`, `429` or `503`. The model comes from the thilo Notes service
(`notes-crypto-for-vola.md` § 6, decided in `PLAN.md` § Šifrovanje); the one place this
document departs from Notes is the **segmented blob format** (§ 6.8 there), which is what makes
`Range` requests and constant memory possible. Phase 6.1 (TCKK5UTHJX) ships the format, the
per-file key and the `tenant` provider; phase 6.2 (TCKFT692JH) the `keyring` provider (§ 8: a
PIN per principal, unlock tokens, recovery, brute force, reset, encrypted folders); `caller`
(phase 6.3) plugs into the same format and the same `WrapProvider` interface.

Code: `packages/server/src/crypto/` (pure, no I/O, unit-tested in `test/crypto.test.ts` and
`test/keyring-crypto.test.ts`), `packages/server/src/services/encryption.ts` (the row-level
operations and the HTTP mapping), `services/keyrings.ts` and `services/unlock.ts` (the keyring
rows and the tokens), `routes/send-file.ts` (download), `services/files.ts` (upload),
`services/transfer.ts` (re-wrap). Integration tests: `test/encryption.test.ts`,
`test/keyrings.test.ts` (a real Redis).

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
| `caller` | a 32-byte key the caller sends on every request; nothing is kept | everything vola itself holds | `X-Vola-Content-Key` | phase 6.3 |

The `unwrap` result's `rewrapped` is how rotation retires old keys lazily (§ 4): the service
stores it on the row (`UPDATE … WHERE fk_ct = <old>`, so a concurrent re-wrap cannot clobber)
and the download goes on whether that write succeeded or not.

Choosing the mode: a folder with an encryption policy (§ 8.6) decides first; then the
`encryption` multipart field (sent **before** the `file` part — the mode decides what is written
to disk while the part streams; a field after the part is accepted only when it agrees, `422`
otherwise), the `X-Vola-Encryption` header, the `encryption` pair of `Upload-Metadata` (tus), or
the tenant's `default_encryption` (`vola tenant-set --slug acme --default-encryption
none|tenant|keyring`). `caller` answers `501 not_implemented` until phase 6.3; anything else
`422`.

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
(a wrong `size` makes the download `409`), as in Notes. What is **not** covered yet: a resumable
upload keeps its plaintext part file on disk until it completes (phase 6.3 encrypts segment by
segment as the bytes arrive); thumbnails and OCR of encrypted files do not exist (6.3 makes them
encrypted siblings under the same FK); a share link of an encrypted file (6.3's share grant). The
model protects dumps and backups, not a live server that is compromised while it holds the key.

## 6. HTTP behaviour

| | plain file | encrypted file |
|---|---|---|
| `ETag` | `"<sha256 of the bytes>"` | `"<file id>"` (the plaintext never changes; the blob hash is not a plaintext key) |
| `Cache-Control` | `private, no-cache` | `no-store` (also on `…/info`) |
| `Content-Disposition` | `inline` for images, video, audio, PDF | `inline` ONLY for a PNG / JPEG / GIF / WebP the **bytes** identified; everything else `attachment; filename*=` with the decrypted name |
| `Range` | `206`, `Content-Range` in file bytes | the same, in **plaintext** coordinates; the blob is read in whole segments |
| `/public/:fileId`, `is_global_public` | — | never: `409 encrypted_not_public`, the public route answers `404` |
| `/thumb/:size` | `200` / `202` | `404 no_thumbnail` |
| share link | — | `409 encrypted_share_requires_grant` |
| UDC `files` row | real values | real `filename`, `mime_type`, `extension`, `kind` when the server holds the key; `<encrypted>` / null otherwise; filters, sorts and cursors always see the mask |
| `PATCH {filename}` | `409 file_exists` on a collision | the metadata record is re-sealed; no collision rule (the stored name stays `<id>.bin`) |
| a `keyring` file without the owner's `X-Vola-Unlock` | — | download, `info`, `PATCH {filename}`: `423 vola_locked`; lists, UDC rows and subscriptions: the mask (`<encrypted>`), never an error |

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

**`501 not_implemented`** — `caller` was asked for; it arrives with phase 6.3.

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

The Notes model (`notes-crypto-for-vola.md` § 1, § 3, § 6.5), taken as it is. A **keyring**
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
