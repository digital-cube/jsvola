import { type Messages, useI18n, type Vars } from "@jsudc/react";
import { useCallback } from "react";

/** The i18n section every `@vola/react` string lives in (`t("VOLA", "UPLOAD")`). */
export const VOLA_SECTION = "VOLA";

/**
 * The package's strings, `en` and `sr`, layered over `@jsudc/react`'s dictionary by
 * `VolaProvider` (`<UdcI18nProvider messages>`). A host overrides a term by passing its own
 * `messages` to the provider (`{ VOLA: { UPLOAD: { en: "Add file", sr: "Dodaj fajl" } } }`).
 */
export const VOLA_MESSAGES: Messages = {
  [VOLA_SECTION]: {
    // --- browser ---
    ROOT: { en: "Root", sr: "Koren" },
    BREADCRUMBS: { en: "Folder path", sr: "Putanja foldera" },
    FOLDERS: { en: "Folders", sr: "Folderi" },
    NEW_FOLDER: { en: "New folder", sr: "Novi folder" },
    FOLDER_NAME: { en: "Folder name", sr: "Ime foldera" },
    FOLDER_ACTIONS: { en: "Folder actions", sr: "Akcije foldera" },
    FOLDER_DELETE_CONFIRM: {
      en: "Delete the folder “{name}” with everything in it?",
      sr: "Obrisati folder „{name}“ sa svim što je u njemu?",
    },
    UPLOAD: { en: "Upload", sr: "Otpremi" },
    DROP_HERE: {
      en: "Drop files to upload them here",
      sr: "Spustite fajlove da ih otpremite ovde",
    },
    LIVE: { en: "Live", sr: "Uživo" },
    CONNECTING: { en: "Connecting…", sr: "Povezivanje…" },
    OFFLINE: { en: "Offline — reconnecting", sr: "Van mreže — ponovno povezivanje" },
    LIVE_OFF: { en: "Not live", sr: "Bez uživo osvežavanja" },
    ACTIONS: { en: "Actions", sr: "Akcije" },
    ACTIONS_FOR: { en: "Actions for {name}", sr: "Akcije za {name}" },
    OPEN: { en: "Open", sr: "Otvori" },
    DOWNLOAD: { en: "Download", sr: "Preuzmi" },
    RENAME: { en: "Rename", sr: "Preimenuj" },
    MOVE: { en: "Move", sr: "Premesti" },
    DELETE: { en: "Delete", sr: "Obriši" },
    VERSIONS: { en: "Versions", sr: "Verzije" },
    SHARE: { en: "Share", sr: "Podeli" },
    VISIBILITY: { en: "Visibility", sr: "Vidljivost" },
    LOAD_MORE: { en: "Load more", sr: "Učitaj još" },
    NO_FILES: { en: "No files here yet.", sr: "Ovde još nema fajlova." },
    LOADING: { en: "Loading…", sr: "Učitavanje…" },
    NEW_NAME: { en: "New name", sr: "Novo ime" },
    TARGET_FOLDER: { en: "Target folder", sr: "Odredišni folder" },
    TARGET_FOLDER_HINT: {
      en: "A path like docs/q4; empty for the root. A missing folder is created.",
      sr: "Putanja kao docs/q4; prazno za koren. Folder koji ne postoji biće napravljen.",
    },
    DELETE_CONFIRM: {
      en: "Delete “{name}”? The file goes to the bin; only a purge removes it for good.",
      sr: "Obrisati „{name}“? Fajl ide u korpu; samo purge ga uklanja zauvek.",
    },
    VERSIONS_OF: { en: "Versions of {name}", sr: "Verzije fajla {name}" },
    NO_VERSIONS: { en: "This file has a single version.", sr: "Ovaj fajl ima samo jednu verziju." },
    CURRENT: { en: "current", sr: "tekuća" },
    PUBLIC: {
      en: "Public: readable with any key of the tenant",
      sr: "Javno: čitljivo sa bilo kojim ključem tenanta",
    },
    GLOBAL_PUBLIC: {
      en: "Globally public: served by /public without a key",
      sr: "Globalno javno: služi se preko /public bez ključa",
    },
    GLOBAL_PUBLIC_ENCRYPTED: {
      en: "An encrypted file cannot be globally public.",
      sr: "Šifrovan fajl ne može biti globalno javan.",
    },
    ENCRYPTED: { en: "Encrypted", sr: "Šifrovano" },
    SORT_BY: { en: "Sort by {field}", sr: "Sortiraj po {field}" },
    CANCEL: { en: "Cancel", sr: "Otkaži" },
    SAVE: { en: "Save", sr: "Sačuvaj" },
    CONFIRM: { en: "Confirm", sr: "Potvrdi" },
    CLOSE: { en: "Close", sr: "Zatvori" },
    RETRY: { en: "Try again", sr: "Pokušaj ponovo" },
    ERROR: { en: "Something went wrong: {message}", sr: "Nešto nije u redu: {message}" },
    // --- upload ---
    UPLOADS: { en: "Uploads", sr: "Otpremanja" },
    QUEUED: { en: "Queued", sr: "Na čekanju" },
    UPLOADING: { en: "Uploading… {percent}%", sr: "Otpremanje… {percent}%" },
    UPLOADED: { en: "Uploaded", sr: "Otpremljeno" },
    UPLOAD_FAILED: { en: "Failed: {message}", sr: "Neuspešno: {message}" },
    UPLOAD_CANCELLED: { en: "Cancelled — can be resumed", sr: "Otkazano — može se nastaviti" },
    CANCEL_UPLOAD: { en: "Cancel upload of {name}", sr: "Otkaži otpremanje {name}" },
    RESUME: { en: "Resume", sr: "Nastavi" },
    REMOVE: { en: "Remove", sr: "Ukloni" },
    RESUMABLE: { en: "resumable", sr: "sa nastavkom" },
    CHOOSE_FILES: { en: "Choose files", sr: "Izaberi fajlove" },
    ENCRYPTION: { en: "Encryption", sr: "Šifrovanje" },
    ENC_DEFAULT: { en: "Default (folder policy)", sr: "Podrazumevano (politika foldera)" },
    ENC_NONE: { en: "Not encrypted", sr: "Bez šifrovanja" },
    ENC_TENANT: { en: "Tenant key", sr: "Ključ tenanta" },
    ENC_KEYRING: { en: "My PIN (keyring)", sr: "Moj PIN (privezak)" },
    // --- thumbnail ---
    THUMB_GENERATING: { en: "Thumbnail is being made", sr: "Sličica se pravi" },
    THUMB_FAILED: { en: "No preview", sr: "Nema pregleda" },
    THUMB_NONE: { en: "No preview for this type", sr: "Nema pregleda za ovaj tip" },
    THUMB_LOCKED: { en: "Locked", sr: "Zaključano" },
    THUMB_ERROR: { en: "Preview failed", sr: "Pregled nije uspeo" },
    // --- keyring / PIN ---
    PIN_TITLE: { en: "Enter your PIN", sr: "Unesite PIN" },
    PIN_SETUP_TITLE: { en: "Choose a PIN", sr: "Izaberite PIN" },
    PIN_SETUP_TEXT: {
      en: "Six digits. It protects the keys of your encrypted files; nobody can read them without it.",
      sr: "Šest cifara. Štiti ključeve vaših šifrovanih fajlova; bez njega ih niko ne može pročitati.",
    },
    PIN_CONFIRM_TITLE: { en: "Repeat the PIN", sr: "Ponovite PIN" },
    PIN_MISMATCH: {
      en: "The PINs differ. Start over.",
      sr: "PIN-ovi se razlikuju. Počnite ponovo.",
    },
    PIN_DIGIT: { en: "PIN digit {n}", sr: "Cifra PIN-a {n}" },
    PIN_INPUT: { en: "PIN", sr: "PIN" },
    UNLOCK: { en: "Unlock", sr: "Otključaj" },
    UNLOCKING: { en: "Unlocking…", sr: "Otključavanje…" },
    PIN_WRONG: {
      en: "Wrong PIN ({attempts} wrong in a row).",
      sr: "Pogrešan PIN ({attempts} pogrešnih zaredom).",
    },
    PIN_WRONG_WAIT: {
      en: "Wrong PIN ({attempts} wrong in a row). Next try in {seconds} s.",
      sr: "Pogrešan PIN ({attempts} pogrešnih zaredom). Sledeći pokušaj za {seconds} s.",
    },
    PIN_LOCKED_OUT: {
      en: "Too many wrong PINs. Try again in {seconds} s.",
      sr: "Previše pogrešnih PIN-ova. Pokušajte ponovo za {seconds} s.",
    },
    PIN_INVALID_LENGTH: { en: "A PIN has exactly six digits.", sr: "PIN ima tačno šest cifara." },
    PIN_INVALID_DIGITS: { en: "A PIN is digits only.", sr: "PIN se sastoji samo od cifara." },
    PIN_INVALID_TRIVIAL: {
      en: "That PIN is too easy (repeated or sequential digits).",
      sr: "Taj PIN je previše jednostavan (iste ili uzastopne cifre).",
    },
    RECOVERY_TITLE: { en: "Your recovery key", sr: "Vaš ključ za oporavak" },
    RECOVERY_TEXT: {
      en: "Shown this once and kept nowhere. Write it down: it is the only way back in if you forget the PIN.",
      sr: "Prikazuje se samo sada i nigde se ne čuva. Zapišite ga: to je jedini put nazad ako zaboravite PIN.",
    },
    RECOVERY_SAVED: { en: "I have saved the recovery key", sr: "Sačuvao/la sam ključ za oporavak" },
    CONTINUE: { en: "Continue", sr: "Nastavi" },
    FORGOT_PIN: { en: "Forgot your PIN?", sr: "Zaboravili ste PIN?" },
    RECOVER_TITLE: { en: "Recover with the recovery key", sr: "Oporavak ključem za oporavak" },
    RECOVERY_KEY: { en: "Recovery key", sr: "Ključ za oporavak" },
    NEW_PIN: { en: "New PIN", sr: "Novi PIN" },
    RECOVER: { en: "Recover", sr: "Oporavi" },
    RECOVERY_WRONG: {
      en: "That recovery key is not right.",
      sr: "Taj ključ za oporavak nije ispravan.",
    },
    NEW_RECOVERY_TITLE: { en: "Your NEW recovery key", sr: "Vaš NOVI ključ za oporavak" },
    NEW_RECOVERY_TEXT: {
      en: "The old one is retired. Save this one the same way.",
      sr: "Stari više ne važi. Sačuvajte ovaj na isti način.",
    },
    CHANGE_PIN: { en: "Change PIN", sr: "Promeni PIN" },
    CURRENT_PIN: { en: "Current PIN", sr: "Trenutni PIN" },
    PIN_CHANGED: {
      en: "PIN changed. Unlock with the new one.",
      sr: "PIN je promenjen. Otključajte novim.",
    },
    LOCK: { en: "Lock", sr: "Zaključaj" },
    LOCKED: { en: "Locked", sr: "Zaključano" },
    UNLOCKED: { en: "Unlocked", sr: "Otključano" },
    LOCK_COUNTDOWN: { en: "Locking in {seconds} s", sr: "Zaključavanje za {seconds} s" },
    STAY: { en: "Stay unlocked", sr: "Ostani otključan" },
    BACK: { en: "Back", sr: "Nazad" },
    RESET: { en: "Reset the keyring", sr: "Resetuj privezak" },
    RESET_TITLE: { en: "Reset the keyring", sr: "Resetovanje priveska" },
    RESET_TEXT: {
      en: "Every file encrypted under this keyring is lost for good. Nothing brings it back: not the PIN, not the recovery key, not a backup of the server.",
      sr: "Svaki fajl šifrovan pod ovim priveskom nestaje zauvek. Ništa ga ne vraća: ni PIN, ni ključ za oporavak, ni rezervna kopija servera.",
    },
    RESET_PREVIEW: {
      en: "{files} files ({live} live, {bytes})",
      sr: "{files} fajlova ({live} aktivnih, {bytes})",
    },
    RESET_TYPE: { en: "Type RESET to confirm", sr: "Ukucajte RESET za potvrdu" },
    RESET_DONE: {
      en: "The keyring and {files} files are gone. Set up a new PIN to continue.",
      sr: "Privezak i {files} fajlova su uklonjeni. Podesite nov PIN za nastavak.",
    },
    // --- share ---
    SHARE_TITLE: { en: "Share “{name}”", sr: "Deljenje „{name}“" },
    PASSWORD: { en: "Password (optional)", sr: "Lozinka (opciono)" },
    EXPIRES: { en: "Expires (optional)", sr: "Ističe (opciono)" },
    MAX_DOWNLOADS: { en: "Most downloads (optional)", sr: "Najviše preuzimanja (opciono)" },
    CREATE_LINK: { en: "Create link", sr: "Napravi link" },
    CREATING: { en: "Creating…", sr: "Pravljenje…" },
    LINK: { en: "Link", sr: "Link" },
    COPY: { en: "Copy", sr: "Kopiraj" },
    COPIED: { en: "Copied", sr: "Kopirano" },
    SHARE_ENCRYPTED_WARNING: {
      en: "This file is encrypted. Whoever opens the link gets the plain content. The part after # is the secret: it is only in the link, never on the server — share the whole link, and revoke it to shred the grant.",
      sr: "Ovaj fajl je šifrovan. Ko otvori link dobija čist sadržaj. Deo posle # je tajna: postoji samo u linku, nikad na serveru — podelite ceo link, a opozivom se grant trajno uništava.",
    },
    SHARE_LINK_ONCE: {
      en: "The link is shown this once; copy it now.",
      sr: "Link se prikazuje samo sada; kopirajte ga odmah.",
    },
    EXISTING_SHARES: { en: "Existing links", sr: "Postojeći linkovi" },
    NO_SHARES: { en: "No links yet.", sr: "Još nema linkova." },
    REVOKE: { en: "Revoke", sr: "Opozovi" },
    REVOKED: { en: "revoked", sr: "opozvan" },
    DOWNLOADS: { en: "{count} downloads", sr: "{count} preuzimanja" },
    OF_MAX: { en: "of {max}", sr: "od {max}" },
    EXPIRES_AT: { en: "expires {date}", sr: "ističe {date}" },
    PASSWORD_PROTECTED: { en: "password", sr: "lozinka" },
    CREATED_AT: { en: "created {date}", sr: "napravljen {date}" },
  },
};

/** `t(term, vars)` for the `VOLA` section, plus the locale in effect. */
export function useVolaT(): {
  t: (term: string, vars?: Vars) => string;
  locale: string;
  intlLocale: string;
} {
  const { t: base, locale, intlLocale } = useI18n();
  const t = useCallback((term: string, vars?: Vars) => base(VOLA_SECTION, term, vars), [base]);
  return { t, locale, intlLocale };
}
