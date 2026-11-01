# Notes kripto model — specifikacija za jsvola

Napisano 2026-11-01 na grani `thr1` (TCKMC6P9WP). Opisuje kripto model thilo Notes-a **onako kako je implementiran u kodu na toj grani** (Notes ne postoji na `main`-u), pa preporuke kako da jsvola (TypeScript port vola-spp) isti model uopšti u servis za šifrovane fajlove. Svaka tvrdnja o implementaciji nosi putanju fajla i funkciju; putanje su relativne u odnosu na koren thilo.ai repoa. Nijedna stvarna tajna (pepper, ključ, token) nije u ovom dokumentu, samo mehanizmi.

Izvori: tiketi TCKNMP3XUT (`notes-analysis.md`), TCKMHYMN37 (N1), TCKHYMT6FH (`notes-images-analysis.md`), TCK5HKCWWH (N4), TCKKDFRDP9 (N5, vola-spp PR #23), TCK7X3FYQW (N6), TCK9D6PPNQ (bilo koji fajl); kod `backend/services/svc_notes/src/thilo_notes/` (`crypto.py`, `keys.py`, `unlock.py`, `service.py`, `files.py`, `api/router.py`, `models/__init__.py`, `tenants.py`), `backend/common/src/thilo_common/clients/vola.py`, `frontend/src/notes/`, `mobile/src/lib/notes/`, `mobile/src/lib/auth/pin.ts`, `libs/vola/src/vola/` (thumbnail i MIME logika Vole); dokumenti `docs/developer/200-notes.md` (tiket kaže „200 ili 199“ — stvarni broj je **200**; `199-tasks.md` je drugi dokument, a komentari u kodu koji kažu „doc 199“ su zastareli), `32-vola.md`, `136-thilo-vault-privacy.md`, `37-auth.md` (§ Foundation, `at_rest_crypto.py`).

Terminologija: **Workspace** = `tenant` u kodu; vlasnik (owner) = jedina osoba koja ima Notes na jednom Workspace-u (`thilo_tenants_mvp/workspace_owner.py`, doc 200 § The owner).

## 1. Hijerarhija ključeva

Model je **envelope encryption u tri sloja**: sadržaj je pod nasumičnim ključem, nasumični ključ je umotan u drugi nasumični ključ, a tek taj je umotan ključem izvedenim iz PIN-a. PIN nikada ne šifruje sadržaj.

```
PIN ──Argon2id(salt, pepper)──► KEK_pin ──AES-GCM──► wrap(MK)   = keyring.mk_pin_ct
recovery key ──Argon2id(recovery_salt, pepper)──► KEK_rec ──AES-GCM──► wrap(MK) = keyring.mk_recovery_ct
MK (32 B random) ──AES-GCM──► title, body, folder name          (direktno pod MK)
MK ──AES-GCM──► wrap(FK)  = notes_files.fk_ct;  MK ──AES-GCM──► file name, file MIME
FK (32 B random, po fajlu) ──AES-GCM──► blob na Voli (nonce || ct || tag)
```

| Ključ | Kako nastaje | Gde stoji | Kod |
|---|---|---|---|
| **pepper** | prva Fernet linija fajla `secrets/notes.key`, base64url-dekodirana (32 B); `make notes-keys-generate` (`make/lint.mk`, generator `tools/gen_notes_key.py`, odbija da prepiše), putanja se menja sa `THILO_NOTES_KEY_FILE` | **na disku hosta, nikad u bazi**; isti fajl je i Fernet ključ za umotavanje MK u Redis-u | `thilo_notes/keys.py::peppers`, `pepper`, `wrap_for_redis`, `unwrap_from_redis`; `key_file` |
| **KEK_pin** | `Argon2id(PIN utf-8, salt=16 B random, length=32, iterations=3, lanes=1, memory_cost=65536 KiB, secret=pepper)` — RFC 9106 drugi preporučeni profil | nigde; izvodi se pri svakom unlock-u, u thread-u (`asyncio.to_thread`) | `crypto.py::derive_kek`, konstante `ARGON2_MEMORY_KIB`, `ARGON2_ITERATIONS`, `ARGON2_LANES`, `SALT_BYTES`, `KEY_BYTES`; `service.py::_derive` |
| **KDF parametri** | `{salt, m, t, p}` upisani **po keyring-u** pri setup-u, čitaju se pri unlock-u — podizanje cene menja samo nove wrap-ove | `notes_keyrings.data.kdf` | `crypto.py::KdfParams.fresh`, `to_json`, `from_json`; `service.py::_kdf` |
| **MK** (master key) | `os.urandom(32)`, jedan po vlasniku (po `(tenant_id, user_idx)`) | **samo umotan**, dva puta: `mk_pin_ct`/`mk_pin_nonce` i `mk_recovery_ct`/`mk_recovery_nonce`, AAD = `str(user_idx)`; dok je otključano stoji u Redis-u Fernet-umotan; u čistom obliku samo u procesnoj memoriji svc_notes za vreme jednog zahteva | `crypto.py::new_master_key`, `wrap`, `unwrap`, `aad_for_user`; `service.py::_pin_wrap`, `_recovery_wrap`; `unlock.py::open_unlock`, `resolve` |
| **recovery key** | 8 grupa po 4 RFC 4648 base32 znaka = 160 bita iz `secrets.token_bytes`; prikazan **jednom** pri `POST /pin`; pre izvođenja se normalizuje (velika slova, bez separatora, `0→O`, `1→I`) | nigde (korisnik ga čuva); u bazi samo `recovery_salt` (zaseban 16 B salt, isti m/t/p kao `kdf`) i wrap MK pod njim | `crypto.py::new_recovery_key`, `normalize_recovery_key`, `is_recovery_key_shaped`; `service.py::_recovery_kdf`, `_recovery_wrap` |
| **FK** (file key) | `os.urandom(32)` po fajlu | umotan pod MK: `fk_ct`/`nonce_k`, AAD `<file id>:key`, u redu `notes_files` | `crypto.py::new_file_key`, `wrap_file_key`, `unwrap_file_key`; `files.py::add_file`, `read_file` |

Zašto tri sloja (komentar iznad `crypto.py` § „an image in a note“ i doc 200 § The key per file): promena PIN-a prepakuje samo MK (32 B), ne dira ni beleške ni blobove; rotacija MK bi prepakovala po 32 B po fajlu umesto da ponovo upload-uje blobove; brisanje reda sa `fk_ct` čini blob na Voli trajno nečitljivim i kad Vola samo soft-briše (crypto-shred); MK nikad ne napušta svc_notes ka Voli ni u obliku šifrata.

### Šta otkriva koji dump

| Dump | Vidi | Ne vidi | Napomena |
|---|---|---|---|
| **Baza** (`notes`, `notes_folders`, `notes_files`, `notes_keyrings`) | strukturu: broj beležaka i foldera, ko je vlasnik (`user_idx`), stablo (`id_folder`, `id_parent`), `cache.bytes` (veličina čistog teksta), `cache.files` (broj fajlova), `cache.updated_at`, veličinu svakog fajla (`notes_files.cache.bytes`), `vola_file_idx`, KDF parametre i salt-ove, brojač pokušaja i `locked_until`, `pin_set_at` | nijedan naslov, telo, ime foldera, ime fajla, MIME, PIN, MK, FK u čistom obliku | bez `secrets/notes.key` dump **ne može ni da počne** brute-force nad 10^6 PIN-ova (pepper je Argon2 `secret`); sa fajlom svaki pokušaj košta 64 MiB RAM-a i ~0,1 s; recovery wrap je pod 160 bita i nije pogodiv. `models/__init__.py` docstring, `crypto.py` modulski docstring, doc 200 § The crypto „What a database dump reveals“; test `test_notes_api.py::test_the_database_holds_no_pin_no_master_key_and_no_plaintext` |
| **Redis** | ključeve `notes:unlock:<token>` → JSON `{user_idx, tenant_id, mk}` gde je `mk` Fernet šifrat; set `notes:unlock-index:<tenant>:<user>`; `notes:attempt-lock:<tenant>:<user>` | MK bez `secrets/notes.key` | dump Redis-a **plus** `notes.key` = MK svakog trenutno otključanog vlasnika (TTL 150 s), a sa bazom i njihov sadržaj. To je jedini realan scenario za rotaciju MK (odeljak 5). `unlock.py` docstring; test `test_the_redis_entry_holds_the_master_key_only_wrapped` |
| **Vola disk / Vola baza** | tenant (slug), `instance_type="note"`, `instance_id=<note id>`, ime `<file id>.bin`, `application/octet-stream`, veličinu šifrata (= čisti tekst + 28 B), sha256 šifrata, vremena | tip fajla, ime, sadržaj, thumbnail (nema ga) | blob je `nonce ∥ AES-GCM(FK)`; FK je u bazi thilo-a pod MK, pa sam Vola disk ne otvara ništa. `files.py` modulski docstring, doc 32 § Instance types thilo writes (red `note`) |
| **Logovi / memento / blockstream** | `user_id`, id beleške i fajla, brojevi bajtova, kodove događaja (`notes_unlock_failed`, `notes_file_added`, …) | ime, naslov, telo, PIN, recovery, token | doc 136 red „Notes“: „off for every channel“; doc 200 § Privacy |

## 2. Format šifrata

- **Algoritam**: AES-256-GCM iz `cryptography.hazmat.primitives.ciphers.aead.AESGCM` za sve (wrap ključeva i sadržaj). Nonce **12 B** `os.urandom` po svakom pozivu (`crypto.py::NONCE_BYTES`), tag 16 B (`_GCM_TAG_BYTES`), `AESGCM.encrypt` vraća `ct ∥ tag`.
- **Kodiranje u bazi**: standardni base64 (`crypto.py::b64e`, `b64d` sa `validate=True`; loš base64 je `NotesIntegrityError`), šifrat i nonce kao **dva odvojena string polja** u jsonb koloni `data`. Čist tekst je UTF-8 string (`seal`, `open_sealed`; `UnicodeDecodeError` se takođe tretira kao integrity greška).
- **Blob na Voli**: nonce je **ispred** šifrata u istom bajt nizu, `nonce ∥ ct ∥ tag`, da bi blob bio samostalan (`crypto.py::seal_blob`, `open_blob` odbija kraće od 28 B).
- **Verzionisanje**: `FORMAT_VERSION = 1` se upisuje kao `data.v` u svaki red (`service.py::_note_data`, `_folder_data`, `setup_pin`; `files.py::add_file`). **Napomena: `v` se danas piše, ali ga nijedna funkcija ne čita pri dešifrovanju** (`service.py::_open`, `files.py::_open`, `read_file` ne gledaju `v`) — verzija je rezervisana, ne dispečuje se.
- **AAD** vezuje svaki šifrat za red **i** polje (`crypto.py::aad_for(row_id, field)` → `"<id>:<field>"` ASCII; `aad_for_user` → `str(user_idx)`; `_aad_for_blob` → `str(file_id)`). Id-jevi su uuid7 (`thilo_common.db.ids.uuid7`) generisani **pre** šifrovanja, da AAD može da ih sadrži (`service.py::create_note` nid = uuid7(), `files.py::add_file` fid = uuid7()). Šifrat prekopiran na drugi red ili iz tela u naslov ne dešifruje se.

| Podatak | Ključ | AAD | Polja u `data` | Kod |
|---|---|---|---|---|
| wrap MK pod PIN-om | KEK_pin | `str(user_idx)` | `notes_keyrings.mk_pin_ct`, `mk_pin_nonce`, `kdf` | `service.py::_pin_wrap` |
| wrap MK pod recovery ključem | KEK_rec | `str(user_idx)` | `mk_recovery_ct`, `mk_recovery_nonce`, `recovery_salt` | `service.py::_recovery_wrap` |
| naslov beleške | MK | `<note id>:title` | `notes.title_ct`, `nonce_t` | `service.py::_note_data`, `note_title` |
| telo beleške (markdown) | MK | `<note id>:body` | `notes.body_ct`, `nonce_b` | `service.py::_note_data`, `note_body` |
| ime foldera | MK | `<folder id>:name` | `notes_folders.name_ct`, `nonce` | `service.py::_folder_data`, `folder_name` |
| FK | MK | `<file id>:key` | `notes_files.fk_ct`, `nonce_k` | `crypto.py::wrap_file_key` |
| ime fajla | MK | `<file id>:name` | `notes_files.name_ct`, `nonce_n` | `files.py::add_file`, `file_summary` |
| MIME fajla | MK | `<file id>:mime` | `notes_files.mime_ct`, `nonce_m` | `files.py::add_file`, `read_file` |
| blob (sadržaj fajla) | FK | `<file id>` | Vola, `<file id>.bin` | `crypto.py::seal_blob`, `open_blob` |
| MK u Redis-u | Fernet (`secrets/notes.key`) | — (Fernet nema AAD) | vrednost `notes:unlock:<token>`, polje `mk` | `keys.py::wrap_for_redis` |

- **Neuspeo decrypt** bilo gde (`InvalidTag`, loš base64, kratak blob) je `NotesIntegrityError` → HTTP **`409 notes_integrity`** sa fiksnom rečenicom, nikad šifrat ni tekst izuzetka u odgovoru (`service.py::_integrity`, `files.py::_integrity`). Kod wrap-a MK ista greška znači „pogrešan PIN“ (`crypto.py::unwrap` docstring).
- **Autosave** prepisuje ceo red sa svežim nonce-ovima; nema revizija, stari šifrat se gubi (`service.py::save_note`).
- **Šta NIJE autentifikovano**: strukturne kolone (`id_folder`, `id_parent`, `cache.bytes`, `cache.updated_at`, `cache.files`, `vola_file_idx`) nisu ni u AAD ni pod MAC-om; AAD sprečava zamenu šifrata između redova i polja, ne i premeštanje beleške u drugi folder ili menjanje `vola_file_idx` od strane nekog sa pisanjem u bazu.

## 3. Životni ciklus

Svaka ruta sem `_status`, health-a i beacon aliasa prvo prolazi **owner gate**: `GET /api/tenants/auth/me` sa prosleđenim JWT-om pozivaoca, polje `workspace_owner`; ne-vlasnik dobija `403 permission_denied`, nedostupan svc_tenants `502 notes_owner_unavailable` (`tenants.py::owner_gate`, `api/router.py::OWNER`). Rute koje čitaju ili pišu sadržaj traže i `X-Notes-Unlock` (`router.py::_mk` → `service.master_key` → `unlock.resolve`).

### Setup PIN-a — `POST /api/notes/pin {pin}` → `201 {recovery_key}`

`service.py::setup_pin`: `crypto.validate_pin` (tačno 6 ASCII cifara; odbija trivijalne — sve iste cifre, rastući ili opadajući niz, `crypto.py::_is_trivial`; iste reči i rečenice kao `validatePin` u `mobile/src/lib/auth/pin.ts`) → `422 notes_pin_invalid` sa `reason ∈ {length, digits, trivial}`; postojeći keyring → `409 notes_pin_exists` (i kad dva setup-a trče paralelno, preko `IntegrityError` na `unique_together (tenant_id, user_idx, active)`); novi MK, novi recovery key, oba wrap-a, `attempts: 0`, `locked_until: None`, `v: 1`. Recovery key se vraća jednom i nigde ne čuva.

### Unlock — `POST /api/notes/unlock {pin}` → `{token, expires_in}`

`service.py::open_notes` → `_check_pin`:

1. Samo oblik PIN-a (`_require_pin_shape`: dužina i cifre, **ne** trivijalnost — unos se proverava prema keyring-u, ne ocenjuje).
2. **Jedan pokušaj po osobi u isto vreme**: Redis `SET NX` na `notes:attempt-lock:<tenant>:<user>` sa `ex=15` (`ATTEMPT_LOCK_S`); zauzet lock → `429` od 1 s. Bez ovoga bi 20 paralelnih zahteva svi pročitali `attempts = 0`.
3. `locked_until` u budućnosti → `429 notes_too_many_attempts` sa `retry_after` i `Retry-After` header-om, **i za tačan PIN** (`_retry`).
4. `_try_unwrap`: izvede KEK za **svaku** liniju `secrets/notes.key` (aktivna prva) i proba `unwrap`; sve padnu → pogrešan PIN.
5. Pogrešan: `attempts += 1`, `locked_until = now + attempt_delay_s(attempts)` (ili `None` za 0), log `notes_unlock_failed` (`user_id`, `attempts`), od 10. i `notes_locked_out`; odgovor `403 notes_pin_incorrect` sa `attempts` i `retry_after`.
6. Tačan: `attempts = 0`, `locked_until = None`; ako je otvorila starija pepper linija, PIN wrap se odmah prepakuje pod aktivnu (lenja rotacija peppera).

Zatim `unlock.py::open_unlock`: `token = secrets.token_urlsafe(32)`; Redis `SET notes:unlock:<token> {"user_idx","tenant_id","mk": fernet(MK)} EX <ttl>`; `SADD notes:unlock-index:<tenant>:<user> <token>` sa `EXPIRE 86400`. TTL je `THILO_NOTES_UNLOCK_TTL`, podrazumevano **150 s** (`config.py::NotesConfig.unlock_ttl`, `unlock.py::ttl_s`).

### Token u svakom zahtevu — header `X-Notes-Unlock`

`unlock.py::HEADER`. `unlock.resolve(token, tenant_id, user_idx)`: nema tokena, nema ključa u Redis-u, loš JSON, tuđi `user_idx` ili tuđi `tenant_id` → **isti** `423 notes_locked` bez detalja koji razlikuju slučajeve; inače Fernet-odmota MK i **klizi TTL** (`EXPIRE` na pun `ttl`). `GET /api/notes/status` čita preostalo vreme **bez klizanja** (`unlock.expires_in`, `service.status`) da ekran „jesam li još otvoren?“ ne drži Notes otvoren. UDC kolekcija `notes` nema `Request`, pa header stiže kroz `UnlockHeaderMiddleware` i `ContextVar current_unlock_token` (`unlock.py`, `app.py::create_app`, `udc/notes_source.py`). Token nikad nije u URL-u (doc 200 § Privacy).

### Zaključavanje — `DELETE /api/notes/unlock` i beacon alias `POST /api/notes/unlock/close`

`unlock.drop(token)` je idempotentan i briše i član index seta. Alias je **izuzet iz JWT provere** (`router.py::close_path` u `public_paths_jwt`, `app.py`), prima token u telu kao `text/plain` ili `{"token"}` (`close_unlock_beacon`), jer `navigator.sendBeacon` ne može ni DELETE ni header; posedovanje tokena je jedino ovlašćenje i jedino što može je da ga ugasi.

### Promena PIN-a — `PUT /api/notes/pin {current_pin, new_pin}` → `204`

`service.py::change_pin`: `validate_pin(new_pin)`; `_check_pin(current_pin)` (troši pokušaje kao unlock); `_pin_wrap(new_pin, mk)` sa **svežim salt-om**; `unlock.drop_all` briše **svaki** živi token te osobe (index set). Nijedna beleška ni blob se ne dira. Dokaz: `tests/integration/test_notes_files_api.py::test_a_pin_change_rewrites_no_blob_and_only_the_new_pin_reads_the_file` (red `notes_files.data` i bajtovi na Voli identični pre i posle; stari PIN `403`, stari token `423`, novi PIN čita fajl bajt-za-bajt) i `test_notes_api.py::test_changing_the_pin_keeps_the_notes_and_drops_every_unlock`.

### Recovery — `POST /api/notes/pin/recover {recovery_key, new_pin}` → `{recovery_key}` (NOV)

`service.py::recover`: oblik (`is_recovery_key_shaped`) pa `_try_unwrap` nad `mk_recovery_ct` sa `_recovery_kdf` (svoj salt, isti m/t/p); pogrešan → `403 notes_recovery_incorrect`, log `notes_recovery_failed`, **ne broji se u `attempts`** (160 bita nije pogodivo, a brojanje bi dozvolilo da pogađanje PIN-a zaključa vlasnika i iz recovery-ja, doc 200 § Brute force); uspeh → novi PIN wrap, **nov recovery key i nov `recovery_salt`** (stari je ukucan negde i penzionisan), `attempts = 0`, `drop_all`.

### Reset — `POST /api/notes/reset {password}` → `{files, notes, folders, keyrings}`

`router.py::reset` → `tenants.py::verify_password` (`POST /api/tenants/auth/password/verify` sa JWT-om pozivaoca; `403 notes_password_incorrect`) → `service.py::reset`: **prvo fajlovi** (`files.drop_all_files`, uključujući ranije soft-obrisane redove jer i oni drže FK), pa hard delete beležaka, foldera i keyring-a (`_hard_delete`, dokumentovani izuzetak od pravila `active TRUE|NULL`), pa `drop_all`. Sledeći setup pravi nov MK; podaci su nepovratno izgubljeni po dizajnu.

### Brute-force tabela — `crypto.py::attempt_delay_s`

| Pogrešnih unosa u nizu | Čekanje | Konstanta |
|---|---|---|
| 1–2 | 0 | `FREE_ATTEMPTS = 3` (ispod 3 besplatno) |
| 3 | 1 s | |
| 4 | 5 s | |
| 5–9 | 30 s | |
| 10 | 3600 s | `LOCKOUT_AT = 10`, `LOCKOUT_BASE_S = 3600` |
| 11, 12, … | 7200 s, 14400 s, … | `LOCKOUT_BASE_S << (n − 10)` |

Do 9. unosa je to tabela telefonskog app-lock-a (`mobile/src/lib/auth/pin.ts::attemptDelayMs`: 0, 0, 0, 1000, 5000, 30000 ms; `MAX_ATTEMPTS = 10` tamo briše sesiju na uređaju, `verifyPin`). Server nema šta da obriše, pa od 10. zaključava. Brojač i `locked_until` žive u redu keyring-a (`notes_keyrings.data.attempts`, `locked_until` ISO string, `service.py::locked_until`), dakle preživljavaju restart; `GET /status` vraća `locked_until` da klijent crta odbrojavanje.

### Zaključavanje na klijentu

- **Web** (`frontend/src/notes/`): `notesLockPolicy.ts::decide` — `IDLE_MS = 120_000` bez pokazivača, tastera, dodira ili skrola → odbrojavanje `COUNTDOWN_MS = 10_000` → lock; aktivnost u odbrojavanju vraća u `live`; tab koji je spavao i propustio odbrojavanje zaključava odmah; `AWAY_MS = 30_000` posle gubitka fokusa ili prelaska u pozadinski tab → lock bez odbrojavanja. `notesLock.ts::lockNotes` u četiri koraka: (1) flush autosave-a sa još važećim tokenom, (2) `POST /unlock/close` (`sendBeacon` sa `pagehide`), (3) `unlockState.ts::clearNotesUnlock`, (4) `dropNotesQueries` — react-query keš dešifrovanog sadržaja i `notesImages.forget()` (opoziv svih `blob:` URL-ova). Token je **modul-promenljiva** (`unlockState.ts`), nikad `localStorage`/`sessionStorage`/IndexedDB/react-query; reload = lock. Svaki `423` briše token lokalno (`notesApi.ts::send`). UDC klijent dodaje header thunk-om u `frontend/src/main.tsx`.
- **Telefon** (`mobile/src/lib/notes/`): `lockPolicy.ts::decide` sa istim brojevima i istom test tabelom, bez `away` grane jer `AppState` koji napušta `active` zaključava **odmah** bez odbrojavanja. `lock.ts::lockNotes` menja redosled: token i dešifrovani fajlovi (`fileStore.ts::clearNoteFiles`) i audio player (`playback.ts`) se brišu **sinhrono prvo**, jer iOS u tom trenutku fotografiše ekran za app switcher; tek onda flush i `POST /unlock/close` običnim `fetch`-om bez bearer-a (RN nema `sendBeacon`). Token u zustand store-u bez `persist` (`unlockStore.ts`). Biometrija ne izvodi ključ: PIN stoji u keychain-u iza lica/otiska (`expo-secure-store` `requireAuthentication`, po Workspace-u, `biometricPin.ts::storeNotesPin`, `readNotesPin`) i **pušta se** ka `POST /unlock` kao ukucan; posle `PUT /pin` stavka se prepisuje novim PIN-om (`replaceNotesPin`) da senzor ne potroši pokušaj starim.
- Server TTL 150 s je samo backstop za tab koji je pukao ili telefon koji je ubijen; klijent uvek zaključa prvi (120 + 10 < 150).

## 4. Fajlovi na Voli

### Upload — `POST /api/notes/id/{note_id}/files` (multipart `file`, form `pasted`) → `201 {id, name, mime, bytes}`

`router.py::add_file` čita najviše `max_file_bytes() + 1` bajtova (`UploadFile.read`) pa `files.py::add_file`, redosled provera takav da odbijanje nikad ne stigne do Vole:

1. Unlock (`423`), beleška (`404 notes_note_not_found`).
2. Veličina > limit → `413 notes_file_too_large` sa `max_bytes`. Limit `THILO_NOTES_MAX_FILE_BYTES`, podrazumevano **15 × 1024 × 1024**; staro ime `THILO_NOTES_MAX_IMAGE_BYTES` se i dalje čita kao fallback (`config.py::NotesConfig.max_file_bytes`, `AliasChoices`). Vola sama nema gornji limit (doc 200 § On vola); nginx ispred ima `client_max_body_size 25m` (doc 09, po TCK9D6PPNQ).
3. **MIME iz bajtova, ne iz imena** (`files.py::file_mime`): `crypto.sniff_image` po magic bajtovima prepoznaje samo PNG, JPEG, GIF, WebP; inače deklarisani `Content-Type` ako je čist `type/subtype` (regex `_MIME`, parametri odbačeni) **i** nije `image/*` (SVG i svaki nepotvrđeni `image/*` → octet-stream) **i** nije u `_ACTIVE` (HTML, XHTML, XML, JavaScript); inače `application/octet-stream`. Bilo koji tip se **prima** (TCK9D6PPNQ je uklonio `415`).
4. Ime: `clean_name` (bez putanje i kontrolnih znakova, ≤ 200 znakova, `file.<ext>`/`file.bin` kad je prazno); `pasted=true` i slika → `pasted-<n>.<ext>`.
5. `fid = uuid7()`, `fk = new_file_key()`, `blob = seal_blob(fk, data, fid)`; `HttpVolaClient.upload_file(instance_type="note", instance_id=str(note.id), file_bytes=blob, filename=f"{fid}.bin", content_type="application/octet-stream")` (`files.py::INSTANCE_TYPE`, `OCTET_STREAM`).
6. Tek posle Vole: `wrap_file_key`, `seal(name)`, `seal(mime)`, `NoteFile.create(..., vola_file_idx, data={fk_ct, nonce_k, name_ct, nonce_n, mime_ct, nonce_m, v}, cache={bytes: len(data)})`. Ako red ne može da se upiše, blob se briše sa Vole (`_delete_blob`, best effort). `_recount` prebrojava `notes.cache.files` iz redova (nikad `+1`).
7. Log `notes_file_added`: `user_id`, `note_id`, `file_id`, `bytes` — **nikad ime**.

Klijent ka Voli: `thilo_common/clients/vola.py::HttpVolaClient`, pravljen po pozivu kroz `make_vola_client_from_env` i zatvoren (`files.py::_vola`); admin ključ + `X-Tenant-Slug` i `X-Forwarded-User` iz konteksta (`_vola_headers`). `THILO_VOLA_MODE` nije `http` → `503 notes_files_unavailable` samo za fajlove, ostatak Notes-a radi; Vola odgovori greškom → `502 notes_file_store_failed` (`_store_failed`, log sa operacijom i statusom).

### Zašto `application/octet-stream` i `<file id>.bin`

Vola odlučuje da li fajl ima thumbnail **po sačuvanom MIME tipu**: `libs/vola/src/vola/services/thumbnails.py::ThumbnailService.is_image_mime` (`mime_type.startswith("image/")`), a `GET …/thumbnail` (`libs/vola/src/vola/api/files.py::get_thumbnail`) lenjo generiše WEBP `<hash>.<ext>.thumbnail.<size>.<crop>.webp` **pored bloba na disku** i kešira ga 24 h. Kad bi Notes slao sliku kao `image/*`, prvi poziv thumbnail rute bi napravio **čist, nešifrovan** WEBP te slike na Vola disku. Sa `application/octet-stream` Vola vraća `X-Thumbnail-Status: not-image` i ne dira sadržaj. Ime `<file id>.bin` dodatno sprečava da `detect_mime` (`libs/vola/src/vola/services/files.py`, `mimetypes.guess_type` po ekstenziji) pogodi tip po imenu, i ne otkriva ni originalno ime ni vrstu fajla. Blob je u svakom slučaju šifrat, ali oznaka tipa je sama po sebi curenje (koja beleška ima PDF, koja video). Test: `test_notes_files_api.py::test_vola_holds_ciphertext_as_octet_stream_never_the_image`.

### Download — `GET /api/notes/id/{note_id}/files/{file_id}`

`files.py::read_file`: dešifruje MIME i ime pod MK, odmota FK (`unwrap_file_key`), `HttpVolaClient.download_file` (**ceo fajl**, `bytes`), `open_blob`. Vola `404` → `404 notes_file_not_found`. `router.py::read_file` vraća `Response(content=data, media_type=mime, headers=served_headers(mime, name))`:

- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` uvek;
- `Content-Disposition: inline` samo za četiri sniff-ovana image tipa (`crypto.IMAGE_MIMES`), inače `attachment; filename="<ascii>"; filename*=UTF-8''<url-encoded>` — browser uperen u putanju preuzima, ne renderuje (`files.py::served_headers`);
- **nema `Range`, nikad `206`** (komentar u `router.py::read_file`): na 15 MB blob je svejedno ceo u memoriji, a web viewer pravi `blob:` URL i seek-uje lokalno.

Bez tokena ili sa tuđim: isti `423 notes_locked` kao sve ostalo, pa goli `<img src>` ne dobija i ne otkriva ništa (`test_a_get_without_the_token_is_423_even_for_a_real_file`, `test_another_persons_token_is_the_same_423`). `GET …/files` lista dešifrovana imena i tipove pod unlock-om (`file_summary`); namerno nije UDC kolekcija (razlog u komentaru `router.py::list_files`).

### Referenca u tekstu i keš na klijentu

Markdown čuva `![ime](/api/notes/id/<note>/files/<fid>)` za sliku i `[ime](/api/notes/id/<note>/files/<fid>)` za ostalo, **bez tokena u URL-u**. Browser nikad sam ne traži tu putanju:

- **Web** `frontend/src/notes/notesImages.ts::createNotesFileCache`: `fetch` sa `X-Notes-Unlock` (`notesApi.ts::fetchNoteFile`) → `Blob` → `URL.createObjectURL`, u **modul-promenljivoj** (nikad storage, Cache API ni react-query); `resolve` zamenjuje `src` slika posle DOMPurify-ja (`tickets/privateImages.ts`), `load` daje `blob:` URL attachment viewer-u (`NoteFileViewer.tsx`), koji seek-uje PDF/audio/video unutar njega; `remember` ubacuje upravo upload-ovane bajtove da se ne vraćaju; `drop`/`dropNote` posle brisanja; **`forget()` opoziva svaki URL** i prazni keš — zove ga `notesLock.ts::dropNotesQueries` na lock i na svaki `423`; brojač generacije `gen` odbacuje odgovor koji stigne posle lock-a (`NoteFileGone`). Download iz viewera je jedini izlaz čistog teksta.
- **Telefon** `mobile/src/lib/notes/fileStore.ts`: zustand bez `persist`, fajl kao `data:` URI; RN `Image` se **nikad** ne daje http URL (platformski disk keš i pokušaj bez header-a su kanal); `clearNoteFiles()` u istom sinhronom koraku kao brisanje tokena (`lock.ts`); `gen` isto kao na webu.

### Brisanje, crypto-shred, purge

Jedan put za sve: `files.py::_drop_rows` — za svaki red **prvo Vola, pa red**:

1. `_remove_blob`: `HttpVolaClient.purge_file` (vola-spp `DELETE /api/v1/files/{type}/id/{id}/id/{file_id}/purge`, PR #23 iz TCKKDFRDP9, doc 32 § Permanent delete); stara Vola odgovara `404`/`405` → fallback `delete_file` (soft delete, `deleted_at`); `404` i tu = fajl već nestao. Svaka druga greška se propagira.
2. `row.delete()` — **hard delete**, red odlazi sa `fk_ct` u sebi: blob je od tog trenutka nečitljiv ma šta Vola još držala (**crypto-shred je bezbednosni uslov, purge je higijena diska**).
3. Vola ne odgovori (refused, `5xx`) → `502 notes_files_unavailable` „nothing was deleted“, red **ostaje** da blob bez traga ne zaostane; redovi obrađeni pre greške su otišli; `notes.cache.files` se prebroji pre `502` (`drop_files_of_notes`).
4. Log `notes_file_deleted` sa `purged: true|false`.

Pozivaoci: `DELETE …/files/{fid}` (`delete_file`), brisanje beleške i foldera sa sadržajem (`drop_files_of_notes` iz `service.delete_note`, `delete_folder`), `POST /reset` (`drop_all_files`, `include_deleted=True`). `GET …/delete-preview` vraća `{notes, folders, files}` brojanjem bez dešifrovanja za dijalog (`service.note_delete_preview`, `folder_delete_preview`). Dijalozi na webu i telefonu kažu da je brisanje trajno i da se sadržaj ne vraća ni uz PIN ni uz recovery (`frontend/src/notes/PermanentDelete.tsx`).

**Purge na Voli** (`libs/vola`, PR #23): briše red i ceo lanac verzija sa share linkovima, job-ovima i metapodacima u jednoj transakciji, pa `storage.delete(hash)` (blob i njegovi thumbnail-i) **samo ako nijedan drugi red bilo kog tenanta ne referencira isti hash** — CAS je deljen i dedup-ovan među tenantima. Vraća `{files, blobs}`. Poznata trka: byte-identičan upload između provere i unlink-a bi izgubio blob; za šifrat (nasumičan FK i nonce) dedup se u praksi ne dešava.

## 5. Šta NE radi ili je ograničeno

| Tema | Stanje u Notes-u | Gde se vidi |
|---|---|---|
| **Range / streaming nad šifratom** | Ne postoji. Blob je jedna AES-GCM poruka: tag se proverava nad celim sadržajem, pa se ne može dešifrovati isečak. Download je `download_file` → `bytes`, `open_blob` nad celim, `Response` sa celim telom; `download_file_range` u klijentu postoji ali ga Notes ne koristi. Seek radi samo zato što klijent drži ceo `blob:` | `router.py::read_file` komentar, `files.py::read_file`, `crypto.py::open_blob`, `notesImages.ts` zaglavlje |
| **Veliki fajlovi** | Ceo fajl u memoriji servisa, tri puta: upload čita celo telo (`read(max+1)`), šifruje celo (`seal_blob`), šalje `file_bytes`; download isto u obrnutom smeru. Zato tvrdi limit 15 MB. Nema resumable upload-a | `router.py::add_file`, `files.py::add_file`, `config.py::max_file_bytes` |
| **Dedup** | Nema ga i ne može ga biti: nasumičan FK i nonce daju različit šifrat za isti fajl; Vola CAS dedup se ne aktivira; isti fajl dva puta = dva bloba. Hash čistog teksta se ne čuva nigde (čuvao bi jednakost sadržaja) | `files.py::add_file`, doc 32 § Permanent delete „known race“ |
| **Thumbnail i OCR** | Server ih nema i ne sme da ih ima (octet-stream baš zato). Sličice u traci *Files* crta klijent iz celog dešifrovanog bloba. OCR, full-text pretraga sadržaja i pretraga tela beleške ne postoje; pretraga je samo nad **dešifrovanim naslovima u Pythonu**, u okviru unlock-a | `udc/notes_source.py` docstring, `NoteFilesStrip.tsx`, doc 200 § Files |
| **Share** | Nema share linka, nema deljenja sa drugom osobom; jedan vlasnik po Workspace-u (`unique (tenant_id, user_idx, active)` na keyring-u; owner gate). Download iz viewera je jedini izlaz čistog teksta; na telefonu ni Download ni Share | `models/__init__.py::NoteKeyring`, `tenants.py::owner_gate`, doc 200 § Files → Web |
| **Rotacija MK** | Ne postoji ruta ni alat. Dizajn je dopušta: FK-ovi bi se prepakovali (32 B po fajlu), **ali naslovi, tela i imena foldera su direktno pod MK**, pa bi rotacija morala da ih sve ponovo šifruje. Scenario koji bi je tražio: Redis dump + `secrets/notes.key` istovremeno | `crypto.py` § „an image in a note“, `notes-images-analysis.md` § 2 |
| **Rotacija peppera** | Samo ručno: nova linija se **dodaje ispred** u `secrets/notes.key`, stare ostaju; PIN wrap se lenjo prepakuje pri sledećem unlock-u, recovery wrap samo pri recovery-ju, pa stare linije u praksi ostaju zauvek. Zamena ili brisanje linije čini Notes svakog vlasnika neotvorivim, recovery uključen | `keys.py` docstring, `service.py::_check_pin` (pepper_index > 0), doc 200 § The key file |
| **Verzija formata `v`** | Piše se (`FORMAT_VERSION = 1`), nikad se ne čita; promena formata bi morala tek da doda dispatch | `service.py::_open`, `files.py::_open` |
| **Nije E2E** | Server vidi čist tekst: autosave šalje markdown preko TLS-a i šifruje po prijemu; MK je u Redis-u (Fernet) dok traje unlock i u RAM-u za vreme zahteva; model štiti dump baze, diska i Redis-a (bez key fajla) i radoznalog operatera baze, ne kompromitovan živ server | `router.py` docstring, `unlock.py` |
| **Struktura nije autentifikovana** | `id_folder`, `id_parent`, `cache.*`, `vola_file_idx` nisu pod AAD ni MAC-om (odeljak 2) | `models/__init__.py` |
| **Nema revizija, nema korpe** | Autosave prepisuje; brisanje je trajno; redovi soft-obrisani pre N5 ostaju do Reset-a | `service.py::save_note`, doc 200 § Deleting is permanent |
| **Cena unlock-a** | Argon2id 64 MiB / 3 prolaza po pokušaju u thread-u; `SET NX` po osobi ograničava paralelizam po osobi, ne ukupno — mnogo vlasnika istovremeno = mnogo RAM-a | `service.py::_derive`, `_check_pin` |
| **Jedan PIN po osobi po Workspace-u** | Keyring je `(tenant_id, user_idx)`; nema per-folder ni per-file PIN-a | `models/__init__.py::NoteKeyring` |

## 6. Preporuke za jsvola

Opšta lekcija iz Notes-a: **ono što je sve ostalo učinilo jeftinim je FK po fajlu umotan u nešto drugo**. Promena PIN-a, recovery, rotacija, crypto-shred, fallback na soft delete — sve je ispalo iz tog jednog sloja. jsvola treba da ima **jedan format bloba** (odeljak 6.8) i **pluggable način umotavanja FK** (odeljak 6.3); „PIN ili ključ“ iz scope-a v1.0 su onda dva wrap provider-a nad istim blobom, a ne dva kripto modela.

### 6.1 (a) Šifrovanje na serveru ili E2E u klijentu (WebCrypto)

**Preporuka: server-side (envelope) šifrovanje kao v1.0, format bloba takav da ga klijent može proizvesti i sam kasnije.**

Iskustvo iz Notes-a koje to podržava:

- Klijenti su ostali glupi: web drži samo bearer token u modul-promenljivoj, telefon isto; nijedan ne drži ključ, nijedan ne radi kripto. To je omogućilo UDC kolekciju, `<img>` kroz keš, attachment viewer i telefon bez ijednog native modula (`mobile/CLAUDE.md`: native modul = nov build; `mobile/src/lib/auth/pin.ts` zaglavlje objašnjava da RN nema ni CSPRNG bez native modula, pa je app PIN morao na čist JS PBKDF2 — E2E na telefonu bi bio još teži).
- Recovery, brute-force brojač, `drop_all` svih sesija pri promeni PIN-a, pretraga naslova — sve to postoji zato što server u trenutku unlock-a ima ključ. E2E ukida pretragu, pomeri recovery na korisnika i uvodi sinhronizaciju ključa između uređaja.
- Pretnja koju Notes rešava je dump (baza, disk, Redis bez key fajla) i operater sa pristupom bazi, ne kompromitovan živ server. Za servis za fajlove unutar iste platforme to je ista pretnja.

Kako ostaviti vrata za E2E: blob format iz 6.8 je samostalan (header + segmenti, nonce izveden, AAD = id fajla i indeks); jsvola treba da prihvati i **već šifrovan blob** uz klijentski dostavljen `fk_ct` (opcija `encryption: "client"`), i da ga tada servira kao opaque bajtove bez dešifrovanja. Nema potrebe da to bude u v1.0, ali format ne sme da ga spreči: zato nonce **ne sme** da zavisi od serverske tajne i AAD ne sme da sadrži ništa što klijent ne zna.

### 6.2 (b) Čiji je PIN: korisnikov, po fajlu ili po folderu

**Preporuka: PIN pripada *keyring-u*, keyring pripada principalu (korisniku) unutar tenanta — tačno kao Notes. Ni po fajlu ni po folderu.**

- Notes keyring je `(tenant_id, user_idx)` sa `unique_together` (`models/__init__.py::NoteKeyring`). Jedan unlock otvara sve, jedan brojač pokušaja, jedan recovery ključ, jedan `drop_all`. Per-file PIN bi umnožio recovery ključeve i brojače i učinio „zaključaj sve“ neizrazivim; per-folder PIN isto, plus pitanje šta je sa fajlom koji se premešta (Notes je baš zato stavio `instance_id = note id` da `move` ne dira Volu, `files.py::INSTANCE_TYPE` komentar).
- „Šifrovan folder“ u jsvola neka bude **politika, ne ključ**: atribut foldera `encryption: {keyring: <id>}` koji svaki novi fajl u njemu šifruje pod FK umotanim u taj keyring. Fajl nosi `keyring_id` u svom redu; folder nosi podrazumevani keyring. Premeštanje fajla između foldera ne dira kripto.
- Dozvoliti više keyring-ova po tenantu (jedan po korisniku), ali jedan po `(tenant, principal)`. Ko je „principal“ odlučuje pozivalac (thilo šalje `X-Forwarded-User`, `thilo_common/clients/vola.py::_vola_headers`), a jsvola gate-uje: samo principal keyring-a sme da ga otključa.
- PIN validacija kao `crypto.py::validate_pin` (6 cifara, trivijalni odbijeni, iste reči `length|digits|trivial`); dužina kao konstanta, da pozivalac koji želi alfanumerički passphrase to dobije jednom promenom (otvoreno pitanje 3 iz `notes-analysis.md`).

### 6.3 (c) „Ključ“: ključ pozivaoca po zahtevu ili ključ tenanta at-rest

**Preporuka: uvek FK po fajlu; razlika je samo u tome ko umotava FK. Tri wrap provider-a nad istim blobom:**

| Provider | Kako se FK umotava | Štiti od | Zahtev nosi | Analog u thilo-u |
|---|---|---|---|---|
| `tenant` (at-rest) | KEK tenanta izveden iz serverskog key fajla (jedna Fernet/HKDF linija po tenantu ili globalna sa `tenant_id` u info polju), rotacija dodavanjem linije | dump diska i backup-a | ništa dodatno | `thilo_tenants_mvp/auth/at_rest_crypto.py` (Fernet nad `secrets/tenants.key`, doc 37 § Foundation); `keys.py::wrap_for_redis` |
| `keyring` (PIN) | FK pod MK keyring-a; MK pod Argon2id(PIN, salt, pepper) i pod recovery ključem — Notes model iz odeljka 1 | dump baze + diska + Redis-a bez key fajla; operater baze | unlock token (6.4) | `svc_notes` ceo |
| `caller` (ključ po zahtevu) | pozivalac šalje 32 B ključ (base64) u header-u pri upload-u i download-u; jsvola pod njim umotava FK i **ne čuva ništa** sem `fk_ct` | sve što jsvola sam ne drži | `X-Vola-Content-Key` (ime po dogovoru) | nema; ovo je ono što bi thilo servis radio kad bi hteo da jsvola nikad nema ključ |

Zašto ne „ključ tenanta at-rest direktno nad sadržajem“: Notes je to odbacio za slike baš zato što direktni ključ nad sadržajem znači re-upload svih blobova pri svakoj rotaciji i nemoguć crypto-shred (`notes-images-analysis.md` § 3 „Zašto ključ po fajlu“). Zašto ne „samo ključ pozivaoca“: tada pretraga, thumbnail i recovery ne postoje, a svaki pozivalac mora sam da izmisli keyring, brojač i recovery — Notes je pokazao koliko je toga (odeljak 3).

Zajedničko za sva tri: `fk_ct` sa AAD `<file id>:key` (plus `keyring_id` ili `tenant_id` u AAD, da se wrap ne može preseliti); `v` koji se **čita** i dispečuje (Notes ga samo piše, odeljak 5); KDF parametri po keyring-u.

### 6.4 (d) Unlock token ili ključ u svakom zahtevu

**Preporuka: unlock token sa kliznim TTL-om za `keyring` provider (Notes model); ključ u zahtevu samo za `caller` provider i samo server-ka-serveru.**

Šta je token kupio Notes-u:

- Ključ nikad ne napušta server; klijent drži 43 znaka opaque bearer-a u memoriji (`unlockState.ts`, `unlockStore.ts`).
- Centralni opoziv: `unlock.drop_all` kroz index set `notes:unlock-index:<tenant>:<user>` — promena PIN-a, recovery i reset gase **svaku** sesiju odmah (`service.py::change_pin`). Sa ključem u zahtevu to ne postoji.
- Isti `423` za sve neuspehe (`unlock.resolve`), token vezan za `tenant_id` i `user_idx`, pa tuđi token ne otkriva ni da postoji.
- `GET /status` koji ne klizi TTL (`unlock.expires_in`) i beacon alias bez JWT-a (`router.py::close_path`) — dva detalja koja treba preuzeti doslovno.
- Cena: Redis (ili ekvivalent) i to da MK u Redis-u mora biti umotan pod isti key fajl (`keys.py::wrap_for_redis`) da Redis dump sam ne otvara ništa.

Za jsvola: `POST /api/v1/keyrings/{id}/unlock {pin}` → `{token, expires_in}`; header `X-Vola-Unlock` na svakoj ruti nad šifrovanim fajlom; TTL konfigurabilan (Notes: 150 s, klijent zaključava na 120 + 10); `DELETE /unlock` + `POST /unlock/close` sa tokenom u telu; token **nikad u URL-u** ni u share linku. Za `caller` provider ključ ide u header na svaki zahtev, jsvola ga koristi i zaboravlja, nikad ne loguje; dozvoliti ga samo preko API ključa servisa, ne iz browsera.

### 6.5 (e) Recovery i brute-force

**Preporuka: preuzeti Notes doslovno.** Konkretno, u redosledu važnosti:

1. **Pepper iz key fajla kao Argon2 `secret`** (`crypto.py::derive_kek`, `keys.py::pepper`) — jedina stvar koja dump baze čini beskorisnim nad prostorom od 10^6 PIN-ova. Rotacija dodavanjem linije ispred, stare linije ostaju; unlock proba svaku (`service.py::_try_unwrap`) i lenjo prepakuje. U TypeScript-u: `argon2` (node-argon2) podržava `secret` i radi u libuv thread pool-u; `node:crypto` nema Argon2, pa je to zavisnost koju jsvola mora da ponese. AES-256-GCM kroz `node:crypto` `createCipheriv('aes-256-gcm')` sa 12 B IV, `setAAD`, 16 B tag.
2. **Parametri**: 64 MiB / t=3 / p=1 / salt 16 B / ključ 32 B (`ARGON2_*` u `crypto.py`), **upisani po keyring-u** (`KdfParams.to_json`) da se mogu podizati bez migracije.
3. **Brojač u redu keyring-a** (preživljava restart) + **mutex po principalu** (`SET NX … EX 15`, `service.py::_check_pin`) — bez mutex-a paralelni pogodci zaobilaze tabelu. Tabela `crypto.py::attempt_delay_s` (0, 0, 0, 1 s, 5 s, 30 s ×5, 1 h, pa dupliranje). `429` sa `Retry-After` **i za tačan PIN** dok traje lock; `403` sa `attempts` i `retry_after` za pogrešan; tačan resetuje.
4. **Recovery ključ** 160 bita base32 8×4 prikazan jednom, normalizacija `0→O 1→I` (`crypto.py::normalize_recovery_key`), svoj salt, pogrešan **ne broji se** u pokušaje (`service.py::recover`), uspeh izdaje **nov** recovery ključ i obara sve sesije.
5. **Reset** = re-autentikacija pozivaoca (u thilo-u lozinka preko svc_tenants, `tenants.py::verify_password`; u jsvola to je obaveza pozivaoca, jsvola samo traži potvrdu kroz API ključ sa odgovarajućim scope-om) + crypto-shred svega pod keyring-om (`service.py::reset`: fajlovi prvo, pa redovi, pa keyring).
6. **Logovi**: samo id-jevi i brojevi (`notes_unlock_failed`, `notes_locked_out`, `notes_recovery_failed`); nikad PIN, recovery, token, ime (doc 136). jsvola već ima `file.purge` u tom duhu.

### 6.6 (f) Thumbnail i OCR za šifrovane fajlove

**Preporuka: izvedenice su dozvoljene samo kao šifrovani „sibling“ blobovi pod istim FK, napravljeni u zahtevu koji drži ključ; nikad od background worker-a koji ključ nema; nikad u čistom obliku na disku, u bazi ili u indeksu.**

- Notes nema ništa od toga i baš octet-stream oznaka postoji da Vola **ne** napravi thumbnail (odeljak 4; `thumbnails.py::is_image_mime`, `api/files.py::get_thumbnail` koji lenjo piše WEBP pored bloba). Sličice crta klijent iz celog dešifrovanog bloba — to je izvodljivo do 15 MB i besmisleno za 500 MB video.
- Za jsvola: pri upload-u (ili prvom otključanom GET-u) server ima čist tekst u memoriji; tada može da napravi thumbnail i sačuva ga kao drugi blob `nonce∥ct` pod **istim FK** sa AAD `<file id>:thumb:<size>` i da ga servira samo pod unlock-om sa `Cache-Control: no-store`. Celery/worker put (`libs/vola/src/vola/workers/thumbnails.py`) mora da bude **isključen** za šifrovane fajlove jer nema FK — status `not-image`/`encrypted` kao danas.
- OCR tekst isto: šifrovan pod FK (`<file id>:ocr`), pretraživ samo kao Notes pretraga naslova — dešifruj u okviru unlock-a i `matches` u procesu (`udc/notes_source.py`), nikad u OpenSearch/full-text indeks. Realno je to prihvatljivo samo za male skupove; za velike jsvola treba otvoreno da kaže „šifrovani fajlovi nisu u pretrazi“.
- Sve izvedenice se brišu sa fajlom (isti lanac kao `purge`), a crypto-shred ih svejedno pokriva jer su pod istim FK.

### 6.7 (g) Share link za šifrovan fajl

**Preporuka: opt-in „share grant“ koji nosi *ponovo umotan FK*, isključen podrazumevano u `keyring` modu; nikad share koji zaobilazi kripto.**

- Notes nema share i to je bio svestan izbor: jedini izlaz čistog teksta je Download iz viewera vlasnika (doc 200 § Files → Web; doc 136 red Notes). Ako jsvola uvodi share, mora da bude jasno da **primalac dobija čist tekst** — to je svrha share-a i treba da stoji u dijalogu kao što Notes dijalozi kažu da je brisanje trajno.
- Mehanizam koji ne razbija model: pri kreiranju share-a (pozivalac je otključan, server ima FK) jsvola generiše nasumičnu tajnu `S` (32 B), umota FK pod `S` (`fk_share_ct`, AAD `<share id>:key`) i upiše red share-a sa TTL-om, `max_downloads` (vola već ima `starts_a_download`, doc 32 § Seekable media) i opozivom; link nosi `S` u **fragmentu** (`/s/<share id>#<S>`) ili u path-u, a server ga **ne čuva**. Pri download-u klijent šalje `S`, server odmota FK, dešifruje segment po segment i servira. Opoziv = brisanje reda (crypto-shred `fk_share_ct`), nezavisno od FK vlasnika. Ni PIN ni MK se ne diraju.
- `S` nikad u logu ni access logu (fragment to garantuje na strani browsera; ako ide u path, path redakcija kao za tokene). Share **ne** sme biti dostupan za `caller` provider jer server tada FK nema ni u trenutku kreiranja — osim ako pozivalac sam dostavi `fk_share_ct`.

### 6.8 Segmentno šifrovanje (AES-GCM po segmentu) — zbog `Range`-a i resumable upload-a

Ovo je jedina stvar koju jsvola **ne sme** da preuzme iz Notes-a. Notes blob je jedna GCM poruka (`crypto.py::seal_blob`), pa ne postoji `206`, a ceo fajl prolazi kroz memoriju tri puta (odeljak 5). Predlog formata, u duhu Tink „streaming AEAD“ i libsodium `secretstream`, ali bez HKDF po segmentu da bi klijentska implementacija ostala trivijalna:

```
header (čist tekst, u AAD svakog segmenta):
  magic "JSV"  | version u8 = 1 | segment_size u32 (podrazumevano 1 MiB, min 64 KiB)
  | nonce_prefix 8 B random po fajlu | plaintext_length u64

segment i (i = 0 .. n-1):
  nonce  = nonce_prefix (8 B) ∥ i (u32 big-endian)          — izveden, ne čuva se
  aad    = header ∥ "<file id>" ∥ i (u32) ∥ last (u8: 1 za poslednji segment)
  ct_i ∥ tag_i = AES-256-GCM(FK, nonce, plaintext[i*S .. (i+1)*S), aad)
```

- **Overhead**: 16 B tag po segmentu (nonce se ne čuva), na 1 MiB segmentu zanemarljivo; header 25 B jednom.
- **Range**: za `bytes=a-b` server čita samo segmente `floor(a/S) .. floor(b/S)` sa diska (offset = header + i·(S+16)), dešifruje njih, odseče, odgovori `206` sa `Content-Range` u **plaintext** koordinatama i `Accept-Ranges: bytes` (pravila iz `libs/vola/src/vola/api/_byte_range.py`, doc 32 § Seekable media, ostaju ista). Memorija je konstantna po zahtevu.
- **Integritet celine**: `last` flag u AAD poslednjeg segmenta i `plaintext_length` u header-u sprečavaju skraćivanje ili dodavanje segmenata; indeks u AAD sprečava preuređivanje; `file id` u AAD sprečava presađivanje bloba na drugi red (ono što Notes radi sa `<file id>`).
- **Resumable upload**: upload sesija drži `fk_ct`, `nonce_prefix`, `segment_size` i `next_index`; klijent šalje čist tekst u komadima (server-side mod) ili već šifrovane segmente (client mod), server dodaje segment po segment; prekid se nastavlja od poslednjeg kompletnog segmenta jer je svaki nezavisno verifikovan; `finalize` upisuje `plaintext_length` i označava poslednji segment (zato se header može upisati tek na kraju, ili se `plaintext_length` i `last` drže u footer-u koji je u AAD poslednjeg segmenta — izbor implementacije, važno je da promena dužine posle finalize-a ne prođe).
- **Nonce jedinstvenost**: 8 B random prefiks po fajlu + 32-bit brojač daje 2^32 segmenata po fajlu (4 PiB na 1 MiB) i rizik kolizije prefiksa 2^-64 po paru fajlova pod istim FK — a FK je po fajlu, pa je i to teorija. Nikad ne ponovo koristiti FK za drugi fajl.
- **Dedup i CAS**: hash koji Vola čuva neka ostane hash **šifrata** (danas je tako, `File.hash` u `libs/vola/src/vola/models/file.py` je sha256 sačuvanih bajtova, deljen cross-tenant); hash čistog teksta se ne sme čuvati. Dedup šifrovanih fajlova ne postoji, ni ne treba.
- **Kompatibilnost sa Notes v1**: Notes blobovi (`nonce∥ct∥tag`, AAD `<file id>`) su zapravo „version 0, jedan segment, nonce sačuvan“; jsvola ih ne mora podržati, ali ako ikad bude uvozio thilo fajlove, dispatch po `v` je mesto gde to ulazi — još jedan razlog da se `v` čita.

### 6.9 Ostale stvari koje treba preuzeti doslovno

- **MIME iz bajtova** za slike (`crypto.py::sniff_image`), deklarisani tip samo kao čist `type/subtype`, SVG i aktivni tipovi nikad inline (`files.py::file_mime`, `_ACTIVE`).
- **Header-i odgovora**: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `inline` samo za sniff-ovane slike, inače `attachment` sa `filename*` (`files.py::served_headers`).
- **Redosled brisanja**: storage prvo, red posle; neuspeh storage-a = `502` i red ostaje; crypto-shred je uslov, purge higijena (`files.py::_drop_rows`, `_remove_blob`).
- **Imena i tipovi šifrovani**, storage vidi `<file id>.bin` + octet-stream; nikad ime u logu, metapodacima ili događaju.
- **Fiksna rečenica** za svaki integrity neuspeh (`409`), isti `423` za svaku vrstu lošeg tokena.
- **Preview brojeva** pre brisanja bez dešifrovanja (`delete-preview`), i rečenica o trajnosti u dijalogu.
- **Klijentski keš samo u memoriji**, opoziv na lock, generacioni brojač za zakasnele odgovore (`notesImages.ts`, `fileStore.ts`).

## Notes danas → predlog za jsvola

| Tema | Notes danas | Predlog za jsvola |
|---|---|---|
| Nivoi ključeva | pepper (host fajl) → KEK_pin / KEK_rec (Argon2id) → MK → FK (fajlovi); naslovi/tela direktno pod MK | isto, ali **sve** pod FK po fajlu; MK umotava samo FK-ove (rotacija MK = re-wrap 32 B po fajlu, bez re-šifrovanja sadržaja) |
| Ko umotava FK | samo MK keyring-a | pluggable: `tenant` (at-rest key fajl), `keyring` (PIN, Notes model), `caller` (ključ u header-u, ništa se ne čuva) |
| Čiji PIN | jedan keyring po `(tenant, user)`; nema per-file/folder | isto: keyring po principalu; „šifrovan folder“ je politika koja bira keyring, ne poseban ključ |
| Format bloba | `nonce(12) ∥ AES-256-GCM(ct ∥ tag)`, jedna poruka, AAD `<file id>` | header + segmenti po 1 MiB, nonce = 8 B prefiks ∥ indeks, AAD = header ∥ file id ∥ indeks ∥ last; v=1 dispečovan |
| Range / 206 | nema; ceo fajl u memoriji, klijent seek-uje u `blob:` | segmentni `206` u plaintext koordinatama, konstantna memorija, `Accept-Ranges` kao danas u Voli |
| Resumable upload | nema; `read(max+1)` celog tela | upload sesija po segmentima, nastavak od poslednjeg kompletnog |
| Limit | 15 MB (`THILO_NOTES_MAX_FILE_BYTES`) | po tenantu/konfiguraciji; segmentacija ukida razlog za mali limit |
| Server-side ili E2E | server-side; čist tekst preko TLS-a, MK u Redis-u Fernet-umotan | server-side v1.0; format dozvoljava `encryption: "client"` kasnije (opaque blob + klijentski `fk_ct`) |
| Unlock | token `token_urlsafe(32)` u Redis-u, klizni TTL 150 s, header `X-Notes-Unlock`, index set za `drop_all`, `/status` ne klizi, beacon `/unlock/close` bez JWT-a | isto, `X-Vola-Unlock`, TTL konfigurabilan; ključ u zahtevu samo za `caller` i samo server-ka-serveru |
| Brute force | brojač + `locked_until` u redu keyring-a, `SET NX` mutex 15 s, tabela 0/0/0/1/5/30…/1 h dupliranje, `429` i za tačan PIN | isto, doslovno |
| Recovery | 160 bita base32 8×4, jednom, normalizacija `0→O 1→I`, svoj salt, ne broji se, nov ključ posle recovery-ja | isto, doslovno |
| Reset | lozinka preko svc_tenants, pa crypto-shred svega i keyring-a | re-auth je obaveza pozivaoca (scope API ključa); jsvola radi shred |
| Rotacija peppera | ručno, prepend linije, lenji re-wrap pri unlock-u, stare linije zauvek | isto, plus alat koji prijavi koliko keyring-ova još zavisi od stare linije |
| MIME i thumbnail na storage-u | `application/octet-stream`, `<file id>.bin`, Vola `not-image`; sličice crta klijent iz celog bloba | isto za storage sloj; thumbnail/OCR samo kao šifrovani sibling pod istim FK, napravljen u zahtevu sa ključem, worker-i isključeni |
| Pretraga | dešifrovani naslovi u Pythonu pod unlock-om; tela i fajlovi nikad | isto ograničenje, otvoreno rečeno; nikad indeks čistog teksta |
| Share | nema; Download vlasnika jedini izlaz | opt-in share grant: FK ponovo umotan pod tajnu `S` iz linka (fragment), TTL/`max_downloads`/opoziv; isključen u `caller` modu |
| Dedup | nema (random FK i nonce); CAS hash = hash šifrata | isto; hash čistog teksta nikad |
| Brisanje | hard delete, Vola prvo (`purge` → fallback soft delete), `502` čuva red, crypto-shred uslov | isto; `purge` je nativan u jsvola, fallback nije potreban |
| Header-i odgovora | `no-store`, `nosniff`, `inline` samo sniff-ovane slike, inače `attachment; filename*` | isto |
| Verzija formata | `v: 1` pisan, nikad čitan | `v` čitan i dispečovan pri svakom decrypt-u |
| Autentifikacija strukture | `id_folder`, `cache.*`, `vola_file_idx` nisu pod AAD | `keyring_id`/`tenant_id` u AAD wrap-a FK; metapodaci fajla (ime, MIME, veličina) šifrovani pod FK sa AAD `<file id>:meta` |
