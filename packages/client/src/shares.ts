import {
  CONTENT_KEY_BYTES,
  callerGrantAad,
  FORCE_DOWNLOAD_QUERY,
  INCLUDE_REVOKED_QUERY,
  SHARE_PASSWORD_HEADER,
  SHARE_SECRET_BYTES,
  SHARE_SECRET_HEADER,
  type ShareCreated,
  ShareCreatedSchema,
  type SharedFolderListing,
  SharedFolderListingSchema,
  type ShareInfo,
  ShareInfoSchema,
  type ShareList,
  ShareListSchema,
} from "@vola/core";
import type { CallOptions, VolaClient } from "./client.js";
import { ok2xx } from "./client.js";
import { bytesToBase64, bytesToBase64Url, encodePath, randomBytes } from "./env.js";
import { errorFromResponse, VolaError } from "./errors.js";
import { type ByteRange, rangeHeader } from "./files.js";

/** `POST /shares` as a caller writes it (the schema's defaults are optional here). */
export interface ShareCreateInput {
  file_id?: string | undefined;
  folder?: { instance_type: string; instance_id: string; path: string } | undefined;
  scope?: "PUBLIC_LINK" | "TENANT" | "INSTANCE_VIEWERS" | "EMAIL" | undefined;
  password?: string | undefined;
  expires_at?: string | undefined;
  max_downloads?: number | undefined;
  /** A `caller` file only: the grant the caller made (`callerGrant()`). */
  fk_share_ct?: string | undefined;
}

export interface ShareListOptions extends CallOptions {
  fileId?: string | undefined;
  folderId?: string | undefined;
  includeRevoked?: boolean | undefined;
}

export interface OpenShareOptions {
  /** `fetch` to use (the static `VolaClient.openShare`); default: the global one. */
  fetch?: typeof fetch | undefined;
  /** The password of a protected share (`X-Share-Password`, never the query string). */
  password?: string | undefined;
  range?: ByteRange | undefined;
  /** A file (or subfolder) INSIDE a shared folder, by its path relative to the share. */
  path?: string | undefined;
  method?: "GET" | "HEAD" | undefined;
  /** `?download=1`. */
  download?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

/** The share URL without its fragment, and the secret the fragment carried (`null` without one). */
export function parseShareUrl(url: string): { url: string; secret: string | null } {
  const parsed = new URL(url);
  const secret = parsed.hash.length > 1 ? parsed.hash.slice(1) : null;
  parsed.hash = "";
  return { url: parsed.toString(), secret };
}

/** `openShare` over a given `fetch`: the secret from the fragment as `X-Share-Secret`, the password as a header. */
export async function openShareUrl(
  fetchImpl: typeof fetch,
  url: string,
  options: OpenShareOptions = {},
): Promise<Response> {
  const { url: bare, secret } = parseShareUrl(url);
  const target = new URL(bare);
  if (options.path !== undefined) {
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/path/${encodePath(options.path)}`;
  }
  if (options.download) target.searchParams.set(FORCE_DOWNLOAD_QUERY, "1");
  const headers = new Headers();
  if (secret) headers.set(SHARE_SECRET_HEADER, secret);
  if (options.password !== undefined) headers.set(SHARE_PASSWORD_HEADER, options.password);
  if (options.range !== undefined) headers.set("range", rangeHeader(options.range));
  const response = await fetchImpl(target.toString(), {
    method: options.method ?? "GET",
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!ok2xx(response.status)) throw await errorFromResponse(response);
  return response;
}

export interface CallerGrant {
  /** `fk_share_ct` for `POST /shares`: `nonce ∥ AES-256-GCM(S, FK, "<file id>:key:share:caller")`, base64. */
  fkShareCt: string;
  /** The link secret `S` (32 bytes). Give it to the recipient in the URL fragment ONLY. */
  secret: Uint8Array;
  /** `S` as base64url: what goes after `#` in the share URL. */
  fragment: string;
}

/**
 * The share grant of a `caller`-encrypted file, made by the caller (the server never holds
 * that file's key, so it cannot make one): the file key `fileKey` wrapped under a fresh link
 * secret with the platform's WebCrypto. `fileKey` is the file's FK, which the caller
 * unwrapped from `fk_ct` under its content key (`docs/CRYPTO.md` § 9) — NOT the content key.
 */
export async function callerGrant(
  fileId: string,
  fileKey: Uint8Array,
  secret: Uint8Array = randomBytes(SHARE_SECRET_BYTES),
): Promise<CallerGrant> {
  if (fileKey.byteLength !== CONTENT_KEY_BYTES) {
    throw new VolaError({
      status: 0,
      code: "bad_request",
      message: `callerGrant: the file key is ${CONTENT_KEY_BYTES} bytes`,
    });
  }
  if (secret.byteLength !== SHARE_SECRET_BYTES) {
    throw new VolaError({
      status: 0,
      code: "bad_request",
      message: `callerGrant: the secret is ${SHARE_SECRET_BYTES} bytes`,
    });
  }
  const key = await crypto.subtle.importKey("raw", secret.slice(), "AES-GCM", false, ["encrypt"]);
  const nonce = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce.slice(),
        additionalData: new TextEncoder().encode(callerGrantAad(fileId)).slice(),
        tagLength: 128,
      },
      key,
      fileKey.slice(),
    ),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return { fkShareCt: bytesToBase64(out), secret, fragment: bytesToBase64Url(secret) };
}

