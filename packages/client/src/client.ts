import { UdcClient } from "@jsudc/core/client";
import {
  CALLER_KEY_FROM_BROWSER_CODE,
  CONTENT_KEY_BYTES,
  CONTENT_KEY_HEADER,
  type InstanceTypesResponse,
  InstanceTypesResponseSchema,
  type LiveResponse,
  LiveResponseSchema,
  LOCALE_QUERY,
  type LookupLocale,
  type LookupsResponse,
  LookupsResponseSchema,
  type ReadyResponse,
  ReadyResponseSchema,
  TENANT_SLUG_HEADER,
  UNLOCK_HEADER,
  USER_ID_HEADER,
} from "@vola/core";
import { bytesToBase64, isBrowser } from "./env.js";
import { errorFromResponse, VolaError } from "./errors.js";
import { FilesApi } from "./files.js";
import { FoldersApi } from "./folders.js";
import { KeyringsApi } from "./keyrings.js";
import { AdminApi, KeysApi, StatsApi } from "./management.js";
import { type OpenShareOptions, openShareUrl, SharesApi } from "./shares.js";
import { UploadsApi } from "./uploads.js";

/** The `caller` content key: 32 bytes, or their base64. Node only (see `VolaClientOptions`). */
export type ContentKey = string | Uint8Array;

export interface VolaClientOptions {
  /** API base URL including the mount prefix, e.g. `https://files.example.com/vola`. */
  baseUrl: string;
  /** API key, sent as `Authorization: Bearer …`. Optional only for the public routes (`health`, `lookups`, `/s/…`, `/public/…`). */
  apiKey?: string | undefined;
  /** `fetch` to use; default: the global one. Tests inject a fake; a host may inject one with retries or a proxy. */
  fetch?: typeof fetch | undefined;
  /** `X-User-Id`: the principal of the host application — attribution, and the owner of a keyring. */
  userId?: string | undefined;
  /** `X-Tenant-Slug`: the tenant an ADMIN key acts on (a tenant key already has one). */
  tenantSlug?: string | undefined;
  /** Validate every JSON answer against its `@vola/core` schema (`invalid_response` on a mismatch). Default `false`: the types are trusted. */
  validate?: boolean | undefined;
  /** An unlock token to start with (`withUnlock` sets it). Held in memory only. */
  unlock?: string | undefined;
  /** Extra headers on every request (a correlation id, a proxy token). */
  headers?: Record<string, string> | undefined;
}

/** Options every call accepts. */
export interface CallOptions {
  signal?: AbortSignal | undefined;
  /** `X-Vola-Unlock` for this call only; default: the token the instance holds. */
  unlock?: string | undefined;
  /**
   * `X-Vola-Content-Key`, the `caller` encryption key (32 bytes or their base64). Refused in a
   * browser: the server rejects any request with an `Origin`, and the key would sit in the page.
   */
  contentKey?: ContentKey | undefined;
}

export type QueryValue = string | number | boolean | null | undefined;

/** What `VolaClient.request` takes: the escape hatch every group is built on. */
export interface RequestOptions extends CallOptions {
  method?: string | undefined;
  /** Query parameters; `undefined`/`null`/`false` are dropped, `true` is sent as `1` (the server's flag form). */
  query?: Record<string, QueryValue> | undefined;
  headers?: Record<string, string | undefined> | undefined;
  body?: BodyInit | null | undefined;
  /** A JSON body (`content-type: application/json`). */
  json?: unknown;
  /** Which statuses are an answer, not an error. Default: `2xx`. */
  ok?: ((status: number) => boolean) | undefined;
  /** No API key on this request (the public routes). */
  anonymous?: boolean | undefined;
  /** The body is a stream (`duplex: "half"` is needed). */
  streaming?: boolean | undefined;
  /** Validate the answer against its schema for this call (default: the instance setting). */
  validate?: boolean | undefined;
}

export interface LockOnUnloadOptions {
  /** The event the beacon goes on. Default `pagehide` (fires on every navigation and tab close, `beforeunload` does not on mobile). */
  event?: "pagehide" | "beforeunload" | "visibilitychange" | undefined;
}

/**
 * What `json()` needs of a schema: the `safeParse` of a `@vola/core` Zod schema. Declared
 * structurally so the SDK depends on `@vola/core` alone (Zod comes with it).
 */
export interface ResponseSchema<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/** `true` for a `2xx`. */
export const ok2xx = (status: number): boolean => status >= 200 && status < 300;

