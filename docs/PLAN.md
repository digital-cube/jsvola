# JSVola: plan v1.0

> Root worktree chat, 2026-11-01. Kontekst je u `docs/ANALYSIS.md`, a odluke su iz questions tiketa
> TCKD7YDH3W. Model šifrovanja je iz `docs/notes-crypto-for-vola.md` (TCKMC6P9WP na projektu Thilo.AI,
> commit `83b89e508` na `thr1`; ovde je kopija). Svaki implementacioni tiket nosi svoju punu
> specifikaciju; ovaj dokument je mapa i ugovor koji im je zajednički.

## Odluke (TCKD7YDH3W)

| # | tema | odluka |
|---|---|---|
| 1 | API | **nov API, bez kompatibilnosti** sa vola-spp; potrošači prelaze na `@vola/client` |
| 2 | podaci | **čist start**, nema migracije iz vola-spp |
| 3 | stack | jsmemento 1:1: Node 24+, TS 5.9+, pnpm + Turbo, Biome, Vitest, Fastify 5, Drizzle + pg, ioredis, @jsudc/core + @jsudc/server, Commander.js, npm public, MIT |
| 4 | lookups | kopija u jsvola, `@vola/lookups`, isti format kao `@memento/lookups` |
| 5 | poslovi | **BullMQ** (Redis); worker je drugi proces iz `@vola/server` (`worker.ts`), ista slika |
| 6 | thumbnails | **sharp** → WebP 64/128/256/512 + crop režimi + **prva strana PDF-a** (pdftoppm); bez videa |
| 7 | OCR | v1.0, spawn `tesseract` + `pdftoppm` (binari u slici) |
| 8 | storage | samo lokalni FS, iza `StorageBackend` interfejsa |
| 9 | deploy | standalone kontejner (podman-compose) |
| 10 | scope | sve iz vola-spp + **šifrovani fajlovi** (PIN ili ključ, model thilo Notes) |
| 11 | upload | jedan multipart + **resumable upload u v1.0** |
| 12 | real-time | UDC subscribe preko WebSocket-a u v1.0 |
| 13 | audit | opciona memento integracija (`VOLA_MEMENTO_URL` + `VOLA_MEMENTO_API_KEY`) |
| 14 | examples | `apps/examples` + stage sa read-only demo ključem; hostname traži NON-AI tiket |
| 15 | paketi | `@vola/*` na npm; deploy ključ `github_jsvola` traži NON-AI tiket |

## Šifrovanje: usvojeno iz `notes-crypto-for-vola.md` §6