/** Share links: the owner's side (`/shares`, scope `shares:write`) and the recipient's (`/s/<token>`, no key). */
export class SharesApi {
  constructor(private readonly client: VolaClient) {}

  /**
   * `POST /shares`: `{file_id}` or `{folder}`, with `password`, `expires_at`, `max_downloads`.
   * Resolves with the info, the `token` (this once) and the public `url` — for an encrypted
   * file (`tenant`, or `keyring` with the owner's unlock) the `url` ends in `#<secret>`: the
   * recipient gets plaintext, and the secret is nowhere but in that link.
   */
  create(body: ShareCreateInput, options: CallOptions = {}): Promise<ShareCreated> {
    return this.client.json("/shares", ShareCreatedSchema, {
      method: "POST",
      json: body,
      ...options,
    });
  }

  /** `GET /shares[?file_id=|folder_id=][&include_revoked=1]`, newest first, never the token. */
  list(options: ShareListOptions = {}): Promise<ShareList> {
    return this.client.json("/shares", ShareListSchema, {
      query: {
        file_id: options.fileId,
        folder_id: options.folderId,
        [INCLUDE_REVOKED_QUERY]: options.includeRevoked,
      },
      signal: options.signal,
    });
  }

  /** `GET /shares/:id`. */
  get(id: string, options: CallOptions = {}): Promise<ShareInfo> {
    return this.client.json(`/shares/${encodeURIComponent(id)}`, ShareInfoSchema, options);
  }

  /** `DELETE /shares/:id`: revoke (idempotent); the link answers `410 share_gone` from then on, and a grant is shredded. */
  revoke(id: string, options: CallOptions = {}): Promise<ShareInfo> {
    return this.client.json(`/shares/${encodeURIComponent(id)}`, ShareInfoSchema, {
      method: "DELETE",
      ...options,
    });
  }

  /**
   * `POST /shares` for a `caller`-encrypted file: makes the grant (`callerGrant`) and creates
   * the share with it. The `url` returned INCLUDES the `#<secret>` fragment (the server's
   * does not: it never saw the secret). Node only, like everything `caller`.
   */
  async createCallerGrant(
    fileId: string,
    fileKey: Uint8Array,
    body: Omit<ShareCreateInput, "file_id" | "folder" | "fk_share_ct"> = {},
    options: CallOptions = {},
  ): Promise<ShareCreated> {
    const grant = await callerGrant(fileId, fileKey);
    const created = await this.create(
      { ...body, file_id: fileId, fk_share_ct: grant.fkShareCt },
      options,
    );
    return { ...created, url: `${created.url}#${grant.fragment}` };
  }

  /** The recipient's side with this instance's `fetch` (no API key is sent): see `VolaClient.openShare`. */
  open(url: string, options: Omit<OpenShareOptions, "fetch"> = {}): Promise<Response> {
    return openShareUrl(this.client.rawFetch, url, options);
  }

  /** The listing of a shared FOLDER (`GET /s/<token>[/path/<subfolder>]` as JSON). */
  async listing(
    url: string,
    options: Omit<OpenShareOptions, "fetch" | "method" | "range"> = {},
  ): Promise<SharedFolderListing> {
    const response = await openShareUrl(this.client.rawFetch, url, { ...options, method: "GET" });
    const body: unknown = await response.json();
    if (!(this.client.options.validate ?? false)) return body as SharedFolderListing;
    const parsed = SharedFolderListingSchema.safeParse(body);
    if (!parsed.success) {
      throw new VolaError({
        status: response.status,
        code: "invalid_response",
        message: `share listing: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      });
    }
    return parsed.data;
  }
}
