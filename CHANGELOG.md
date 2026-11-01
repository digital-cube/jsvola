# Changelog

All notable changes to JSVola. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@vola/*` package and the Docker image
share one version.

## [Unreleased]

### Added

- Encryption at rest, part III (plan 6.3, `docs/CRYPTO.md` § 9–13).
  - The **`caller` provider**: the file key is wrapped under a 32-byte key the caller sends in
    `X-Vola-Content-Key` on the upload and on every read (AAD `<file id>:key:caller:<tenant id>`,
    `fk_ct` 60 B); the server keeps nothing but the wrapped key, logs nothing of it (`LOG_REDACT`
    covers every place a library dumps request headers) and zeroes it when the response is out.
    Needs the new scope **`encryption:caller`** (`403` otherwise); a request with an `Origin`
    header is `400 caller_key_from_browser`; without the key `423 vola_locked`, with a wrong one
    `409 vola_integrity`; `info` / lists / UDC show the real name only with the key. Share and
    transfer are `409` (a caller may hand over its own `fk_share_ct`). `vola tenant-set
    --default-encryption caller` is allowed.
  - The **resumable upload is sealed segment by segment** as the bytes arrive, for `tenant`,
    `keyring` and `caller` (`services/upload-crypto.ts`): the part file is the `JSV` blob from
    byte 0, the incomplete last segment is kept sealed in `<id>.partial` under a nonce that is
    never reused (its own prefix and a write counter in `enc_state`), the blob hash runs along in
    an exportable SHA-256 midstate (`crypto/sha256.ts`), the sniffing head is sealed too; `HEAD`
    reports the plaintext offset, an interrupted PATCH resumes from the exact byte, nothing is
    read twice at completion. Every PATCH unwraps the key under the request's material
    (`X-Vola-Unlock` / `X-Vola-Content-Key` on each one). `Vola-File-Id` is on the `201` of an
    encrypted upload already (the id is in every AAD). A keyring policy that appears after an
    encrypted upload was created is `422` at completion.
  - **`client` mode** (`POST /uploads` with `encryption client` + `fk_ct` [+ `meta_ct`]
    pairs): the client seals the `JSV` blob itself against the `Vola-File-Id` of the creation,
    the server checks the structure (`422 client_blob_invalid`), stores key and blob opaque and
    serves the ciphertext back as is (`application/octet-stream`, `X-Vola-Encryption: client`,
    `Range` in ciphertext bytes). No thumbnail, OCR, share, rename (`409 client_opaque`) or
    transfer; never a tenant default; `422` on multipart. `EncryptionModes` gains `CLIENT`.
  - **Encrypted derivatives**: thumbnails and OCR of encrypted files are sealed siblings under
    the file key — `<blob>.enc-<file id>-thumb-<size>-<crop>` (AAD `<file id>:thumb:<size>:
    <crop>`) and `vola_file_metadata.ocr_ct` (AAD `<file id>:ocr`; `ocr_text` stays NULL, so an
    encrypted file is **not** in the full-text search). The worker renders and OCRs `tenant`
    files (it reads `VOLA_KEY_FILE`; `ProcessingWorkerOptions.crypto`), decrypting into memory
    and feeding `pdftoppm` / `tesseract` through stdin and stdout — nothing of the plaintext
    touches the disk; `keyring` and `caller` files render **inline in the request that holds the
    key** (never `202`), and get no OCR in v1.0 (documented why). `/thumb` of an encrypted file
    needs the key (`423` without), answers `Cache-Control: no-store` with an `ETag` of the file
    id, and is `404 no_thumbnail` above the new **`VOLA_ENC_INLINE_DERIVE_MAX_BYTES`** (default
    25 MiB). Purge and the crypto-shred remove the siblings.
  - The **share grant**: `POST /shares` of a `tenant` or `keyring` file (the latter under the
    owner's `X-Vola-Unlock`) wraps the file key under a 32-byte secret `S` (AAD `<share id>:key`,
    `fk_share_ct`) and answers `url = …/s/<token>#<S>`; `S` is never stored. The public download
    takes `X-Share-Secret` (`401 share_secret_required` without, `409 vola_integrity` wrong,
    then the decrypted stream with `Range` and `no-store`; password, expiry and `max_downloads`
    as before — a wrong secret is not a download). Revoking drops `fk_share_ct`. `ShareInfo`
    gains `encrypted`; `ShareCreate` takes `fk_share_ct` for a `caller` file.
  - `X-Vola-Encryption: <mode>` on every download of an encrypted file; `LOG_REDACT` exported
    from `@vola/server` for hosts that embed the plugin under their own logger.
  - Migration `0009_encryption_iii`: `vola_file_metadata.ocr_ct`, `client` in the
    `vola_file.encryption` CHECK.

### Changed

- `409 encrypted_share_requires_grant` now only for `caller` (without `fk_share_ct`) and
  `client` files; `/thumb` no longer answers `404` for encrypted files the request can open;
  `isOcrEligible` and `thumbnailable` are true for `tenant` files; `TENANT_DEFAULT_ENCRYPTIONS`
  includes `caller`; `TenantContext` gained `contentKey` and `browserOrigin`; `parseMode` takes
  `{client}`; `EncryptedStage.fk` is nullable (`client`).

- Encryption at rest, part II — the **`keyring` provider** (plan 6.2, `docs/CRYPTO.md` § 8;
  the thilo Notes model taken as it is). A keyring belongs to one principal (`X-User-Id`) of one
  tenant (`vola_keyring`, migration `0008_keyrings`; unique per live `(tenant_id, principal)`)
  and holds a 32-byte master key twice wrapped: under Argon2id(PIN, 16 B salt, pepper as the
  Argon2 `secret`; 64 MiB / t = 3 / p = 1, the parameters stored PER KEYRING in `kdf` so a raise
  needs no migration) and under a 160-bit base32 recovery key (8 × 4, shown once, typed input
  normalised: case, separators, `0 → O`, `1 → I`); AAD `<keyring id>:mk:pin` / `:mk:recovery`.
  The file key of a `keyring` file is wrapped under the master key (`fk_ct` 60 B, AAD
  `<file id>:key:keyring:<keyring id>`, `vola_file.keyring_id`). The pepper comes from
  `VOLA_PEPPER_FILE` (default `/run/secrets/vola.pepper`; key-file format, the first line
  active, rotate by prepending — a keyring moves to the active line at its next unlock;
  `vola pepper-generate`, `vola pepper-status`). Routes under `/keyrings` (scope
  `keyrings:write`, `400 user_required` without `X-User-Id`): `GET me/status` (does not extend
  the token), `POST me {pin}` → `201 {keyring_id, recovery_key}` (`409 keyring_exists`,
  `422 pin_invalid {reason: length | digits | trivial}` — six digits, no all-the-same, no run),
  `PUT me/pin` (re-wraps the master key only — `fk_ct` and blobs untouched — and drops every
  token), `POST me/recover {recovery_key, new_pin}` → a NEW recovery key (a wrong one is `403
  recovery_wrong` and never counts as a PIN attempt), `POST me/unlock {pin}` → `{token,
  expires_in}`, `DELETE me/unlock` and the API-key-less beacon alias `POST me/unlock/close
  {token}` (JSON or `text/plain`), `POST me/reset {confirm: "RESET"}` (the crypto-shred: every
  file under the keyring — versions, soft-deleted rows — storage first, then the rows, then
  the keyring, then every token; `500 blob_not_removed` keeps the rows of what failed),
  `GET me/delete-preview`; an admin key may read the status of and reset another principal
  (`/keyrings/by-principal/:principal/…`), never unlock. Unlock tokens (`services/unlock.ts`):
  32 random bytes base64url in Redis (`vola:unlock:<token>` → `{tenant_id, principal,
  keyring_id, mk}` with the master key wrapped under the active `VOLA_KEY_FILE` line, HKDF salt
  `vola-unlock-kek`, bound to the token; an index set per principal for `dropAll`), a sliding
  TTL `VOLA_UNLOCK_TTL_S` (default 150 s) refreshed by every request that carries
  `X-Vola-Unlock` — never a URL —, and one `423 vola_locked` for every missing, expired,
  foreign or wrong token. Brute force: the counter and `locked_until` in the keyring row
  (survive a restart), a per-principal mutex (`SET NX EX 15`; a second check in flight is
  `429` with `retry_after: 1`), the Notes table (1–2 free, 3 → 1 s, 4 → 5 s, 5–9 → 30 s,
  10 → 1 h, then doubling), `429 too_many_attempts` + `Retry-After` for the right PIN too
  while locked, `403 pin_wrong {attempts, retry_after}`, the right PIN clears the counter.
  Files: `encryption=keyring` on an upload (multipart, slug, tus) needs the owner's token
  (`423` before a byte is read); download, `info` and `PATCH {filename}` of a keyring file
  without it are `423`; REST lists, UDC rows and subscriptions keep the `<encrypted>` mask
  (a subscription reveals under the token of ITS OWN upgrade, never the uploader's — `decide`
  now runs under the subscription's context); another principal's token behaves as none; a
  `keyring` file can still not be shared, made globally public or thumbnailed, and an
  instance holding one is refused by `POST /admin/transfer` with
  `409 encrypted_transfer_unsupported` — by design, a keyring is one person's of one tenant.
  **Encrypted folders** are a policy: `PATCH /folders/… {default_keyring: "me" | null}` sets
  `default_keyring_id`, and every new upload into the folder or below it is a keyring file
  under that keyring (the uploader needs that keyring's token; an explicit other mode is `422`;
  the folder must be named before the `file` part like the `encryption` field; versions inherit
  through their parent; a tus upload reads the policy at creation and completion); moving a
  file never touches its crypto. `vola tenant-set --default-encryption keyring` is allowed.
  Audit events `VOLA_KEYRING_CREATED`, `_PIN_CHANGED`, `_RECOVERED`, `_RESET`, `_LOCKED_OUT`
  (`instance_type: vola_keyring`, ids and counts only); logs `vola_unlock_failed`,
  `vola_locked_out`, `vola_recovery_failed` with ids and counters; never a PIN, a recovery
  key, a token (a 16-hex fingerprint at most), a master key or a name. Without Redis, the
  pepper file or the key file the provider is `503 encryption_unavailable` (the start-up log
  says `no Redis: no keyring provider`); plain and `tenant` files are unaffected. `@vola/core`:
  `UNLOCK_HEADER`, `DEFAULT_UNLOCK_TTL_S`, `PIN_LENGTH`, the `*_CODE` constants, the keyring
  schemas, `FolderPatchSchema.default_keyring`; `@vola/server`: `src/crypto/keyring.ts`,
  `services/keyrings.ts`, `services/unlock.ts`, `routes/keyrings.ts`, `KeyringWrapProvider`,
  `LockedError`, `EncryptionService.assertUploadable` / `currentUnlock` / `unlocks`,
  `wrapNewKey` → `{fkCt, keyringId}`, `resolveMode(tenant, explicit, policyKeyringId)`,
  `effectiveKeyringId(OfPath)`, `setFolderKeyring`, `keyringPepperUsage`,
  `TenantContext.unlockToken`, `VolaPluginOptions.unlocks` / `keyrings`, `Config.pepperFile` /
  `unlockTtlS`; `@vola/cli`: `pepper-generate`, `pepper-status`. Tests:
  `test/keyring-crypto.test.ts` (unit), `test/keyrings.test.ts` (a real Redis, a fake clock for
  the lock-out table, a dump test that re-derives MK and FK and searches every column, the
  blob and Redis for them).

- Encryption at rest, part I (plan 6.1, `docs/CRYPTO.md`). A new crypto core
  (`@vola/server` `src/crypto/`, pure `node:crypto` AES-256-GCM, no I/O): the segmented blob
  format **`JSV` v1** — a 24-byte header (`"JSV"`, version, `segment_size` u32 — default 1 MiB,
  64 KiB … 64 MiB —, 8-byte random `nonce_prefix`, `plaintext_length` u64 or the "deferred"
  marker) and segments `ct ∥ tag` with nonce `prefix ∥ i` and AAD `header ∥ file_id ∥ i ∥ last`
  (∥ length on the last) — so truncation, an added or reordered segment, a changed header, an
  unknown version and a blob transplanted onto another file id all fail (`IntegrityError`), a
  `Range` decrypts only the segments it touches, and memory is one segment per request. The
  plaintext length of a streamed upload is derived from the ciphertext length and
  authenticated by the last segment's AAD (the header carries it when it was known, e.g. a
  resumable upload). `createEncryptStream`, `createDecryptStream` (reads the header and the
  needed span through a `CiphertextSource`, verifies the first segment before handing out the
  stream, dispatches on the version), `ciphertextRangeFor`, `sealMeta` / `openMeta`
  (`{filename, mime, metadata, sniffed}` under the file key, AAD `<file id>:meta`), the
  `WrapProvider` interface (`wrap` / `unwrap` with lazy `rewrapped`, AAD
  `<file id>:key:<mode>:<tenant id | keyring id>`) and the **`tenant` provider**:
  `VOLA_KEY_FILE` (default `/run/secrets/vola.key`; base64 32-byte lines, the first active),
  KEK = HKDF-SHA256(line, salt `vola-tenant-kek`, info = tenant id), `fk_ct` = `kid(4) ∥
  nonce ∥ ct ∥ tag` (64 B), unwrap tries the hinted line then every line and re-wraps under
  the active one (lazy rotation: prepend a line, old ones retire as files are read). A missing
  key file never stops the server: `503 encryption_unavailable` on encrypted uploads, downloads
  and `info` until it is there (re-read on change). `409 vola_integrity` with the one fixed
  sentence "The file could not be decrypted." for every integrity failure. Uploads
  (`POST /files`, `PUT …/slug/:slug`, the tus completion) take `encryption=tenant` from the
  `encryption` form field (before the `file` part), `X-Vola-Encryption`, the `encryption`
  `Upload-Metadata` pair, or the tenant's new `default_encryption` (migration
  `0007_encryption`, `vola tenant-set --slug <s> --default-encryption none|tenant`); the stream
  is plaintext → MIME sniff → encrypt → CAS, the row stores `<id>.bin` /
  `application/octet-stream` / `other` / `{}`, `encryption`, `enc_format = 1`, `fk_ct`, `meta_ct`,
  `size` = plaintext length and `hash` = hash of the CIPHERTEXT (no plaintext hash anywhere, no
  deduplication of encrypted files, no collision rename), the upload limit is measured on the
  plaintext, and the plaintext part file of a resumable upload is removed once the ciphertext
  is committed. Downloads of an encrypted file decrypt the requested range (`206` in plaintext
  coordinates), `ETag: "<file id>"`, `Cache-Control: no-store`, `X-Content-Type-Options:
  nosniff`, `inline` only for a PNG/JPEG/GIF/WebP the bytes identified, otherwise `attachment;
  filename*=` with the decrypted name. `…/info`, `GET /files/:type/:id`, `…/versions`, UDC
  `files` rows (list, read, subscribe) show the real name, type, extension, kind and metadata
  when the server holds the key (filters, sorts and cursors keep the `<encrypted>` mask); the
  plugin's `decorateRow` runs after. `PATCH {filename}` re-seals the metadata of an encrypted
  file. `POST /admin/transfer` and `vola transfer` re-wrap the key of every `tenant` file for the
  destination tenant inside the transaction (`503` without the key file, `409` for a key that
  does not open) and refuse only `keyring` / `caller` files with `409
  encrypted_transfer_unsupported`. The worker still skips encrypted files; `is_global_public`
  stays `409 encrypted_not_public`; logs and audit payloads never carry the name or type of an
  encrypted file. CLI: `vola keys-generate [--path]` (0600, refuses to overwrite),
  `vola keys-status [--path]` (files per key line, `NO LINE` warning for keys that are gone,
  never a key), `vola tenant-set`. `@vola/core`: `UPLOAD_ENCRYPTION_FIELD`,
  `ENCRYPTION_HEADER`, `INTEGRITY_ERROR_CODE` / `_MESSAGE`, `ENCRYPTION_UNAVAILABLE_CODE`,
  `ENCRYPTED_STORED_MIME`, `UPLOAD_META_KEYS.encryption`, `Tenant.default_encryption`;
  `@vola/server`: everything of `src/crypto/`, `EncryptionService` / `createEncryptionService` /
  `tenantKeyUsage` (`services/encryption.ts`), `VolaPluginOptions.encryption`, `Config.keyFile`,
  `FilesDeps.crypto`, `describeFile(s)`, `revealFile`, `StageOptions`, `EncryptedStage`,
  `sendEncryptedFile`, `ENCRYPTED_INLINE_MIMES`, `detectMimeDetailed`,
  `setTenantDefaultEncryption`. New document `docs/CRYPTO.md`. Phase 6.2 (`keyring`, above)
  and 6.3 (`caller`, encrypted thumbnails/OCR, share grant, segment-wise resumable) plug into
  the same format and interface; `caller` answers `501` today.

- Admin transfer and the memento audit trail (plan 5.2). `POST /admin/transfer` (scope
  `admin`, i.e. an admin key; `X-Tenant-Slug` ignored; `{from_tenant, to_tenant, instances:
  [{instance_type, instance_id}], user_map?, dry_run?}`) moves every row of the listed
  instances from one tenant to another in ONE transaction — `vola_file` (every version, the
  soft-deleted ones too), `vola_folder` (a path that already exists on the destination is
  merged into that folder: files, subfolders, share links and uploads re-pointed, the source
  row removed; a live source folder revives a deleted destination one), `vola_share_link`
  (tokens unchanged), `vola_processing_job`, `vola_file_metadata`, finished or expired
  `vola_upload` rows — then recomputes the statistics of both tenants (the source's instance
  snapshots dropped, the destination's computed) and publishes `purged` on the source
  tenant's event channel and `created` on the destination's. `user_map` rewrites
  `created_by` / `deleted_by` / `last_accessed_by` (files), `created_by` / `deleted_by`
  (folders) and `created_by` (shares) in one `CASE` per column. Answers the counts
  (`files`, `folders`, `merged_folders`, `shares`, `jobs`, `metadata`, `uploads`,
  `instances`, `dry_run`); idempotent (a repeat reports zeros); `dry_run` runs the same
  statements and rolls them back. Refusals before anything is written: `404 tenant_not_found`
  (the destination must exist — vola-spp created it; this port does not), `409
  encrypted_transfer_unsupported` for an instance holding an `encryption != none` file (the
  TODO for phase 6.1 TCKK5UTHJX, the `tenant` re-wrap, is in `services/transfer.ts`), `409
  uploads_in_progress` for a resumable upload still running (it is refused rather than moved:
  the client resuming it holds a source-tenant key). CLI `vola transfer --from <slug> --to
  <slug> --instance type:id [--instance …] [--user-map file.json] [--dry-run]` (announces
  the move through Redis when `VOLA_REDIS_URL` is set). Audit (decision 13): with
  `VOLA_MEMENTO_URL` + `VOLA_MEMENTO_API_KEY` (new, both or neither) the operations
  `VOLA_FILE_DELETED` (soft delete, every file of a recursive folder delete),
  `VOLA_FILE_PURGED`, `VOLA_FILE_VISIBILITY_CHANGED`, `VOLA_SHARE_CREATED`,
  `VOLA_SHARE_REVOKED`, `VOLA_KEY_CREATED`, `VOLA_KEY_REVOKED` (API and CLI) and
  `VOLA_INSTANCES_TRANSFERRED` are pushed to `<url>/events` as memento events
  (`instance_type` `vola_file` / `vola_share` / `vola_key` / `vola_tenant`, `actor_id` =
  `X-User-Id` or `key:<prefix…last4>`, `cli:<user>` from the CLI; payloads of ids, size,
  MIME, kind and tenant slug — never a token, password, key, nor the `filename` of an
  encrypted file). Delivery: an `audit` BullMQ job (5 tries, exponential backoff; a `4xx`
  other than 408/429 is dropped at once) the worker pushes when Redis is configured, one
  direct fire-and-forget push with a 2 s timeout otherwise; a request never waits for memento
  and never fails because of it; without the variables one INFO line and nothing else. The
  worker takes the same two variables. `TenantContext` gains `apiKeyLabel`
  (`vola_live…k3Qz`). `@vola/core`: `TransferRequestSchema`, `TransferResultSchema`,
  `TransferInstanceSchema`, `TRANSFER_MAX_INSTANCES`; `@vola/server`: `services/transfer.ts`
  (`transferInstances`, `mapUsers`, `distinctInstances`), `adminRoutes`, `audit/memento.ts`
  (`AuditSink`, `MementoSink`, `NoopSink`, `AuditDeliveryError`, `fileAuditPayload`),
  `audit/log.ts` (`AuditLog`, `actorOf`, `createAuditSink`, `disabledAuditLog`),
  `AUDIT_JOB`, `AUDIT_MAX_ATTEMPTS`, `ProcessingQueue.enqueueAudit`,
  `ProcessingWorkerOptions.audit`, `VolaPluginOptions.audit`, `keyAuditPayload`,
  `shareAuditPayload`; `@vola/cli`: `transfer`, `readUserMap`, `transferLines`,
  `CliOptions.audit` / `actor` / `redisUrl`. New document `docs/AUDIT.md` (events, payloads,
  the memento-side vocabulary and template lines).
- Share links and statistics (plan 5.1). New table `vola_share_link` (migration
  `0006_shares_stats`: `tenant_id`, `file_id` XOR `folder_id` (CHECK), `token_hash` — the
  SHA-256 of a 32-byte base64url token, unique — `scope` (`ShareScopes`, v1 `PUBLIC_LINK`
  only), `password_hash` (argon2id, 19 MiB / t=2 / p=1), `expires_at`, `max_downloads`,
  `download_count`, `created_by`, `created_at`, `revoked_at`, and `fk_share_ct` bytea
  reserved for the share grant of phase 6.3). `POST /shares` (`shares:write`;
  `{file_id | folder: {instance_type, instance_id, path}, password?, expires_at?,
  max_downloads?, scope?}`) answers `201` with the token (this once) and the public `url`
  (built on `VOLA_PUBLIC_URL`, new, optional, or the request's origin); a scope other than
  `PUBLIC_LINK` is `501 not_implemented`, an encrypted file `409 encrypted_share_requires_grant`.
  `GET /shares[?file_id=|folder_id=][&include_revoked=1]`, `GET /shares/:id`,
  `DELETE /shares/:id` (revoke, idempotent). Anonymous `GET|HEAD /s/:token` (file: the
  download with `Range`/`ETag`/`Content-Disposition`; folder: a one-level JSON listing with
  paths relative to the shared folder) and `GET|HEAD /s/:token/path/*` (a file or subfolder
  inside a shared folder, never outside it). Password in `X-Share-Password` or `?password=`;
  missing or wrong → `401 share_password_required`, ten wrong ones per token in fifteen
  minutes → `429 too_many_password_attempts` (counter in Redis when configured, in memory
  otherwise); unknown token `404 share_not_found`; revoked or expired `410 share_gone`. Only
  a request that starts a download counts against `max_downloads` (`GET` without `Range` or
  from byte 0; atomic `UPDATE … WHERE download_count < max_downloads RETURNING`); `HEAD` and
  `Range` continuations never count and still answer once the limit is reached, so the last
  granted download can be resumed; starting another is `410`. Share answers carry
  `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`; an encrypted file
  inside a shared folder is invisible. New table `vola_tenant_stats` (same migration): one
  snapshot per `(tenant, scope tenant|instance, instance_type, instance_id)` with
  `total_files`, `total_bytes`, `by_kind` jsonb, `oldest_at`, `newest_at`, `computed_at`.
  `GET /stats/tenant[?recompute=1]`, `GET /stats/instance/:type/:id[?recompute=1]`
  (`files:read`; computed lazily on the first read, soft-deleted files never counted) and
  `GET /stats/storage` (`files:read`; the tenant's live files, logical bytes, distinct blobs
  and their bytes; an admin key adds `physical` — `blobs`, `derived`, `uploads` on disk — and
  without `X-Tenant-Slug` measures the whole deployment). The worker gains the repeatable
  `refresh-stats` job (scheduled by the server every half `VOLA_STATS_TTL_MIN`, new, default
  60): snapshots older than the TTL whose tenant had file activity since are recomputed;
  without a worker a read past the TTL recomputes instead. `@vola/core`: `SHARE_SCOPES`,
  `ShareCreateSchema`, `ShareInfoSchema`, `ShareCreatedSchema`, `SharedFolderListingSchema`,
  `SHARE_PASSWORD_HEADER`, `TenantStatsSchema`, `StorageStatsSchema`, `RECOMPUTE_QUERY`;
  `@vola/server`: `services/shares.ts`, `services/share-password.ts`
  (`MemorySharePasswordLimiter`, `RedisSharePasswordLimiter`), `services/stats.ts`,
  `shareRoutes`, `sharePublicRoutes`, `statsRoutes`, `StorageBackend.usage()`,
  `ProcessingQueue.scheduleStatsRefresh`, `REFRESH_STATS_JOB`. New dependency: `argon2`.
- OCR (plan 4.2). After every upload of a raster image (not SVG, not GIF) or a PDF with
  `encryption = none` the server also queues one `OCR` job (`VOLA_OCR_ENABLED` = `auto` /
  `1` / `0`); the worker runs the system `tesseract` — `tesseract <file> stdout -l <langs>`
  for an image, `pdftoppm -r 200 -png` into a temporary directory and tesseract per page for a
  PDF (at most `VOLA_OCR_MAX_PAGES` = 20 pages, the texts joined with `\f`), the tools spawned
  with an argument list and no shell, `VOLA_OCR_TIMEOUT_S` (120) per page, stdout capped at
  10 MiB, the temporary directory always removed — with the languages of `VOLA_OCR_LANGS`
  (`eng+srp+deu`, from the `OcrLanguages` vocabulary; an unknown or uninstalled one is a clear
  error at start). In `auto` mode the worker probes `tesseract --version` at its start and
  skips the jobs (`SKIPPED`, one WARN line) when it is missing; with `1` it refuses to start.
  New table `vola_file_metadata` (migration `0005_file_metadata`: `file_id` PK → `vola_file`
  cascade, `tenant_id`, `ocr_text`, `ocr_lang`, `ocr_pages`, `ocr_at`, `ocr_tsv` — a stored
  `tsvector` generated from the text with the `simple` configuration, GIN-indexed).
  `GET …/:fileId/info` gains `ocr: {status, lang, pages, text_preview}` (the first 500
  characters; `?ocr=full` adds `text`). The UDC `files` collection gains `ocr`: yes/no in the
  row and the view's "OCR" column, and as a filter `contains <words>` is a full-text search
  (`plainto_tsquery('simple', …)` over `ocr_tsv`), `eq true|false` / `is_null` /
  `is_not_null` the flag; a live `subscribe` with such a filter is matched in SQL, so the row
  arrives when its text is in. The worker publishes a `processing` event after every OCR job.
  `@vola/core`: `OCR_LANGUAGES`, `parseOcrLangs`, `ocrSupported`, `isOcrEligible`,
  `OcrInfoSchema`, `FileDetailSchema`, `OCR_TEXT_PREVIEW_LENGTH`, `OCR_PAGE_SEPARATOR`;
  `@vola/server`: `services/ocr.ts` (`runCapped`, `probeTesseract`, `extractText`,
  `saveOcrResult`, `ocrInfoOf`), `OCR_JOB`, `JobDispatcher.requestOcr`,
  `ProcessingWorker.ocrAvailability()`. CI installs `tesseract-ocr` (eng, srp, deu).
- Background jobs and thumbnails (plan 4.1). `@vola/server` gains a second process, the
  **worker** (`node dist/worker.js`, `pnpm start:worker`, the `vola-worker` compose service on
  the same image), consuming the BullMQ queue `vola-processing` on `VOLA_REDIS_URL` with
  `VOLA_WORKER_CONCURRENCY` (2) jobs at once and a graceful SIGTERM; `VOLA_QUEUE_PREFIX` (`vola`)
  namespaces the Redis keys. `VOLA_WORKER_ENABLED` = `auto` (default: async when Redis is set) /
  `1` (insist; one ERROR line and synchronous work without Redis) / `0` (always synchronous —
  thumbnails render inline on `/thumb`, OCR will not run; one INFO line per process, never an
  error). New table `vola_processing_job` (migration `0004_processing_jobs`: `id`, `tenant_id`,
  `file_id`, `kind`, `params`, `status`, `attempts`, `error`, `created_at`, `started_at`,
  `finished_at`; `(file_id, kind, params)` unique) and `processing_status` on every file info,
  the UDC `files` row and `…/info`: the worst status of the file's jobs wins (`FAILED` >
  `RUNNING` > `PENDING` > `DONE`, `SKIPPED` ignored, `null` without jobs). After every upload
  (plain, slug, version, resumable) of a raster image (not SVG) or PDF with `encryption = none`,
  four `THUMBNAIL` jobs (64 / 128 / 256 / 512, crop `cover`) are queued; the worker renders them
  with `sharp` (`rotate()` for EXIF, `cover` = centre crop, `fit` = contain, `attention`, WebP
  quality 80; a PDF's first page through `pdftoppm -f 1 -l 1 -r 72 -png`), 30 s per job, 3 tries
  then `FAILED` with a short `error`, and stores each as the derived file
  `thumb-<size>-<crop>.webp` next to the blob (shared across tenants, purged with it); after
  every job a `processing` event goes out, so a live `files` list updates.
  `GET|HEAD /files/:type/:id/:fileId/thumb/:size?crop=` (`files:read`): `400 invalid_size` /
  `invalid_crop`; `200` + `X-Thumbnail-Status: ready` + `Cache-Control: private, max-age=86400`
  + `ETag`/`304` when the rendition exists; **`202`** + a grey WebP placeholder (~50 B) +
  `X-Thumbnail-Status: generating` + `Cache-Control: no-cache` when it does not and the worker
  is on (the job row is written or refreshed); inline rendering and `200` without a worker (or
  when the queue cannot be reached); `200` placeholder + `X-Thumbnail-Status: failed` for a file
  that cannot be rendered; `404 no_thumbnail` for an unsupported type or an encrypted file. The
  expired-upload sweep moved to a repeatable BullMQ job in async mode (the in-process timer
  stays for deployments without a worker). `@vola/core`: `PROCESSING_KINDS`,
  `PROCESSING_STATUSES`, `aggregateProcessingStatus`, `THUMBNAIL_SIZES`, `THUMBNAIL_CROPS`,
  `thumbnailDerivedName`, `thumbnailSupported`, `THUMBNAIL_STATUS_HEADER`. New dependencies:
  `bullmq`, `sharp`, `pino`. The E2E stack starts the built worker next to the built server.

- Real-time `subscribe` (plan 3.2): `GET /udc/subscribe` upgrades to a WebSocket
  (`bearer.<key>` subprotocol next to `vola.v1`, or the usual headers; `files:read`; refusals
  are plain `401`/`403`/`400` before the upgrade; the key is never read from the URL). A
  client sends `udc.subscribe {collection: "files", filter}` with a `list`-style filter
  (top-level `instance_type` required, `instance_id`, `folder_path`, `include_deleted` and
  the rest as in `list`; up to 32 per connection) and receives `udc.row.upsert` (the row as
  `list` answers it, read back under the tenant and the same masking / `decorateRow`) or
  `udc.row.remove` (an id) whenever a file of that instance is uploaded, replaced by slug,
  versioned, completed by a resumable upload, moved, renamed, made (in)visible, soft-deleted,
  purged, or moved by a folder rename / deleted with a folder. `FileEventBus`
  (`@vola/server`): every writer publishes `{tenantId, instanceType, instanceId, folderId,
  fileId, kind}` after its commit — Redis pub/sub on `vola:files:<tenant id>` with
  `VOLA_REDIS_URL` (several server and worker processes), in-process without;
  `publishProcessingStatus` is the hook for the plan-4.1 worker. Heartbeat
  (`VOLA_WS_HEARTBEAT_MS`), slow-consumer close `4008` (`VOLA_WS_MAX_BUFFERED`), `1001` on
  shutdown, `1011` when the feed is down. `volaPlugin` takes `events` and `subscribe`
  (`false` switches either off); `@fastify/websocket` is registered unless the host did.
  Wire schemas in `@vola/core` (`ClientMessageSchema`, `ServerMessageSchema`,
  `SUBSCRIBE_CLOSE_CODES`, `FILE_EVENT_KINDS`). The `files` collection now reports
  `capabilities.subscribe: true`. Docs: `docs/REALTIME.md`.

- Lookups, translations and the UDC `files` collection (plan 3.1). `@vola/lookups` is now the
  full copy of `@memento/lookups` (YAML compiler and registry, CSV translations with a
  validator, candidate recorder, codegen) plus `promoteCandidates`; `lookups.yaml`
  (`FileKinds`, `ProcessingStatuses`, `ProcessingKinds`, `ShareScopes`, `OcrLanguages`,
  `EncryptionModes` — no `InstanceTypes`) and `i18n/translations.csv` (en, sr) live at the
  repository root. `GET /lookups?locale=en|sr` (no key; fallback en) serves terms, wire values
  and labels; `GET /instance-types` (`files:read`) the tenant's instance types with live-file
  counts. An upload whose `kind` / `encryption` the vocabulary does not know is recorded under
  `var/candidates` (`VOLA_LOOKUPS_PATH`, `VOLA_TRANSLATIONS_PATH`, `VOLA_RECORD_CANDIDATES`,
  `VOLA_CANDIDATES_DIR`); `vola lookup-promote`, `vola lookups validate|candidates` manage
  the queue. `@jsudc/server` 0.2.1 is mounted under `/udc` behind the API-key auth
  (in-protocol refusals, `files:read` to read, admin with `X-Tenant-Slug`) with the read-only
  `files` collection (`udc/files/view.yaml`): required top-level `instance_type` filter
  (empty list without it), optional `instance_id`, `folder_path` (one level, `""` root),
  `filename` (ilike), `mime_type`, `extension`, `kind`, `size`, `created_at`,
  `include_deleted`; sort by `created_at` / `filename` / `size`; keyset cursor paging with
  `id` tiebreak and exact `total`; `download_url` / `thumb_url` in rows; an encrypted row is
  masked (`<encrypted>`, no MIME/extension) in rows, filters, sorts and cursors, with a
  `decorateRow` hook for phase 6. `menu.yaml` is served as the `menu` collection
  (`VOLA_MENU_PATH`). The Docker image ships the vocabulary and menu under `/app/config`.
- Resumable uploads (`vola_upload`, migration `0003_uploads`): `OPTIONS|POST /uploads`,
  `HEAD|PATCH|DELETE /uploads/:id` speaking tus 1.0 core + `creation`, `termination`,
  `expiration`, implemented natively in `@vola/server` (no `@tus/server`) so `tus-js-client`
  works unchanged — verified by an e2e test that uses it. `Upload-Metadata` carries
  `instance_type`, `instance_id`, `filename` (required), `folder_path`, `parent_id`, `slug`,
  `content_type`/`filetype`, `metadata`; `Upload-Length` is required (`Upload-Defer-Length` →
  `400`, over `VOLA_MAX_UPLOAD_BYTES` → `413`). Partial bytes go to
  `VOLA_STORAGE_PATH/uploads/<id>.part` as they stream, the offset is committed only after
  `fsync`, a parallel PATCH is `409 upload_locked` (`FOR UPDATE NOWAIT`), a wrong offset
  `409 upload_offset_mismatch`, a client cut mid-body keeps what arrived. Completion goes
  through the same `finalizeUpload` as `POST /files` (hash, dedup, MIME, rename, folder,
  version, slug); the last PATCH and every later HEAD carry `Vola-File-Id`. An upload belongs to
  the tenant, not the key. `VOLA_UPLOAD_TTL_HOURS` (24): expired uploads are swept by a periodic
  job in the server process. `@vola/core` gains the tus header names and the `Upload-Metadata`
  codec (`encodeTusMetadata` / `decodeTusMetadata`).
- Folders, versions and visibility (`vola_folder`, migration `0002_folders`): virtual folders
  inside an instance (`POST|GET|PATCH|DELETE /folders/:type/:id/*path` — chain auto-create,
  one-level listing, rename and move with every descendant path rewritten in one
  transaction, recursive soft delete, `409 folder_exists` / `folder_not_empty`), paths of
  1–255-character segments (no `/`, `\`, control characters, `.` or `..`; 32 levels), uploads
  with `folder_path` / `folder_id`, `GET|HEAD …/path/*`, `PATCH …/:fileId` (move, rename with
  `409 file_exists`, `is_public`, `is_global_public`), versions through `parent_id`
  (`GET …/:fileId/versions`, purge of the whole chain), `is_public` readable by any
  authenticated tenant, and the anonymous `GET|HEAD /public/:fileId` for `is_global_public`
  files (`Cache-Control: public, max-age=300`; never an encrypted file —
  `409 encrypted_not_public`). `vola_file.folder_id` and `parent_id` are foreign keys now.
- Files (`vola_file`, migration `0001_files`): content-addressable storage on disk
  (`StorageBackend` / `FilesystemBackend`: `blobs/aa/bb/cc/<sha256>`, streamed through
  `tmp/` with SHA-256 on the fly, fsync, atomic link, dedup, derived files next to the blob,
  path-traversal safe), `POST /files/:type/:id` (streaming multipart, `413 file_too_large`
  over `VOLA_MAX_UPLOAD_BYTES`, MIME from magic bytes → extension → declared type, `kind`,
  collision rename `a (1).pdf`), `PUT …/slug/:slug` (upsert), `GET|HEAD …/:fileId` and
  `…/slug/:slug` (`Range`/`206`/`416`, `ETag`/`304`, `Content-Disposition` with RFC 5987
  names, `nosniff`, `?download=1`, `last_accessed_*`), `GET …/:fileId/info`, cursor list,
  soft delete and purge (blob removed only when no row of any tenant references it). The
  encryption columns (`encryption`, `enc_format`, `keyring_id`, `fk_ct`, `meta_ct`) are
  declared now and stay `none`/NULL until phase 6.
- Tenants and API keys (`vola_tenant`, `vola_apikey`, migration `0000_tenant_apikey`):
  keys are `vola_live_…` / `vola_test_…` / `vola_admin_…` (32 base62 characters), only
  their SHA-256 is stored, the plaintext is shown once. Scopes `files:read`, `files:write`,
  `folders:read`, `folders:write`, `shares:write`, `keys:write`, `keyrings:write`, `admin`.
- `@vola/server`: API-key auth on every route (`Authorization: Bearer`, `X-Api-Key`, or the
  `bearer.<key>` WebSocket subprotocol), `TenantContext` on `request.vola` and through
  `requireTenant()` (AsyncLocalStorage), route `config.scope` / `config.auth = "none"` /
  `config.tenant = "optional"`, admin keys selecting a tenant with `X-Tenant-Slug`,
  `X-User-Id` as the principal, `last_used_at` written at most once a minute per key.
  `POST|GET /keys`, `DELETE /keys/:id` (scope `keys:write`).
- `@vola/cli`: `vola migrate`, `create-tenant`, `create-key`, `create-admin-key`,
  `list-keys`, `revoke-key` (`--json` for machine output).
- Monorepo scaffold (pnpm workspaces, Turborepo, Biome, Vitest, TypeScript 5.9, Node 24):
  `@vola/core`, `@vola/lookups`, `@vola/server`, `@vola/cli`, `@vola/client`, `@vola/react`
  and the private `@vola/e2e` suite.
- `@vola/server`: `volaPlugin` (Fastify 5) mounted under `VOLA_PREFIX` (default `/vola`),
  Zod-validated `VOLA_*` configuration, `GET /health/live` and `GET /health/ready`
  (PostgreSQL, and Redis when configured), `X-Request-ID` echo/generation, the
  `{ error: { code, message } }` error envelope, Drizzle migrations (`pnpm db:migrate`).
- `compose.yaml` (PostgreSQL 16 + Redis 7 for development, with the `vola_test` database),
  `docker-compose.yaml` (the `vola` image + PostgreSQL + Redis), multi-stage `Dockerfile`
  with libvips, poppler-utils and tesseract (eng, srp, deu), GitHub Actions CI.
