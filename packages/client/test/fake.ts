import { VolaClient, type VolaClientOptions } from "../src/index.js";

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** The raw request body as `fetch` received it. */
  body: BodyInit | null | undefined;
  init: RequestInit | undefined;
  /** The body as text (JSON bodies, streams); `null` for a `FormData`. */
  text: string | null;
  /** The JSON body, when it is one. */
  json: unknown;
  /** The multipart form, when the body is one (or a stream the SDK framed). */
  form: FormData | null;
}

export type Handler = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message = code,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: { code, message, ...extra } }, status, headers);
}

async function readBody(
  body: BodyInit | null | undefined,
  headers: Headers,
): Promise<Pick<RecordedCall, "text" | "json" | "form">> {
  if (body === null || body === undefined) return { text: null, json: undefined, form: null };
  const contentType = headers.get("content-type") ?? "";
  if (body instanceof FormData) {
    return { text: null, json: undefined, form: body };
  }
  if (contentType.startsWith("multipart/form-data")) {
    const form = await new Response(body as BodyInit, {
      headers: { "content-type": contentType },
    }).formData();
    return { text: null, json: undefined, form };
  }
  const text = await new Response(body as BodyInit).text();
  let json: unknown;
  if (contentType.includes("json")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { text, json, form: null };
}

/** A `fetch` that records every call and answers through `handler` (`404 not_found` when it returns nothing). */
export function fakeFetch(handler: Handler = () => undefined): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body: init?.body,
      init,
      ...(await readBody(init?.body, headers)),
    };
    calls.push(call);
    if (init?.signal?.aborted)
      throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    const response = await handler(call);
    return response ?? errorResponse(404, "not_found", `no route for ${call.method} ${call.path}`);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function makeClient(handler?: Handler, options: Partial<VolaClientOptions> = {}) {
  const { fetch, calls } = fakeFetch(handler);
  const client = new VolaClient({
    baseUrl: "http://vola.test/vola",
    apiKey: "vola_test_k",
    fetch,
    ...options,
  });
  return { client, calls, last: () => calls[calls.length - 1] as RecordedCall };
}

export const FILE = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  instance_type: "tickets",
  instance_id: "33333333-3333-4333-8333-333333333333",
  slug: null,
  hash: "a".repeat(64),
  size: 3,
  filename: "a.txt",
  extension: "txt",
  mime_type: "text/plain",
  kind: "text",
  metadata: {},
  folder_id: null,
  parent_id: null,
  is_public: false,
  is_global_public: false,
  encryption: "none",
  enc_format: null,
  keyring_id: null,
  created_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  deleted_by: null,
  last_accessed_at: null,
  last_accessed_by: null,
  processing_status: null,
};

export const FOLDER = {
  id: "44444444-4444-4444-8444-444444444444",
  tenant_id: FILE.tenant_id,
  instance_type: "tickets",
  instance_id: FILE.instance_id,
  parent_id: null,
  name: "docs",
  path: "docs",
  default_keyring_id: null,
  created_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  deleted_by: null,
};

export const SHARE = {
  id: "55555555-5555-4555-8555-555555555555",
  tenant_id: FILE.tenant_id,
  file_id: FILE.id,
  folder_id: null,
  scope: "PUBLIC_LINK",
  has_password: false,
  expires_at: null,
  max_downloads: null,
  download_count: 0,
  created_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  revoked_at: null,
  encrypted: false,
};