function contentKeyHeader(key: ContentKey): string {
  if (typeof key === "string") return key;
  if (key.byteLength !== CONTENT_KEY_BYTES) {
    throw new VolaError({
      status: 0,
      code: "bad_request",
      message: `contentKey: ${CONTENT_KEY_BYTES} bytes are required (got ${key.byteLength})`,
    });
  }
  return bytesToBase64(key);
}

/**
 * The SDK: one instance per API key (and per principal). Groups mirror the routes —
 * `files`, `folders`, `uploads`, `shares`, `keyrings`, `stats`, `keys`, `admin`, `udc` —
 * and `request()` / `json()` are the escape hatch they are built on.
 *
 * Secrets: the API key, the unlock token, the content key, a share secret and a PIN travel
 * in headers or bodies only — never in a URL, never in an error message, never logged.
 */
export class VolaClient {
  readonly baseUrl: string;
  readonly files: FilesApi;
  readonly folders: FoldersApi;
  readonly uploads: UploadsApi;
  readonly shares: SharesApi;
  readonly keyrings: KeyringsApi;
  readonly stats: StatsApi;
  readonly keys: KeysApi;
  readonly admin: AdminApi;

  /** The options the instance was made with (the unlock token is NOT in here; see `withUnlock`). */
  readonly options: Readonly<Omit<VolaClientOptions, "unlock">>;
  private readonly fetchImpl: typeof fetch;
  private readonly validate: boolean;
  private unlockToken: string | null;
  private udcClient: UdcClient | undefined;

  constructor(options: VolaClientOptions) {
    const { unlock, ...rest } = options;
    this.options = Object.freeze({ ...rest });
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.validate = options.validate ?? false;
    this.unlockToken = unlock ?? null;
    this.files = new FilesApi(this);
    this.folders = new FoldersApi(this);
    this.uploads = new UploadsApi(this);
    this.shares = new SharesApi(this);
    this.keyrings = new KeyringsApi(this);
    this.stats = new StatsApi(this);
    this.keys = new KeysApi(this);
    this.admin = new AdminApi(this);
  }

  // --- unlock state -------------------------------------------------------------------------

  /** A client with the same options that sends `token` as `X-Vola-Unlock` (this instance is unchanged). */
  withUnlock(token: string): VolaClient {
    return new VolaClient({ ...this.options, unlock: token });
  }

  /** `true` while the instance holds an unlock token (it may still have expired on the server). */
  get unlocked(): boolean {
    return this.unlockToken !== null;
  }

  /** Sets (or clears, with `null`) the unlock token the instance sends. `keyrings.unlock()` calls it. */
  setUnlock(token: string | null): void {
    this.unlockToken = token;
  }

  /** Ends the unlock on the server (`DELETE /keyrings/me/unlock`) and forgets the token. Idempotent. */
  lock(): Promise<void> {
    return this.keyrings.lock();
  }

  /**
   * Browser only: on `pagehide` (default) a `navigator.sendBeacon` to `/keyrings/me/unlock/close`
   * ends the unlock the instance holds, so a closed tab leaves no live token behind. The token
   * goes in the beacon's body (`text/plain`), never in the URL. Returns the function that
   * removes the listener. A no-op outside a browser.
   */
  lockOnUnload(options: LockOnUnloadOptions = {}): () => void {
    if (!isBrowser() || typeof navigator === "undefined" || !navigator.sendBeacon) {
      return () => undefined;
    }
    const event = options.event ?? "pagehide";
    const handler = () => {
      if (event === "visibilitychange" && document.visibilityState !== "hidden") return;
      const token = this.unlockToken;
      if (!token) return;
      this.unlockToken = null;
      navigator.sendBeacon(
        `${this.baseUrl}/keyrings/me/unlock/close`,
        new Blob([token], { type: "text/plain" }),
      );
    };
    window.addEventListener(event, handler);
    return () => window.removeEventListener(event, handler);
  }

  // --- transport ----------------------------------------------------------------------------

