# Encryption in JSVola

How an encrypted file is stored, who holds which key, what a dump reveals and what to do when
something answers `409` or `503`. The model comes from the thilo Notes service
(`notes-crypto-for-vola.md` § 6, decided in `PLAN.md` § Šifrovanje); the one place this
document departs from Notes is the **segmented blob format** (§ 6.8 there), which is what makes
`Range` requests and constant memory possible. Phase 6.1 (TCKK5UTHJX) ships the format, the
per-file key and the `tenant` provider; `keyring` (PIN, phase 6.2) and `caller` (phase 6.3) plug
into the same format and the same `WrapProvider` interface.

Code: `packages/server/src/crypto/` (pure, no I/O, unit-tested in `test/crypto.test.ts`),
`packages/server/src/services/encryption.ts` (the row-level operations and the HTTP mapping),
`routes/send-file.ts` (download), `services/files.ts` (upload), `services/transfer.ts`
(re-wrap). Integration tests: `test/encryption.test.ts`.

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
| `tenant` | the tenant's KEK from `VOLA_KEY_FILE` | a dump of disk, database and backups taken without the key file | nothing | **this phase** |
| `keyring` | a principal's master key, itself behind a PIN (Argon2id + pepper) and a recovery key | the above plus a database operator; opened only during an unlock | `X-Vola-Unlock` | phase 6.2 |
| `caller` | a 32-byte key the caller sends on every request; nothing is kept | everything vola itself holds | `X-Vola-Content-Key` | phase 6.3 |

The `unwrap` result's `rewrapped` is how rotation retires old keys lazily (§ 4): the service
stores it on the row (`UPDATE … WHERE fk_ct = <old>`, so a concurrent re-wrap cannot clobber)
and the download goes on whether that write succeeded or not.

Choosing the mode: the `encryption` multipart field (sent **before** the `file` part — the mode
decides what is written to disk while the part streams; a field after the part is accepted only
when it agrees, `422` otherwise), the `X-Vola-Encryption` header, the `encryption` pair of
`Upload-Metadata` (tus), or the tenant's `default_encryption` (`vola tenant-set --slug acme
--default-encryption tenant`). `keyring` and `caller` answer `501 not_implemented` until their
phase; anything else `422`.

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
  the key file the whole transfer is `503`; a key that does not open is `409`; `keyring` /
  `caller` files are still `409 encrypted_transfer_unsupported`.
- Back the file up. Without it every `tenant`-encrypted file of every tenant is noise, with no
  recovery path — that is the point.

## 5. What a dump reveals

| Dump | Sees | Does not see |
|---|---|---|
| **Database** (`vola_file`) | the structure: tenant, instance, folder, slug, version chain, `size` (plaintext length), `created_at`, who uploaded, `encryption` / `enc_format`, that a file is encrypted, which key line wrapped it (`kid`); `fk_ct` and `meta_ct` as ciphertext | the name, the MIME type, the caller's metadata, FK, any key line; without `VOLA_KEY_FILE` nothing opens |
| **Disk** (`<storage>/blobs`) | `JSV` headers (segment size, nonce prefix, sometimes the plaintext length), ciphertext sizes (≈ plaintext + 16 B per segment), when blobs were written; no derived files — the worker never touches an encrypted file | contents, names, types; which tenant a blob belongs to (that is a database fact) |
| **Database + disk**, no key file | the above, joined | the same: `fk_ct` is under a KEK nobody can derive |
| **Database + disk + key file** | everything | — (this is the operator; the `keyring` provider of phase 6.2 is for the case where that is not enough) |
| **Redis** | nothing of this phase: no key, no token, only ids in file events and job payloads | — |
| **Logs, memento audit, UDC events** | file ids, sizes, `encryption`, `application/octet-stream` as the MIME of an encrypted file, counts | the real name or type of an encrypted file (`fileAuditPayload` leaves `filename` out; the server never logs a decrypted name), FK, `fk_ct`, key lines |

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

**`501 not_implemented`** — `keyring` or `caller` was asked for; they arrive with phases 6.2 / 6.3.