- **Ključ po fajlu (FK)**, nasumičnih 32 B, nikad ponovo korišćen. Sadržaj, izvedenice (thumbnail, OCR) i metapodaci (ime, MIME) su pod FK. Promena PIN-a, recovery, rotacija i crypto-shred menjaju samo umotani FK (`fk_ct`).
- **Tri wrap provider-a nad istim formatom bloba:** `tenant` (at-rest ključ iz `VOLA_KEY_FILE`, HKDF sa `tenant_id`), `keyring` (PIN: Argon2id 64 MiB / t=3 / p=1 + pepper → KEK → MK → FK, recovery ključ, kao Notes) i `caller` (32 B ključ u header-u `X-Vola-Content-Key` po zahtevu, server ga ne čuva; samo server-ka-serveru).
- **Server-side šifrovanje u v1.0.** Format mora da dozvoli `encryption: "client"` kasnije: nonce ne zavisi od serverske tajne, a AAD sadrži samo ono što klijent zna.
- **Segmentni format `JSV` v1:** header (magic, version, segment_size, nonce_prefix 8 B, plaintext_length) i segmenti od 1 MiB. Nonce je `prefix ∥ i`, AAD je `header ∥ file id ∥ i ∥ last`. Range/206 radi u plaintext koordinatama sa konstantnom memorijom, a resumable upload ide po segmentima. `v` se čita i dispečuje.
- **Keyring** je jedan po `(tenant, principal)`; principal je `X-User-Id`. Šifrovan folder je **politika** (podrazumevani keyring), ne poseban ključ.
- **Unlock token:** `token_urlsafe(32)` u Redis-u, klizni TTL (podrazumevano 150 s), header `X-Vola-Unlock`, index set za `drop_all`, `/status` ne klizi, beacon alias `/unlock/close`. MK je u Redis-u umotan pod key fajl.
- **Brute-force i recovery doslovno kao u Notes-u:** tabela 0/0/0/1 s/5 s/30 s×5/1 h pa dupliranje, `SET NX` mutex, `429` čak i za tačan PIN dok traje lock, recovery 8×4 base32 prikazan jednom, normalizacija `0→O 1→I`.
- **Šifrovan fajl:** nema dedup-a (CAS hash = hash šifrata, hash čistog teksta se nikad ne čuva), storage vidi `application/octet-stream`, `is_global_public` je zabranjen, odgovori imaju `no-store` + `nosniff`, `inline` samo za sniff-ovane slike. Worker preskače šifrovane fajlove. Thumbnail i OCR su šifrovani „sibling“ blobovi pod istim FK, napravljeni u zahtevu koji drži ključ.
- **Share šifrovanog fajla** je opt-in „share grant“: FK ponovo umotan pod tajnu `S` iz fragmenta linka (`/vola/s/<id>#<S>`). Opoziv je brisanje reda. Nije moguć u `caller` modu.
- **Greške:** integrity → `409 vola_integrity` (fiksna rečenica); svaki loš ili istekao token → `423 vola_locked`; zaključan keyring → `429` + `Retry-After`. Nikad ime, PIN, ključ ni token u logu, metapodacima, memento događaju ili URL-u.

## Zajednički ugovor API-ja (svi tiketi ga poštuju)

Fastify plugin `volaPlugin` montira sve pod prefiks `/vola` (konfigurabilan); `server.ts` ga montira
standalone. Greške su `{error: {code, message}}`; kodovi su snake_case i stabilni.

- **Auth:** `Authorization: Bearer <key>` ili `X-Api-Key`, WebSocket subprotocol `bearer.<key>` (kao jsmemento). Ključ je `vola_live_…` / `vola_test_…` / `vola_admin_…`; čuva se samo SHA-256. Admin ključ (bez tenant-a) bira tenant preko `X-Tenant-Slug`. `X-User-Id` je principal (atribucija, keyring).
- **Scope-ovi:** `files:read`, `files:write`, `folders:read`, `folders:write`, `shares:write`, `keys:write`, `keyrings:write`, `admin`.
- **Rute (v1):**
  - `GET /vola/health/live|ready`
  - `POST|GET /vola/keys`, `DELETE /vola/keys/:id`
  - `POST /vola/files/:type/:id` (multipart), `PUT /vola/files/:type/:id/slug/:slug`
  - `GET|HEAD /vola/files/:type/:id/:fileId` (Range), `…/path/*`, `…/slug/:slug`, `…/:fileId/info` (+ `ocr` block, `?ocr=full`, 4.2), `…/:fileId/thumb/:size?crop=` (200 ready / 202 generating, 4.1)
  - `PATCH /vola/files/:type/:id/:fileId` (`{folder_path?, is_public?, is_global_public?, filename?}`), `DELETE …/:fileId` (soft), `DELETE …/:fileId/purge`
  - `POST|GET|PATCH|DELETE /vola/folders/:type/:id/*path`
  - `POST /vola/uploads`, `HEAD|PATCH|DELETE /vola/uploads/:uploadId` (tus 1.0 core semantika, implementirana nativno)
  - `POST|GET /vola/shares`, `GET|DELETE /vola/shares/:id`, `GET|HEAD /vola/s/:token[/path/*]` (bez auth-a; 5.1)
  - `GET|HEAD /vola/public/:fileId`
  - `GET /vola/stats/tenant|storage`, `GET /vola/stats/instance/:type/:id`, `GET /vola/instance-types`, `GET /vola/lookups`
  - `POST /vola/admin/transfer`
  - `/vola/keyrings…` (faza 6.2)
  - `/vola/udc/*` (`@jsudc/server` plugin) i `GET /vola/udc/subscribe` (WS subscribe; `@jsudc/server` 0.2 nema transport za `capabilities.subscribe`, pa je transport vola-in, `docs/REALTIME.md`)
