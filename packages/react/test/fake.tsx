import type { DescribeResponse, Row } from "@jsudc/core";
import { type RenderResult, render } from "@testing-library/react";
import { VolaClient, type VolaClientOptions } from "@vol-a/client";
import type { FileInfo, KeyringStatus } from "@vol-a/core";
import type { ReactNode } from "react";
import {
  filesScope,
  VolaProvider,
  type VolaProviderProps,
  type WebSocketConstructor,
} from "../src/index.js";

export { filesScope };

export const BASE = "http://vola.test/vola";
export const API_KEY = "vola_test_key";

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}
export type Handler = (req: FakeRequest) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export const error = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json({ error: { code, message: code, ...extra } }, status, {
    ...(typeof extra.retry_after === "number" ? { "retry-after": String(extra.retry_after) } : {}),
  });
export const udcOk = (action: string, payload: unknown) =>
  json({ kind: `udc.${action}.ok`, id: "1", payload });

/** A fake `fetch`: routes by method and path, records every call, honours `signal`. */
export class FakeServer {
  readonly calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  /** `true`: an aborted `signal` does not reject the pending answer (a late answer test). */
  ignoreAbort = false;
  private readonly routes: { method: string; match: string | RegExp; handler: Handler }[] = [];

  /** Registers a route; a later one for the same path wins. */
  on(method: string, match: string | RegExp, handler: Handler): this {
    this.routes.unshift({ method: method.toUpperCase(), match, handler });
    return this;
  }

  of(method: string, path: string | RegExp) {
    return this.calls.filter(
      (c) =>
        c.method === method &&
        (typeof path === "string" ? c.path.startsWith(path) : path.test(c.path)),
    );
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === "string" && (headers.get("content-type") ?? "").includes("json")) {
      body = JSON.parse(body);
    }
    this.calls.push({ method, path: url.pathname + url.search, headers, body });
    const route = this.routes.find(
      (r) =>
        r.method === method &&
        (typeof r.match === "string" ? url.pathname === r.match : r.match.test(url.pathname)),
    );
    if (!route) return error(404, "not_found", { route: `${method} ${url.pathname}` });
    const answer = route.handler({ method, url, headers, body });
    const signal = init?.signal;
    if (!signal || this.ignoreAbort) return answer;
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(answer).then(resolve, reject);
    });
  };
}

/** A fake WebSocket: tests drive it with `open()` and `receive()`. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!last) throw new Error("no WebSocket was opened");
    return last;
  }
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  /** The messages sent, parsed. */
  get messages(): { kind: string; id: string; payload?: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export function makeClient(
  server: FakeServer,
  options: Partial<VolaClientOptions> = {},
): VolaClient {
  return new VolaClient({
    baseUrl: BASE,
    apiKey: API_KEY,
    userId: "user-1",
    fetch: server.fetch,
    ...options,
  });
}

export function renderVola(
  ui: ReactNode,
  server: FakeServer,
  props: Partial<VolaProviderProps> & { clientOptions?: Partial<VolaClientOptions> } = {},
): RenderResult & { client: VolaClient } {
  const { clientOptions, ...rest } = props;
  const client = props.client ?? makeClient(server, clientOptions);
  const result = render(
    <VolaProvider
      client={client}
      locale="en"
      WebSocket={FakeWebSocket as unknown as WebSocketConstructor}
      lockAfterMs={0}
      {...rest}
    >
      {ui}
    </VolaProvider>,
  );
  return Object.assign(result, { client });
}

// --- fixtures ----------------------------------------------------------------------------------

export const TENANT = "7b1e2d7c-2a2e-4a6a-9a1f-3c7a1e0b0001";
export const INSTANCE = "7b1e2d7c-2a2e-4a6a-9a1f-3c7a1e0b0002";

export function fileInfo(overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id: "019a0000-0000-7000-8000-000000000001",
    tenant_id: TENANT,
    instance_type: "tickets",
    instance_id: INSTANCE,
    slug: null,
    hash: "a".repeat(64),
    size: 1234,
    filename: "report.pdf",
    extension: "pdf",
    mime_type: "application/pdf",
    kind: "document",
    metadata: {},
    folder_id: null,
    parent_id: null,
    is_public: false,
    is_global_public: false,
    encryption: "none",
    enc_format: null,
    keyring_id: null,
    created_by: "user-1",
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    deleted_at: null,
    deleted_by: null,
    last_accessed_at: null,
    last_accessed_by: null,
    processing_status: null,
    ...overrides,
  };
}