  /** `baseUrl + path + ?query`. `path` starts with `/` and is already encoded. */
  url(path: string, query?: Record<string, QueryValue>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      params.set(key, value === true ? "1" : String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  /** The headers of a request: auth, principal, tenant, unlock, content key, extras, then `options.headers`. */
  headers(options: RequestOptions = {}): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.options.headers ?? {}))
      headers.set(name, value);
    if (this.options.apiKey && !options.anonymous) {
      headers.set("authorization", `Bearer ${this.options.apiKey}`);
    }
    if (this.options.userId) headers.set(USER_ID_HEADER, this.options.userId);
    if (this.options.tenantSlug) headers.set(TENANT_SLUG_HEADER, this.options.tenantSlug);
    const unlock = options.unlock ?? this.unlockToken;
    if (unlock) headers.set(UNLOCK_HEADER, unlock);
    if (options.contentKey !== undefined) {
      if (isBrowser()) {
        throw new VolaError({
          status: 0,
          code: CALLER_KEY_FROM_BROWSER_CODE,
          message:
            "contentKey (the caller encryption key) cannot be used from a browser: the server refuses every browser request that carries one, and the key would live in the page. Use keyring encryption in the browser, or make this call from your server.",
        });
      }
      headers.set(CONTENT_KEY_HEADER, contentKeyHeader(options.contentKey));
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers.set(name, value);
    }
    return headers;
  }

  /**
   * One request to `path` (already encoded, starting with `/`). Resolves with the `Response`
   * for every status `options.ok` accepts (default `2xx`) and throws the `VolaError` of any
   * other. Transport failures (no network, a refused connection) throw what `fetch` throws.
   */
  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = this.headers(options);
    let body = options.body ?? null;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    }
    const init: RequestInit & { duplex?: "half" } = {
      method: options.method ?? "GET",
      headers,
      body,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.streaming ? { duplex: "half" } : {}),
    };
    const response = await this.fetchImpl(this.url(path, options.query), init);
    const accepted = options.ok ?? ok2xx;
    if (!accepted(response.status)) throw await errorFromResponse(response);
    return response;
  }

  /** `request()` for a JSON answer, typed by (and, with `validate`, checked against) its `@vola/core` schema. */
  async json<T>(path: string, schema: ResponseSchema<T>, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, {
      ...options,
      headers: { accept: "application/json", ...options.headers },
    });
    const body: unknown = response.status === 204 ? undefined : await response.json();
    if (!(options.validate ?? this.validate)) return body as T;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new VolaError({
        status: response.status,
        code: "invalid_response",
        message: `${options.method ?? "GET"} ${path}: the answer does not match its schema (${issue?.path.map(String).join(".") || "body"}: ${issue?.message ?? "invalid"})`,
      });
    }
    return parsed.data;
  }

  /** The `fetch` this instance was given (or the global one), without any header of its own: for the anonymous routes. */
  get rawFetch(): typeof fetch {
    return this.fetchImpl;
  }

  /** Internal: `fetch` with this instance's headers merged in (what `udc` uses). */
  fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = this.headers();
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    return this.fetchImpl(input, { ...init, headers });
  }

  // --- groups without a class of their own ----------------------------------------------------

  /** `GET /health/live`. No key needed (one is sent when the instance has it). */
  live(): Promise<LiveResponse> {
    return this.json("/health/live", LiveResponseSchema);
  }

  /** `GET /health/ready`; a `503` resolves too (`status: "fail"`) — it is a valid answer. */
  ready(): Promise<ReadyResponse> {
    return this.json("/health/ready", ReadyResponseSchema, {
      ok: (status) => ok2xx(status) || status === 503,
    });
  }

  /** `GET /lookups[?locale=]`: the vocabulary of `lookups.yaml`, labelled in `locale`. No key needed. */
  lookups(locale?: LookupLocale | string): Promise<LookupsResponse> {
    return this.json("/lookups", LookupsResponseSchema, { query: { [LOCALE_QUERY]: locale } });
  }

  /** `GET /instance-types`: the tenant's instance types with live files, with their counts. */
  instanceTypes(options: CallOptions = {}): Promise<InstanceTypesResponse> {
    return this.json("/instance-types", InstanceTypesResponseSchema, options);
  }

  /**
   * The UDC collections of the server (`POST /udc/<action>`) through `@jsudc/core`'s
   * `UdcClient`, with this instance's auth (key, principal, tenant, unlock token) on every call.
   */
  get udc(): UdcClient {
    this.udcClient ??= new UdcClient({
      httpUrl: this.baseUrl,
      fetch: (input, init) => this.fetchWithAuth(input, init),
    });
    return this.udcClient;
  }

  /**
   * Follows a share link (`…/s/<token>[#<secret>]`) anonymously: the fragment, when there is
   * one, goes as `X-Share-Secret`; a password as `X-Share-Password`; `range` as `Range`. The
   * `Response` streams the file (a folder share answers its JSON listing). Throws the
   * `VolaError` of a refusal (`410 share_gone`, `401 share_password_required`, `401
   * share_secret_required`, `409 vola_integrity`…).
   */
  static openShare(url: string, options: OpenShareOptions = {}): Promise<Response> {
    return openShareUrl(
      options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      url,
      options,
    );
  }
}