- **Tabele** imaju prefiks `vola_`. Drizzle migracije su u gitu (`packages/server/drizzle`).

## Faze i tiketi

Redom, jedan runner, na jsvola worktree-u. Brojevi su `<faza>.<deo>`; svaki tiket nabraja od čega zavisi.

| # | tiket | suština |
|---|---|---|
| 1.1 | TCKW73Q7EJ | Scaffold monorepo, compose, Dockerfile, CI, health, config |
| 1.2 | TCKMP7M57K | Tenant, API ključevi, auth, scope-ovi, CLI, `/vola/keys` |
| 2.1 | TCK5HPYMY2 | CAS storage, streaming upload, download sa Range/HEAD, slug, soft delete, purge |
| 2.2 | TCKM5DHJTH | Folderi, move, verzije, visibility, `/vola/public` |
| 2.3 | TCKNPKC9XY | Resumable upload (`/vola/uploads`) |
| 3.1 | TCKUHMFRRQ | `@vola/lookups`, UDC kolekcija `files`, instance-types |
| 3.2 | TCKFQMCFDT | Real-time: UDC subscribe preko WebSocket-a |
| 4.1 | TCKXQCJ2YY | BullMQ worker, processing jobs, thumbnails (slike + PDF) |
| 4.2 | TCKPK3YTKR | OCR (tesseract + pdftoppm), `vola_file_metadata` |
| 5.1 | TCKKQHMDJT | Share linkovi + statistika |
| 5.2 | TCK59T5P65 | Admin transfer + memento audit |
| 6.1 | TCKK5UTHJX | Šifrovanje I: format `JSV`, FK, `tenant` provider, šifrovan upload/download/Range |
| 6.2 | TCKFT692JH | Šifrovanje II: keyring (PIN), unlock, brute-force, recovery, reset, šifrovani folderi |
| 6.3 | TCKQ7JWCRJ | Šifrovanje III: `caller` provider, šifrovan resumable, šifrovani thumbnail/OCR, share grant |
| 7.1 | TCKX7RMHKF | `@vola/client` SDK |
| 7.2 | TCK9NUHWW6 | `@vola/react` |
| 8.1 | TCKKR2PUDE | `apps/examples` + stage compose |
| 8.2 | TCKT9JUU59 | Dokumentacija + npm release |
| 9.1 | TCKQQ7PD5C | `apps/website`: prezentacioni sajt (Astro + Starlight) na `stage.vol-a.com`, `deploy/website/stage.sh`; examples samo na `examples.stage.vol-a.com` |

NON-AI: TCK3X3K3UM (deploy ključ `github_jsvola`), TCK9D5KENM (stage hostname, DNS i `.env` za examples), TCK2J3WUWW (npm organizacija `@vola`, `NPM_TOKEN`, tag `v1.0.0`).

## Stage (2026-11-02)

Faze 1–8 su spojene u `main` i podignute: `https://stage.vol-a.com` (edge `hetzner4` → VM `igor.digitalcube.work`,
checkout `/home/digital/sites/stage.vol-a.com`, compose projekat `jsvola-stage`). Detalji i postupak za redeploy su u
komentaru na TCK9D5KENM. Posle 9.1 `stage.vol-a.com` je prezentacioni sajt, a examples ostaje samo na `examples.stage.vol-a.com`.