/** A `files` UDC row of a file. */
export function fileRow(overrides: Partial<FileInfo> & { folder_path?: string } = {}): Row {
  const info = fileInfo(overrides);
  const encrypted = info.encryption !== "none";
  return {
    __meta: { id: info.id, version: 1 },
    id: info.id,
    instance_type: info.instance_type,
    instance_id: info.instance_id,
    filename: encrypted ? "<encrypted>" : info.filename,
    kind: info.kind,
    size: info.size,
    extension: encrypted ? null : info.extension,
    mime_type: encrypted ? null : info.mime_type,
    folder_path: overrides.folder_path ?? "",
    folder_id: info.folder_id,
    slug: info.slug,
    hash: info.hash,
    is_public: info.is_public,
    is_global_public: info.is_global_public,
    encryption: info.encryption,
    processing_status: info.processing_status,
    thumb_url: encrypted
      ? null
      : `/vola/files/${info.instance_type}/${info.instance_id}/${info.id}/thumb/256`,
    download_url: `/vola/files/${info.instance_type}/${info.instance_id}/${info.id}`,
    created_by: info.created_by,
    created_at: info.created_at,
    updated_at: info.updated_at,
    deleted_at: info.deleted_at,
    include_deleted: false,
    ocr: false,
  };
}

const field = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

/** `describe` of the `files` collection, as the server answers it (trimmed to the fields the tests need). */
export const FILES_DESCRIBE: DescribeResponse = {
  collection: "files",
  capabilities: {
    mutate: false,
    subscribe: true,
    total_count: true,
    schema_edit: false,
    config_edit: false,
    reindex: false,
    tree_reparent: false,
    source_yaml: false,
    paging: ["cursor"],
    supported_filter_ops: [
      "eq",
      "neq",
      "in",
      "not_in",
      "contains",
      "starts_with",
      "ends_with",
      "gt",
      "gte",
      "lt",
      "lte",
      "between",
      "is_null",
      "is_not_null",
    ],
  },
  source_kind: "postgres_jsonb",
  schema: {
    version: "v1",
    core_fields: ["id"],
    field_order: [
      "id",
      "instance_type",
      "instance_id",
      "filename",
      "kind",
      "size",
      "extension",
      "mime_type",
      "folder_path",
      "is_public",
      "is_global_public",
      "encryption",
      "processing_status",
      "thumb_url",
      "download_url",
      "created_by",
      "created_at",
      "include_deleted",
      "ocr",
    ],
    fields: {
      id: field("string", { required: true }),
      instance_type: field("string", { required: true }),
      instance_id: field("string", { required: true }),
      filename: field("string", { required: true }),
      kind: field("lookup", { ref: "FileKinds" }),
      size: field("integer"),
      extension: field("string"),
      mime_type: field("string"),
      folder_path: field("string"),
      is_public: field("bool"),
      is_global_public: field("bool"),
      encryption: field("lookup", { ref: "EncryptionModes" }),
      processing_status: field("lookup", { ref: "ProcessingStatuses" }),
      thumb_url: field("image"),
      download_url: field("string"),
      created_by: field("string"),
      created_at: field("datetime"),
      include_deleted: field("bool"),
      ocr: field("bool"),
    },
  } as DescribeResponse["schema"],
  view: {
    default_renderer: "table",
    available_renderers: ["table", "cards"],
    pagination: "infinite",
    page_size_default: 50,
    default_column_width: 160,
    row_actions: [],
    columns: [
      { field: "thumb_url", render: "image_thumb", width: 72, align: "center" },
      { field: "filename", width: 280 },
      { field: "kind", render: "lookup", width: 120 },
      { field: "size", render: "bytes", align: "right", width: 100 },
      { field: "folder_path", width: 200 },
      { field: "processing_status", render: "lookup", width: 130 },
      { field: "encryption", render: "lookup", width: 120 },
    ],
    search: { fields: ["filename"], case_insensitive: true },
    filters: [{ field: "kind", kind: "select", options: ["image", "document"] }],
  } as DescribeResponse["view"],
  filterable: { fields: [] },
};

export function keyringStatus(overrides: Partial<KeyringStatus> = {}): KeyringStatus {
  return {
    keyring_id: "019a0000-0000-7000-8000-0000000000aa",
    has_pin: true,
    locked: true,
    unlock_expires_in: null,
    locked_until: null,
    attempts: 0,
    pin_set_at: "2026-11-01T09:00:00.000Z",
    ...overrides,
  };
}

/** The usual answers of a server behind the file browser. */
export function filesServer(
  rows: Row[] = [fileRow()],
  listSpy?: (body: unknown) => void,
): FakeServer {
  const server = new FakeServer();
  server
    .on("POST", "/vola/udc/describe", () => udcOk("describe", FILES_DESCRIBE))
    .on("POST", "/vola/udc/list", ({ body }) => {
      listSpy?.(body);
      return udcOk("list", { rows, next_cursor: null, total: rows.length });
    })
    .on("GET", /^\/vola\/folders\//, () => json({ folder: null, subfolders: [], files: [] }))
    .on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })))
    .on("GET", /\/thumb\/\d+$/, () => error(404, "no_thumbnail"))
    .on("GET", "/vola/lookups", () => json({ sections: {} }));
  return server;
}
