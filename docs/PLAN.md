# JSVola: plan v1.0

> Root worktree chat, 2026-11-01. Kontekst je u `docs/ANALYSIS.md`, odluke su iz questions tiketa
> TCKD7YDH3W (odgovoren i rešen istog dana). Svaki implementacioni tiket nosi svoju punu
> specifikaciju; ovaj dokument je mapa.

## Odluke (TCKD7YDH3W)

| # | tema | odluka |
|---|---|---|
| 1 | API | **nov API, bez kompatibilnosti** sa vola-spp; potrošači prelaze na `@vola/client` |
| 2 | podaci | **čist start**, nema migracije iz vola-spp |
| 3 | stack | jsmemento 1:1: Node 24+, TS 5.9+, pnpm + Turbo, Biome, Vitest, Fastify 5, Drizzle + pg, ioredis, @jsudc/core + @jsudc/server, Commander.js, npm public, MIT |
| 4 | lookups | kopija u jsvola, `@vola/lookups`, isti format kao `@memento/lookups` |
| 5 | poslovi | **BullMQ** (Redis); worker je drugi proces iz istog paketa/slike, ne poseban paket |
| 6 | thumbnails | **sharp** → WebP 64/128/256/512, isti crop režimi + **prva strana PDF-a** (pdftoppm); bez videa |
| 7 | OCR | v1.0, spawn `tesseract` + `pdftoppm` (binari u slici) |
| 8 | storage | samo lokalni FS, iza `StorageBackend` interfejsa (S3 kasnije) |
| 9 | deploy | standalone kontejner (podman-compose) |
| 10 | scope | **sve**: upload/download (Range, HEAD, inline), slug, folderi + move, UDC, verzije + visibility + public, share linkovi, statistika, soft delete + purge, admin transfer, thumbnails, OCR, ključevi preko API-ja, **plus šifrovani fajlovi (PIN ili ključ, kao thilo Notes)** |
| 11 | upload | jedan multipart + **resumable upload već u v1.0** |
| 12 | real-time | da, UDC subscribe preko WebSocket-a (lista i `processing_status` bez polling-a) |
| 13 | audit | opciona memento integracija (`VOLA_MEMENTO_URL` + ključ): destruktivne operacije su memento eventi |
| 14 | examples | `apps/examples` + stage sa read-only demo ključem; **hostname nije dat** |
| 15 | paketi | `@vola/*` na npm; treba deploy ključ `github_jsvola` |
| + | sigurno | MIT, Fastify, React, Postgres; CAS + dedup između tenant-a, soft delete, stroga izolacija; `instance_type` + `instance_id` (UUID) je srce modela |

## Paketi

`@vola/core` (Zod šeme, tipovi, scope-ovi), `@vola/lookups`, `@vola/server` (Fastify plugin + `server.ts`
+ `worker.ts`, Drizzle, CAS, UDC source, BullMQ), `@vola/cli`, `@vola/client` (fetch SDK, resumable
upload, enkripcija na klijentu ako se izabere), `@vola/react` (browser fajlova, upload, thumbnail renderer
za `@jsudc/react`), `packages/e2e`, `apps/examples`.

## Faze, odnosno implementacioni tiketi

Redom, jedan runner, na jsvola worktree-u. Svaka faza se oslanja na prethodne.

