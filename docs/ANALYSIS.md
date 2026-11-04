# JSVola: analiza i arhitekturni pregled

> Napisano u Root worktree chat-u, 2026-11-01. Isti postupak kao `jsmemento/docs/ANALYSIS.md`
> (memento-spp → jsmemento), primenjen na vola-spp → jsvola. Odluke se traže u questions tiketu
> "JSVola: arhitekturne odluke i scope v1.0"; ovaj dokument je kontekst za njega.

## 1. Cilj

JSVola je JavaScript/TypeScript port **vola-spp**: multi-tenant content-addressable (CAS) skladište
fajlova. Fajlovi su organizovani po `tenant + (instance_type, instance_id) + virtuelna putanja foldera`,
a bajtovi su na disku deduplikovani po SHA-256. Model je isti kao kod jsmemento: TS monorepo, npm paketi,
Fastify + Drizzle + Postgres, UDC kao glavni način pregledanja i kontejner kao prvi način deploy-a.

Izvori:

- vola-spp: `github.com/digital-cube/vola-spp` (`main` @ `454077d`, 49 commit-ova), kloniran ključem
  `deployment-keys/github_vola` (SSH alias `github-vola`)
- jsmemento (`origin/main`, 30 commit-ova) kao referentni port: `packages/{core,server,react,cli,lookups,e2e}`,
  `apps/{example,examples}`
- jsmemento odluke: questions tiket TCKP3JCT29 (projekat jsmemento), `docs/SERVICE.md` (TCK7DQTP27)

## 2. vola-spp: šta postoji

### 2.1 Stack

Python 3.14, FastAPI, Tortoise ORM + Aerich, asyncpg, Pydantic, Typer + Rich, structlog, Pillow,
`dc-lookups`, `udc-py` v0.3.1. Opcioni dodatak `vola[worker]`: Celery + Redis + pytesseract + pdf2image.
Dodatak `files`: boto3, u kodu se ne koristi. Frontend je React 19 + Vite + Tailwind + `@udc/react`
(jedna demo aplikacija). 287 testova + 1 preskočen, prag pokrivenosti 80 %. Backend ima oko 6 900 linija
Pythona (bez migracija); najveći su `services/files.py` (801), `api/files.py` (566),
`services/folders.py` (361), `udc/file_source.py` (328) i `api/transfer.py` (295).

### 2.2 Model podataka (`vola_*` tabele)

| tabela | suština |
|---|---|
| `vola_tenant` | slug, name, aktivan |
| `vola_api_key` | SHA-256 hash, `key_prefix` `vola_live` / `vola_test` / `vola_admin`, `key_last4`, `scopes` (JSON lista), `is_admin` (tenant = NULL → cross-tenant), `is_active` |
| `vola_file` | `tenant`, `instance_type` (str), `instance_id` (**UUID**), `slug` (jedan živ fajl po slug-u), `hash`, `filename`, `extension`, `size`, `mime_type`, `metadata` (JSON), `folder` (NULL = root), `parent` (lanac verzija), `is_public`, `is_global_public`, `created_by` / `deleted_*` / `last_accessed_*` (iz `X-User-Id`), soft delete |
| `vola_folder` | virtuelna hijerarhija, path je jedinstven po instanci, soft delete, kaskadni rename |
| `vola_share_link` | token, lozinka (bcrypt), `expires_at`, `max_downloads`, scope (`PUBLIC_LINK`; `TENANT` / `INSTANCE_VIEWERS` / `EMAIL` vraćaju 501), `revoked_at` |
| `vola_processing_job` | `THUMBNAIL` / `OCR` / (`AI_SUMMARY`, `EXIF` postoje samo u lookups) × `PENDING→RUNNING→DONE/FAILED/SKIPPED` |
| `vola_file_metadata` | sidecar, npr. OCR tekst |
| `vola_tenant_stats` | snapshot agregati po tenant-u i po instanci (`by_kind`, ukupni bajtovi, najstariji/najnoviji) |

CAS raspored na disku: `aa/bb/cc/<sha256>.<ext>`, atomičan upis i zaštita od path traversal-a.
Thumbnail-i su WebP u veličinama 64/128/256/512 sa crop opcijama. Blob se deli između tenant-a. Purge
briše blob tek kad ga više nijedan red, ni u jednom tenant-u, ne referencira.

### 2.3 HTTP površina (`main`)

- `POST /api/v1/files/{type}/id/{id}` (multipart, opciono `folder_path` / `folder_id` / `parent_id`),
  `PUT …/slug/{slug}` (upsert imenovanog fajla, npr. `bp/…/slug/profile_image`)
- Download `GET` + `HEAD` na `…/id/{file_id}`, `…/path/{path}`, `…/slug/{slug}`: Range / 206 / 416
  (`_byte_range.py`), inline disposition za slike i video, `X-File-Hash`
- `…/info`, `…/thumb/{size}?crop=` (200 = gotov thumbnail, **202 = sivi placeholder dok worker radi**),
  `PATCH …/visibility`, `PATCH …/move`, `DELETE` (soft), `DELETE …/purge`
- Folderi: `POST/GET/DELETE/PATCH /api/v1/folders/{type}/id/{id}/path/{path}`
- Share linkovi: `POST /api/v1/share`, `DELETE /api/v1/share/id/{id}`,
  `GET|HEAD /share/token/{t}[/download|/path/{p}]` (bez auth-a)
