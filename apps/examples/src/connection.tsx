import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { Settings } from "./settings.js";

/** What `GET <baseUrl>/examples/config` answers (`@vol-a/server`'s `ExamplesConfigResponse`). */
export interface ExamplesConfig {
  api_key: string;
  tenant: string;
  instance_type: string;
  instance_id: string;
  user_prefix: string;
  /** `<prefix>/examples/write/`: where a visitor's write goes, without a key. */
  write_path: string;
  limits: {
    max_upload_bytes: number;
    ttl_hours: number;
    rate_limit: number;
    rate_window_s: number;
    mime_types: string[];
  };
  features: {
    keyring: boolean;
    tenant_encryption: boolean;
    worker: boolean;
  };
}

/** The demo instance when the server names none (a visitor with a key of their own, no examples on the server). */
export const DEFAULT_INSTANCE = { type: "demo", id: "00000000-0000-4000-8000-000000000001" };

/**
 * The examples configuration the server hands out, or `null` when it has none (404: no
 * `VOLA_EXAMPLES`), answers something else, or cannot be reached.
 */
export async function fetchExamplesConfig(
  baseUrl: string,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<ExamplesConfig | null> {
  try {
    const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/examples/config`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ExamplesConfig>;
    if (typeof body?.api_key !== "string" || typeof body.instance_id !== "string") return null;
    return body as ExamplesConfig;
  } catch {
    return null;
  }
}

export type DemoState =
  | { status: "loading" }
  /** The server has no examples configuration (or could not be asked). */
  | { status: "none" }
  | { status: "ready"; config: ExamplesConfig };

/** Asks the server for its examples configuration whenever `baseUrl` changes. */
export function useExamplesConfig(
  baseUrl: string,
  doFetch: typeof fetch = globalThis.fetch,
): DemoState {
  const [state, setState] = useState<DemoState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchExamplesConfig(baseUrl, doFetch).then((config) => {
      if (!cancelled) setState(config ? { status: "ready", config } : { status: "none" });
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, doFetch]);
  return state;
}

/** Where the key in use comes from. */
export type KeySource = "own" | "demo" | "pending" | "none";

/** The server, key and instance every page talks to: the visitor's own key wins over the demo key. */
export interface Connection {
  baseUrl: string;
  apiKey: string;
  source: KeySource;
  /** The visitor's `X-User-Id` of this browser session. */
  visitor: string;
  /** The server's examples configuration, when it has one. */
  demo: ExamplesConfig | null;
  instanceType: string;
  instanceId: string;
  /** `true` when writes go through the server's write proxy (the demo key, examples on). */
  proxied: boolean;
}

export function connectionOf(settings: Settings, demo: DemoState, visitor: string): Connection {
  const config = demo.status === "ready" ? demo.config : null;
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const instanceType =
    settings.instanceType.trim() || config?.instance_type || DEFAULT_INSTANCE.type;
  const instanceId = settings.instanceId.trim() || config?.instance_id || DEFAULT_INSTANCE.id;
  const common = { baseUrl, visitor, demo: config, instanceType, instanceId };
  if (settings.apiKey) {
    return { ...common, apiKey: settings.apiKey, source: "own", proxied: false };
  }
  if (config) return { ...common, apiKey: config.api_key, source: "demo", proxied: true };
  return {
    ...common,
    apiKey: "",
    source: demo.status === "loading" ? "pending" : "none",
    proxied: false,
  };
}

/**
 * Whether a request of the SDK has to go through the write proxy: everything that changes
 * something (the visitor's key is read-only), the whole resumable protocol, the shares and
 * the visitor's keyring routes (all `*:write` scopes) — except the `unlock/close` beacon and
 * `OPTIONS`, which need no key at all, and the UDC actions, which are `POST`s that only read. `path` is relative to the API base (`/files/…`).
 */
export function needsProxy(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return false;
  // The UDC actions are POSTs but read (the visitor's key lists; `mutate` is not on offer).
  if (path === "/udc" || path.startsWith("/udc/")) return false;
  // The demo routes themselves (`/examples/regenerate`, `/examples/config`) take no key.
  if (path === "/examples" || path.startsWith("/examples/")) return false;
  if (path === "/uploads" || path.startsWith("/uploads/")) return true;
  if (path === "/shares" || path.startsWith("/shares/")) return true;
  if (path === "/keyrings/me" || path.startsWith("/keyrings/me/")) {
    return path !== "/keyrings/me/unlock/close";
  }
  return m !== "GET" && m !== "HEAD";
}

export interface DemoFetchOptions {
  /** The API base URL the client builds its requests on (`/vola`). */
  baseUrl: string;
  /** `write_path` of the examples configuration (`/vola/examples/write/`). */
  writePath: string;
  /** `false`: every request goes where the SDK sent it (a key of the visitor's own). */
  enabled: boolean;
  fetch?: typeof fetch | undefined;
}

/** The path of `href` under `baseUrl`, or `null` when it is not an API request. */
export function apiPath(href: string, baseUrl: string): string | null {
  const here = typeof location !== "undefined" ? location.href : "http://localhost/";
  const url = new URL(href, here);
  const base = new URL(baseUrl.replace(/\/+$/, ""), here);
  if (url.origin !== base.origin) return null;
  if (url.pathname !== base.pathname && !url.pathname.startsWith(`${base.pathname}/`)) return null;
  return url.pathname.slice(base.pathname.length) || "/";
}

/**
 * The `fetch` the `VolaClient` is given: a write (`needsProxy`) is sent to the write proxy
 * instead — same path under `writePath`, same body and headers, without the (read-only) key —
 * where the server replays it under its own write key. Reads go straight to the API.
 */
export function demoFetch(options: DemoFetchOptions): typeof fetch {
  const real = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const writePath = options.writePath.replace(/\/+$/, "");
  return (input, init) => {
    if (!options.enabled) return real(input, init);
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const path = apiPath(href, options.baseUrl);
    if (path === null || !needsProxy(method, path)) return real(input, init);
    const here = typeof location !== "undefined" ? location.href : "http://localhost/";
    const url = new URL(href, here);
    const base = new URL(options.baseUrl, here);
    url.pathname = `${writePath}${path}`;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    headers.delete("authorization");
    headers.delete("x-api-key");
    const target =
      url.origin === base.origin && options.baseUrl.startsWith("/")
        ? `${url.pathname}${url.search}`
        : url.href;
    return real(target, { ...init, method, headers });
  };
}

export interface SettingsContextValue {
  settings: Settings;
  connection: Connection;
  /** Saves `next` (localStorage) and connects with it. */
  apply: (next: Settings) => void;
  /** A new visitor id for this session: a fresh keyring, fresh uploads. */
  newVisitor: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  value,
  children,
}: {
  value: SettingsContextValue;
  children: ReactNode;
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings outside <SettingsProvider>");
  return value;
}
