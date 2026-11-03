import type { Messages } from "@jsudc/react";

/**
 * The site's strings, layered over `@vola/react`'s (`VOLA_MESSAGES`) and `@jsudc/react`'s:
 * `APP` (the shell), `MENU` (the labels of menu.yaml's `translation_key`s, `MENU_BROWSE` →
 * `MENU.BROWSE`), one section per page, and `COLLECTIONS` (the `udc:collections` leaves).
 */
export const EXAMPLES_MESSAGES: Messages = {
  APP: {
    NAME: { en: "vola", sr: "vola" },
    TAGLINE: { en: "examples", sr: "primeri" },
    NAV_MENU: { en: "Examples menu", sr: "Meni primera" },
    LANGUAGE: { en: "Language", sr: "Jezik" },
    SETTINGS: { en: "Settings", sr: "Podešavanja" },
    BASE_URL: { en: "API base URL", sr: "Osnovni URL API-ja" },
    API_KEY: { en: "API key", sr: "API ključ" },
    INSTANCE: { en: "Instance (type / id)", sr: "Instanca (tip / id)" },
    INSTANCE_HINT: {
      en: "Empty: the demo instance the server names.",
      sr: "Prazno: demo instanca koju server imenuje.",
    },
    VISITOR: { en: "Visitor id", sr: "ID posetioca" },
    VISITOR_HINT: {
      en: "Your X-User-Id for this tab: the owner of your uploads and of your keyring on the Encrypted files page, purged with them after {hours} h. A new identity cannot change what the old one made.",
      sr: "Vaš X-User-Id za ovaj tab: vlasnik vaših upload-ova i vašeg keyring-a na stranici Šifrovani fajlovi, briše se sa njima posle {hours} h. Novi identitet ne može da menja ono što je stari napravio.",
    },
    NEW_VISITOR: { en: "New identity", sr: "Novi identitet" },
    CONNECT: { en: "Connect", sr: "Poveži" },
    FORGET_KEY: { en: "Use the demo key", sr: "Koristi demo ključ" },
    KEY_DEMO: { en: "demo key", sr: "demo ključ" },
    KEY_OWN: { en: "your key", sr: "vaš ključ" },
    KEY_NONE: { en: "no key", sr: "nema ključa" },
    KEY_PENDING: { en: "connecting…", sr: "povezivanje…" },
    TENANT: { en: "tenant {tenant}", sr: "tenant {tenant}" },
    DEMO_HINT: {
      en: "The server's read-only demo key (files:read, folders:read). Writes go through the server's write proxy. Paste your own key to replace it.",
      sr: "Serverov demo ključ samo za čitanje (files:read, folders:read). Upisi idu kroz serverov write proxy. Nalepite svoj ključ da biste ga zamenili.",
    },
    NO_KEY: {
      en: "This server hands out no demo key (VOLA_EXAMPLES is off). Paste an API key (vola create-key --tenant demo --name me) and press Connect.",
      sr: "Ovaj server ne daje demo ključ (VOLA_EXAMPLES je isključen). Nalepite API ključ (vola create-key --tenant demo --name me) i pritisnite Poveži.",
    },
    WRITE_KEY_NEEDED: {
      en: "Writing needs a key with the write scopes: the server's write proxy is off and the key in use is yours. Paste a key with files:write in Settings.",
      sr: "Za upis treba ključ sa write opsezima: serverov write proxy je isključen, a ključ u upotrebi je vaš. Nalepite ključ sa files:write u Podešavanjima.",
    },
    SEED_HINT: {
      en: "The demo instance is empty: the seeder has not run. Start it with",
      sr: "Demo instanca je prazna: seeder nije pokrenut. Pokrenite ga sa",
    },
    COPY: { en: "Copy", sr: "Kopiraj" },
    COPIED: { en: "Copied", sr: "Kopirano" },
    LOADING: { en: "Loading…", sr: "Učitavanje…" },
    ERROR: { en: "Error: {message}", sr: "Greška: {message}" },
    REFRESH: { en: "Refresh", sr: "Osveži" },
    FILE: { en: "File", sr: "Fajl" },
    OPEN_BROWSE: { en: "Open in Browse →", sr: "Otvori u Pregledu →" },
  },
  MENU: {
    EXAMPLES: { en: "Examples", sr: "Primeri" },
    BROWSE: { en: "Browse", sr: "Pregled" },
    UPLOAD: { en: "Upload", sr: "Upload" },
    THUMBNAILS: { en: "Thumbnails", sr: "Sličice" },
    STREAMING: { en: "Range & streaming", sr: "Range i striming" },
    SHARE: { en: "Share", sr: "Deljenje" },
    ENCRYPTED: { en: "Encrypted files", sr: "Šifrovani fajlovi" },
    API: { en: "API", sr: "API" },
    COLLECTIONS: { en: "Collections", sr: "Kolekcije" },
  },
  BROWSE: {
    TITLE: { en: "Browse", sr: "Pregled" },
    SUBTITLE: {
      en: "VolaFileBrowser over the demo instance · the files UDC collection · live through /udc/subscribe",
      sr: "VolaFileBrowser nad demo instancom · UDC kolekcija files · uživo kroz /udc/subscribe",
    },
    NOTE: {
      en: "Folders, breadcrumbs, search and filters, thumbnails, the row menu (download, rename, move, delete, versions, share, visibility) and a drop zone. The seeded files and other visitors' files are read-only for you; what you upload is yours for {hours} hours, in this tab, which holds your visitor id. Open another tab, a new visitor: a change here shows there without a reload.",
      sr: "Folderi, putanja, pretraga i filteri, sličice, meni reda (preuzmi, preimenuj, premesti, obriši, verzije, deli, vidljivost) i zona za prevlačenje. Seed fajlovi i fajlovi drugih posetilaca su za vas samo za čitanje; ono što vi otpremite vaše je {hours} sati, u ovom tabu, koji čuva vaš ID posetioca. Otvorite drugi tab, novog posetioca: promena ovde vidi se tamo bez osvežavanja.",
    },
  },
  UPLOAD: {
    TITLE: { en: "Upload", sr: "Upload" },
    SUBTITLE: {
      en: "one multipart POST under {threshold} · resumable (tus) above it, with progress, cancel and resume",
      sr: "jedan multipart POST ispod {threshold} · resumable (tus) iznad toga, sa napretkom, prekidom i nastavkom",
    },
    LIMITS: { en: "The demo's limits", sr: "Ograničenja demoa" },
    LIMIT_SIZE: { en: "up to {max} per file", sr: "do {max} po fajlu" },
    LIMIT_TYPES: {
      en: "images, PDF, short video and audio, plain text, Markdown",
      sr: "slike, PDF, kratak video i audio, čist tekst",
    },
    LIMIT_TTL: { en: "purged after {hours} h", sr: "briše se posle {hours} h" },
    LIMIT_RATE: {
      en: "{count} writes per {minutes} min per address",
      sr: "{count} upisa na {minutes} min po adresi",
    },
    HOW: {
      en: "The visitor's key is read-only. Each upload below goes to POST /vola/examples/write/… without a key; the server checks the size and type, replays it under its own write key and attributes it to your visitor id. A file above {threshold} goes through /uploads in {chunk} chunks: cancel it half-way and resume — the server keeps the offset, the browser the fingerprint, so a reload resumes too.",
      sr: "Ključ posetioca je samo za čitanje. Svaki upload ispod ide na POST /vola/examples/write/… bez ključa; server proverava veličinu i tip, ponavlja ga pod svojim write ključem i pripisuje ga vašem ID-u posetioca. Fajl veći od {threshold} ide kroz /uploads u delovima od {chunk}: prekinite ga na pola i nastavite — server čuva offset, pregledač otisak, pa i osvežavanje stranice nastavlja.",
    },
    DROP: { en: "Drop files here, or", sr: "Prevucite fajlove ovde, ili" },
    FOLDER: { en: "They land in the folder", sr: "Završavaju u folderu" },
    DONE: { en: "Uploaded", sr: "Otpremljeno" },
  },
  THUMBS: {
    TITLE: { en: "Thumbnails", sr: "Sličice" },
    SUBTITLE: {
      en: "GET …/thumb/:size?crop= · 64, 128, 256, 512 · cover, fit, attention · 202 while the worker renders, then 200",
      sr: "GET …/thumb/:size?crop= · 64, 128, 256, 512 · cover, fit, attention · 202 dok worker renderuje, zatim 200",
    },
    PICK: { en: "File", sr: "Fajl" },
    REGENERATE: { en: "Regenerate", sr: "Regeneriši" },
    REGENERATING: { en: "Dropping the renditions…", sr: "Brišem renderovane sličice…" },
    REGENERATED: {
      en: "{count} rendition(s) dropped: every tile below asks again — 202 and a placeholder first, 200 when the worker is done.",
      sr: "Obrisano: {count}. Svaka pločica ispod pita ponovo — prvo 202 i placeholder, 200 kad worker završi.",
    },
    NO_WORKER: {
      en: "This server renders inline (no worker): you will see 200 straight away.",
      sr: "Ovaj server renderuje odmah (nema worker-a): videćete 200 bez čekanja.",
    },
    STATE: { en: "state", sr: "stanje" },
    NONE: {
      en: "No image or PDF in the demo instance yet.",
      sr: "U demo instanci još nema slike ni PDF-a.",
    },
    HOW: {
      en: "VolaThumb fetches the rendition with the key in a header into a blob: URL; a 202 is never cached and is retried with backoff (1, 2, 4… s). cover fills the square, fit keeps the whole picture, attention centres on the busiest part. A PDF gives its first page; text has none (404 → placeholder).",
      sr: "VolaThumb dohvata sličicu sa ključem u zaglavlju u blob: URL; 202 se nikad ne kešira i ponavlja se sa odlaganjem (1, 2, 4… s). cover popunjava kvadrat, fit čuva celu sliku, attention centrira najzanimljiviji deo. PDF daje prvu stranu; tekst nema sličicu (404 → placeholder).",
    },
  },
  STREAM: {
    TITLE: { en: "Range & streaming", sr: "Range i striming" },
    SUBTITLE: {
      en: "<video> and <audio> on GET /public/:id · the browser asks with Range, the server answers 206",
      sr: "<video> i <audio> nad GET /public/:id · pregledač traži sa Range, server odgovara 206",
    },
    NONE: {
      en: "No public media in the demo instance yet.",
      sr: "U demo instanci još nema javnih medija.",
    },
    HOW: {
      en: "The seeded clip and tone are is_global_public, so the players can load them without a key. Seek in the player and watch the network panel: every jump is a new GET with Range: bytes=N- answered 206 Partial Content with Content-Range. The probe below makes the same requests from the page.",
      sr: "Seed klip i ton su is_global_public, pa ih plejeri učitavaju bez ključa. Premotajte i gledajte network panel: svaki skok je novi GET sa Range: bytes=N- na koji server odgovara 206 Partial Content sa Content-Range. Sonda ispod pravi iste zahteve sa stranice.",
    },
    PROBE: { en: "Range probe", sr: "Range sonda" },
    FROM: { en: "from byte", sr: "od bajta" },
    TO: { en: "to byte", sr: "do bajta" },
    SEND: { en: "Send", sr: "Pošalji" },
    HEAD: { en: "HEAD", sr: "HEAD" },
    STATUS: { en: "status", sr: "status" },
    RECEIVED: { en: "bytes received", sr: "primljeno bajtova" },
    LAST: { en: "Last response", sr: "Poslednji odgovor" },
  },
  SHARE: {
    TITLE: { en: "Share", sr: "Deljenje" },
    SUBTITLE: {
      en: "POST /shares → a link anyone can open · password · expiry · most downloads · revoke",
      sr: "POST /shares → link koji svako može da otvori · lozinka · istek · najviše preuzimanja · opoziv",
    },
    PICK: { en: "File", sr: "Fajl" },
    OPEN: { en: "Share…", sr: "Deli…" },
    LAST: { en: "The last link", sr: "Poslednji link" },
    OPEN_LINK: { en: "Open in a new tab", sr: "Otvori u novom tabu" },
    OPEN_FAILED: {
      en: "The link did not open: it may have been revoked or used up.",
      sr: "Link se nije otvorio: možda je opozvan ili potrošen.",
    },
    SECRET_NOTE: {
      en: "This link is of an encrypted file. A browser never sends the part after #, so pasted into an address bar it answers 401 share_secret_required: whoever opens it needs a client that sends that part as X-Share-Secret, as the button and the curl below do.",
      sr: "Ovo je link šifrovanog fajla. Pregledač nikad ne šalje deo posle #, pa nalepljen u adresnu traku odgovara 401 share_secret_required: ko ga otvara mora da koristi klijent koji taj deo šalje kao X-Share-Secret, kao dugme i curl ispod.",
    },
    HOW: {
      en: "The link is /vola/s/<token>: no key, no tenant. With a password the first GET answers 401 and the recipient sends X-Share-Password; max_downloads counts only downloads that started; the demo caps expiry at {hours} h. Revoking a link ends it at once. For an encrypted file the secret after # is in the link alone — the server keeps nothing of it.",
      sr: "Link je /vola/s/<token>: bez ključa, bez tenanta. Sa lozinkom prvi GET odgovara 401 i primalac šalje X-Share-Password; max_downloads broji samo započeta preuzimanja; demo ograničava istek na {hours} h. Opoziv gasi link odmah. Kod šifrovanog fajla tajna posle # je samo u linku — server od nje ne čuva ništa.",
    },
    NONE: { en: "No file to share yet.", sr: "Još nema fajla za deljenje." },
  },
  ENC: {
    TITLE: { en: "Encrypted files", sr: "Šifrovani fajlovi" },
    SUBTITLE: {
      en: "encryption = tenant (transparent, the server's key file) · encryption = keyring (your PIN, an unlock token that expires)",
      sr: "encryption = tenant (transparentno, serverov key fajl) · encryption = keyring (vaš PIN, unlock token koji ističe)",
    },
    TENANT_TITLE: {
      en: "tenant: encrypted at rest, transparent to the reader",
      sr: "tenant: šifrovano na disku, transparentno za čitaoca",
    },
    TENANT_HOW: {
      en: "These seeded files are JSV v1 blobs (AES-256-GCM, 1 MiB segments) under a per-file key wrapped by the server's key file. A download, a Range request or a thumbnail decrypts on the way out; the row says encryption: tenant and nothing else changes for the client.",
      sr: "Ovi seed fajlovi su JSV v1 blobovi (AES-256-GCM, segmenti od 1 MiB) pod ključem po fajlu koji umotava serverov key fajl. Preuzimanje, Range zahtev ili sličica dešifruju se u prolazu; red kaže encryption: tenant i za klijenta se ništa drugo ne menja.",
    },
    TENANT_NONE: {
      en: "No tenant-encrypted file in the demo instance yet.",
      sr: "U demo instanci još nema fajla šifrovanog tenant ključem.",
    },
    TENANT_OFF: {
      en: "This server has no key file (VOLA_KEY_FILE): tenant encryption answers 503.",
      sr: "Ovaj server nema key fajl (VOLA_KEY_FILE): tenant šifrovanje odgovara 503.",
    },
    DOWNLOAD: { en: "Download (decrypted)", sr: "Preuzmi (dešifrovano)" },
    KEYRING_TITLE: { en: "keyring: a PIN only you know", sr: "keyring: PIN koji znate samo vi" },
    KEYRING_HOW: {
      en: "Your visitor id ({visitor}) is the principal: set a PIN once (keep the recovery key), unlock, and upload into your private folder — every file there is wrapped under your keyring's master key, which the server unwraps only while your unlock token lives. The token slides with every request and ends after {ttl} s of silence, on Lock, on a hidden tab or when you leave; locking empties every thumbnail and download of the page. Your keyring and its files are purged {hours} h after the first upload.",
      sr: "Vaš ID posetioca ({visitor}) je principal: postavite PIN jednom (sačuvajte ključ za oporavak), otključajte i otpremite u svoj privatni folder — svaki fajl tamo je umotan master ključem vašeg keyring-a, koji server odmotava samo dok vaš unlock token živi. Token se produžava svakim zahtevom i gasi posle {ttl} s tišine, na Zaključaj, kad je tab sakriven ili kad odete; zaključavanje briše svaku sličicu i preuzimanje sa stranice. Vaš keyring i njegovi fajlovi brišu se {hours} h posle prvog upload-a.",
    },
    KEYRING_OFF: {
      en: "This server has no keyring provider (Redis and a pepper file are needed): the PIN examples are off.",
      sr: "Ovaj server nema keyring provider (potrebni su Redis i pepper fajl): primeri sa PIN-om su isključeni.",
    },
    UNLOCK_LEFT: { en: "unlock token: {seconds} s left", sr: "unlock token: još {seconds} s" },
    UNLOCK_NONE: { en: "locked", sr: "zaključano" },
    PRIVATE: { en: "Your private folder", sr: "Vaš privatni folder" },
  },
  API: {
    TITLE: { en: "API", sr: "API" },
    SUBTITLE: {
      en: "the routes behind the pages · curl with the demo key (read-only) · the write proxy for the rest",
      sr: "rute iza stranica · curl sa demo ključem (samo čitanje) · write proxy za ostalo",
    },
    METHOD: { en: "Method", sr: "Metod" },
    PATH: { en: "Path", sr: "Putanja" },
    SCOPE: { en: "Scope", sr: "Opseg" },
    WHAT: { en: "What it does", sr: "Šta radi" },
    EXAMPLES: { en: "curl", sr: "curl" },
    KEY_NOTE: {
      en: "The key below is the demo key this page itself uses: files:read and folders:read on the demo tenant, nothing more. Writes answer 403 with it; the write proxy accepts them from a browser (an X-User-Id of the form demo-… is all it asks).",
      sr: "Ključ ispod je demo ključ koji koristi i sama ova stranica: files:read i folders:read na demo tenantu, ništa više. Upisi sa njim odgovaraju 403; write proxy ih prima iz pregledača (traži samo X-User-Id oblika demo-…).",
    },
    NO_KEY: {
      en: "No key to show: connect first.",
      sr: "Nema ključa za prikaz: prvo se povežite.",
    },
  },
  COLLECTIONS: {
    TITLE: { en: "Collections", sr: "Kolekcije" },
    FILES: { en: "files", sr: "files" },
    MENU: { en: "menu", sr: "menu" },
  },
};