- `GET|HEAD /public/file/{id}` (anonimno, samo za `is_global_public`)
- Statistika: `/api/v1/stats/tenant`, `…/instance/{type}/id/{id}`, `…/storage`
- `GET /api/v1/instance-types`, `/api/v1/keys` (izdavanje ključa), `POST /api/v1/admin/transfer`
  (premeštanje instanci među tenant-ima sa `user_map`; spajanje foldera; share tokeni ostaju isti)
- UDC: `POST /udc/list|describe|read`, `GET /api/lookups`
- Auth: `X-API-Key`. Admin ključ cilja tenant preko `X-Tenant-Slug`. Tenant i ključ se prenose kroz
  `ContextVar`.

### 2.4 Odloženo u vola-spp (STATUS.md)

E-mail share, scope-ovi `TENANT` i `INSTANCE_VIEWERS`, S3/MinIO backend (interfejs postoji), Celery beat
za statistiku, UDC `subscribe` (WebSocket), audit log destruktivnih operacija, rate limiting, granularni
scope-ovi, production compose.

### 2.5 Ko koristi vola danas

Pretraga po `~/work` nalazi pozive vola API-ja u projektima **thilo.ai** (ima i ugrađenu kopiju
`libs/vola`), **opencon**, **vigiles**, **hotels**, **dclabs**, **dclabstpl**, **mementoservice** i
**tplbuilder-2**. Najčešće se zovu `/udc/list`, `/api/v1/files/…`, `/api/v1/share`, `/api/v1/folders/…`,
`/api/v1/stats/*`, `…/visibility`, `…/slug/profile_image`, `/share/token/…` i `/api/v1/instance-types`.
**To je najveća razlika u odnosu na memento:** vola ima žive potrošače, pa je pitanje kompatibilnosti
žice i podataka prva odluka (Q1, Q2).

## 3. Šta jsmemento već rešava (i šta se nasleđuje)

Odluke iz TCKP3JCT29 i stanje na `jsmemento/main`: Node 24+, TypeScript 5.9+, pnpm + Turbo, Biome,
Vitest, Fastify 5, Drizzle + `pg`, ioredis, `@jsudc/core` 0.2.0 + `@jsudc/server` 0.2.1, Commander.js,
sopstveni paket `@memento/lookups` (YAML + CSV + recorder kandidata), kontejner kao prvi način deploy-a,
npm public, MIT. Zatim stage `examples.` sajt sa read-only demo ključem, pa `service.` sajt za
samouslužnu registraciju (SERVICE.md).

Predlog: sve ovo se preuzima 1:1, osim tamo gde vola ima nešto čega memento nema.

## 4. Gde vola traži nove odluke

| tema | vola-spp | JS kandidati |
|---|---|---|
| upload | python-multipart, ceo fajl | `@fastify/multipart` streaming + SHA-256 u letu, privremeni fajl, pa atomičan rename u CAS |
| byte-range / HEAD | `_byte_range.py` | sopstvena implementacija ili `@fastify/static`-like `send` |
| thumbnails | Pillow → WebP | **sharp** (libvips) |
| OCR | Tesseract + pdf2image | spawn `tesseract` + `pdftoppm`, **tesseract.js** (WASM), ili odložiti |
| background poslovi | Celery + Redis, opciono | **BullMQ** (Redis), **pg-boss** (Postgres) ili samo in-process |
| storage backend | FS (S3 interfejs spreman) | FS v1.0; S3/MinIO preko `@aws-sdk/client-s3` kasnije ili odmah |
| share lozinke | bcrypt | `argon2` (kao service u jsmemento) ili `bcrypt` (kompatibilno sa postojećim hash-evima) |
| MIME detekcija | ekstenzija + sniff | `file-type` (magic bytes) + `mime-types` |
| real-time | nema | UDC subscribe preko WebSocket-a (`@jsudc/server` ga podržava) |
| audit | nema | destruktivne operacije kao memento eventi (vola → jsmemento) |

## 5. Predložena struktura (po uzoru na jsmemento)

```
jsvola/
├── packages/
│   ├── core/       @vol-a/core     — Zod šeme, tipovi, ključ/scope helperi, lookups imena
│   ├── server/     @vol-a/server   — Fastify plugin + server, Drizzle šema, CAS storage, UDC source
│   ├── worker/     @vol-a/worker   — thumbnails/OCR/stats poslovi (ako se izdvaja; vidi Q5)
│   ├── client/     @vol-a/client   — fetch SDK (upload, download, share, folders)
│   ├── react/      @vol-a/react    — file browser, upload dugme, thumbnail renderer za @jsudc/react
│   ├── cli/        @vol-a/cli      — create-tenant, create-key, list/revoke, migrate, transfer
│   ├── lookups/    (zajednički sa memento? vidi Q4)
│   └── e2e/
├── apps/
│   └── examples/   stage sajt sa primerima (kao examples.stage.memento-service.org)
├── lookups.yaml  i18n/translations.csv  compose.yaml  Dockerfile  turbo.json
```

## 6. Sledeći koraci

1. ✅ Analiza (ovaj dokument)
2. 📋 Questions tiket: odluke Q1–Q15
3. 📐 `docs/PLAN.md`: faze i implementacioni tiketi na osnovu odgovora
4. 🏗️ Scaffolding (monorepo, CI, compose), pa faze
