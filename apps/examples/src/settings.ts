/**
 * What the visitor can set (the header's Settings), kept in `localStorage`, and the visitor's
 * identity, kept in `sessionStorage`: one `X-User-Id` per browser session, so a keyring made
 * on the Encrypted files page belongs to this tab's visitor and nobody else's.
 */
export interface Settings {
  /** API base URL: `/vola` on the server that serves the site, or `http://host:port/vola`. */
  baseUrl: string;
  /** The visitor's own key; empty: the server's demo key (`GET /examples/config`), when it has one. */
  apiKey: string;
  /** The instance the pages show; empty: the demo instance the server names. */
  instanceType: string;
  instanceId: string;
}

export const STORAGE_KEY = "vola-examples:settings";
export const VISITOR_KEY = "vola-examples:visitor";
/** Every visitor id starts with this (the server's write proxy refuses any other). */
export const VISITOR_PREFIX = "demo-";

export function defaultSettings(env: ImportMetaEnv = import.meta.env): Settings {
  return {
    baseUrl: env.VITE_VOLA_BASE_URL || "/vola",
    apiKey: env.VITE_VOLA_API_KEY ?? "",
    instanceType: "",
    instanceId: "",
  };
}

/** Settings from `storage`, every missing or malformed field from the defaults. */
export function loadSettings(storage: Pick<Storage, "getItem">, defaults: Settings): Settings {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<Settings> | null;
    if (!raw || typeof raw !== "object") return defaults;
    const pick = (key: keyof Settings) =>
      typeof raw[key] === "string" ? (raw[key] as string) : defaults[key];
    return {
      baseUrl: pick("baseUrl") || defaults.baseUrl,
      apiKey: pick("apiKey"),
      instanceType: pick("instanceType"),
      instanceId: pick("instanceId"),
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(storage: Pick<Storage, "setItem">, settings: Settings): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** `demo-` and twelve random lowercase letters and digits. */
export function newVisitorId(random: (bytes: Uint8Array) => Uint8Array = fill): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = random(new Uint8Array(12));
  let id = VISITOR_PREFIX;
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

function fill(bytes: Uint8Array): Uint8Array {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) return crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** The visitor id of this session, made on first use. */
export function visitorId(storage: Pick<Storage, "getItem" | "setItem">): string {
  const stored = storage.getItem(VISITOR_KEY);
  if (stored && /^demo-[a-z0-9]{6,32}$/.test(stored)) return stored;
  const id = newVisitorId();
  storage.setItem(VISITOR_KEY, id);
  return id;
}

/** A new visitor id for this session (a fresh keyring, fresh uploads attributed to it). */
export function resetVisitorId(storage: Pick<Storage, "setItem">): string {
  const id = newVisitorId();
  storage.setItem(VISITOR_KEY, id);
  return id;
}

/** `1234567` → `1.2 MB`-style text, in binary units like the server's limits. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