| # | faza | suština | zavisi od |
|---|---|---|---|
| 1 | Scaffold | monorepo kao jsmemento (pnpm/turbo/biome/vitest, tsconfig-i, `@vola/source` condition), `compose.yaml` (postgres + redis), Dockerfile (node 24 + vips + tesseract + poppler), CI, `/vola/health/{live,ready}`, config (`VOLA_*`) | — |
| 2 | Tenant + ključevi | `vola_tenant`, `vola_apikey` (SHA-256, prefix, scopes `files:read/write`, `folders:*`, `shares:*`, `admin`), auth (Bearer, `X-Api-Key`, WS subprotocol), admin ključ + `X-Tenant-Slug`, CLI create-tenant/create-key/list/revoke/migrate, `POST/GET/DELETE /vola/keys` | 1 |
| 3 | CAS + fajlovi | `StorageBackend` + FS (`aa/bb/cc/<sha256>`), streaming multipart upload sa SHA-256 u letu → temp → atomičan rename, dedup, collision rename, MIME sniff (`file-type`), download sa Range/206/416, HEAD, inline/attachment, slug upsert, soft delete, purge (blob tek kad ga niko ne referencira), `X-User-Id` atribucija. Šema već ima kolone za enkripciju (vidi niže) | 2 |
| 4 | Folderi + verzije | virtuelni folderi (create sa parent lancem, list, recursive delete, rename sa kaskadom), move, `parent` lanac verzija, visibility (`is_public`, `is_global_public`), `GET /vola/public/:id` | 3 |
| 5 | Resumable upload | **tus 1.0** (`@tus/server` + FS store u `VOLA_STORAGE_PATH/.uploads`) ili sopstveni chunked protokol (vidi otvoreno pitanje), završetak upload-a ide kroz isti put kao faza 3, čišćenje napuštenih upload-a | 3 |
| 6 | UDC + real-time | `files` kolekcija (describe/list/read, filteri instance_type/instance_id/folder/filename/mime/kind, cursor), `instance-types`, lookups, **subscribe** (WS) koji gura promene liste i `processing_status` | 4 |
| 7 | Worker + thumbnails | BullMQ red, `vola_processing_job`, `worker.ts` proces, `VOLA_WORKER_ENABLED` auto/1/0 kao vola-spp, sharp WebP 64–512 + crop, PDF prva strana, `/thumb/:size` 200 / 202 placeholder | 6 |
| 8 | OCR | tesseract + pdftoppm (eng+srp+deu, lookups `OcrLanguages`), `vola_file_metadata` | 7 |
| 9 | Share + statistika | share linkovi (token, argon2 lozinka, istek, max_downloads, revoke; `EMAIL`/`TENANT` = 501), `vola_tenant_stats` (tenant, instanca, storage, recompute) | 4 |
| 10 | Transfer + audit | `POST /vola/admin/transfer` (instance, verzije, spajanje foldera, share tokeni ostaju, `user_map`, stats recompute); memento audit (delete, purge, visibility, revoke, transfer, share) kroz opcioni klijent | 9 |
| 11 | Šifrovani fajlovi | vidi odeljak niže; **čeka odluke** | 3, 5, 7 |
| 12 | `@vola/client` + `@vola/react` | SDK za sve rute + resumable + (klijentska enkripcija), React browser fajlova na `@jsudc/react` | 6, 11 |
| 13 | Examples + stage | `apps/examples` po uzoru na memento examples (upload, browser, thumbnails, share, resumable, šifrovani fajl), compose profil `demo`, read-only demo ključ; **hostname nije dat** | 12 |
| 14 | Docs + release | README, API.md, DEPLOYMENT.md, CLI.md, CHANGELOG, `release.yml` za npm | 13 |

Paralelno, NON-AI: deploy ključ `github_jsvola` (repo `digital-cube/jsvola`, write) u `~/work/deployment-keys`
i alias u `~/.ssh/config.local`.

## Šifrovani fajlovi: predlog i otvorena pitanja

Uzor je thilo Notes (TCKMHYMN37, TCK5HKCWWH): PIN nikad ne šifruje sadržaj direktno. Svaki fajl ima
svoj nasumični ključ `FK` (AES-256-GCM), a `FK` je umotan u ključ koji štiti PIN ili ključ pozivaoca.
Promena PIN-a samo ponovo umotava ključ. Brisanje umotanog `FK` je crypto-shred, pa je blob nečitljiv
čak i kad ostane na disku.

Šta to znači za ostale delove vole (važi za svaki izbor ispod):

- **Bez dedup-a:** šifrat je drugačiji za svaki fajl, pa CAS hash ide po šifratu i blob se ne deli.
- **Thumbnail i OCR:** na serveru ih nema, ili se prave dok je plaintext u memoriji i čuvaju se šifrovani pod istim `FK`.
- **Range download:** traži šifrovanje u segmentima (npr. 64 KiB, AES-GCM po segmentu, nonce = prefiks + broj segmenta, AAD = file id + indeks + oznaka poslednjeg), da bi se dešifrovao samo traženi opseg.
- **MIME i ime:** blob se čuva kao `application/octet-stream`. Pravo ime i MIME su šifrovani.
- **Public i share:** `is_global_public` je zabranjen. Share link radi samo uz ključ ili PIN koji primalac zna, ili nije dozvoljen.
- **Transfer:** umotani ključevi idu zajedno sa redovima. Za PIN vezan za korisnika treba ponovo umotavanje.

Otvorena pitanja (za drugi questions tiket):

1. Gde se šifruje: na serveru (vola vidi plaintext u prolazu, kao svc_notes) ili na klijentu, E2E u `@vola/client` sa WebCrypto (vola nikad ne vidi plaintext)?
2. Čiji je PIN: korisnikov (`X-User-Id`, keyring po korisniku kao u Notes), PIN po fajlu ili folderu, ili oba?
3. „Ključ“ je: ključ koji pozivalac šalje po zahtevu (header, server ga ne čuva), ključ tenant-a koji vola čuva (at-rest), ili oba?
4. Za server-side: otključavanje kao Redis token sa kliznim TTL-om (Notes: 150 s, `X-Notes-Unlock`) ili ključ/PIN u svakom zahtevu?
5. Recovery ključ i brute-force zaštita (pokušaji, `locked_until`) kao u Notes?
6. Thumbnail i OCR za šifrovane fajlove: ništa, ili šifrovani thumbnail/OCR pod `FK`?
7. Share link za šifrovan fajl: zabranjen, ili PIN/ključ deljenja?
