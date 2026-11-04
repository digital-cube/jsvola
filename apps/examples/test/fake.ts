/**
 * A `fetch` that plays a vola server with the examples on: `/examples/config`, the write
 * proxy, the UDC actions (`collections`, `describe`, `list` of `files` and `menu`), the file
 * routes the pages read, thumbnails, the public route with `Range`, shares and keyrings.
 * Built on `@vol-a/react`'s test fake (the same `files` describe and rows the components were
 * tested with).
 */
import type { Row } from "@jsudc/core";
import type { FileInfo } from "@vol-a/core";
import {
  error,
  type FakeRequest,
  FakeServer,
  FakeWebSocket,
  FILES_DESCRIBE,
  fileInfo,
  fileRow,
  json,
  udcOk,
} from "../../../packages/react/test/fake.js";
import type { ExamplesConfig } from "../src/connection.js";
import { menuRow } from "../src/shell/menu.js";

export { FakeWebSocket, fileInfo };

export const BASE = "/vola";
export const INSTANCE = "00000000-0000-4000-8000-000000000001";
export const READ_KEY = "vola_test_readreadreadreadreadreadread00";

export const CONFIG: ExamplesConfig = {
  api_key: READ_KEY,
  tenant: "demo",
  instance_type: "demo",
  instance_id: INSTANCE,
  user_prefix: "demo-",
  write_path: "/vola/examples/write/",
  limits: {
    max_upload_bytes: 5 * 1024 * 1024,
    ttl_hours: 24,
    rate_limit: 60,
    rate_window_s: 600,
    mime_types: [
      "image/png",
      "image/jpeg",
      "application/pdf",
      "video/mp4",
      "audio/mpeg",
      "text/plain",
    ],
  },
  features: { keyring: true, tenant_encryption: true, worker: true },
};

const demoFile = (overrides: Partial<FileInfo> & { folder_path?: string }) =>
  fileInfo({ instance_type: "demo", instance_id: INSTANCE, created_by: "seeder", ...overrides });

/** The seeded pack, as the server lists it. */
export const DEMO_FILES: (FileInfo & { folder_path?: string })[] = [
  demoFile({
    id: "019a0000-0000-7000-8000-000000000101",
    filename: "aurora.jpg",
    slug: "aurora",
    mime_type: "image/jpeg",
    kind: "image",
    extension: "jpg",
    folder_path: "images",
  }),
  demoFile({
    id: "019a0000-0000-7000-8000-000000000102",
    filename: "geometry.png",
    slug: "geometry",
    mime_type: "image/png",
    kind: "image",
    extension: "png",
    folder_path: "images",
  }),
  demoFile({
    id: "019a0000-0000-7000-8000-000000000103",
    filename: "ocr-sample.pdf",
    slug: "ocr-sample",
    mime_type: "application/pdf",
    kind: "document",
    extension: "pdf",
    folder_path: "documents",
  }),
  demoFile({
    id: "019a0000-0000-7000-8000-000000000104",
    filename: "notes.txt",
    slug: "notes",
    mime_type: "text/plain",
    kind: "document",
    extension: "txt",
    folder_path: "documents",
  }),
  demoFile({
    id: "019a0000-0000-7000-8000-000000000105",
    filename: "clip.mp4",
    slug: "clip",
    mime_type: "video/mp4",
    kind: "video",
    extension: "mp4",
    is_global_public: true,
    size: 313_912,
    folder_path: "media",
  }),
  demoFile({
    id: "019a0000-0000-7000-8000-000000000106",
    filename: "tone.mp3",
    slug: "tone",
    mime_type: "audio/mpeg",
    kind: "audio",
    extension: "mp3",
    is_global_public: true,
    size: 96_591,
    folder_path: "media",
  }),
  demoFile({
    id: "019a0000-0000-7000-8000-000000000107",
    filename: "vault-poster.png",
    slug: "vault-poster",
    mime_type: "image/png",
    kind: "image",
    extension: "png",
    encryption: "tenant",
    enc_format: 1,
    folder_path: "encrypted",
  }),
];

/** A menu row as the yaml_menu source flattens it; ids are the path, for readability. */
export const node = (path: string, order: number, fields: Record<string, unknown> = {}): Row =>
  menuRow(path, order, fields, "menu");

/** What the repository's menu.yaml flattens to, `udc:collections` resolved. */
export const SERVED_MENU: Row[] = [
  node("EXAMPLES", 0, { translation_key: "MENU_EXAMPLES", icon: "lucide:layout-dashboard" }),
  ...[
    ["BROWSE", "folder-open", "browse"],
    ["UPLOAD", "plane", "upload"],
    ["THUMBNAILS", "layout-grid", "thumbnails"],
    ["STREAMING", "activity", "streaming"],
    ["SHARE", "globe", "share"],
    ["ENCRYPTED", "building-2", "encrypted"],
    ["API", "book-open", "api"],
  ].map(([code, icon, slug], i) =>
    node(`EXAMPLES/${code}`, i, {
      translation_key: `MENU_${code}`,
      icon: `lucide:${icon}`,
      url: `/examples/${slug}`,
    }),
  ),
  node("COLLECTIONS", 1, { translation_key: "MENU_COLLECTIONS", icon: "lucide:layers" }),
  ...["files", "menu"].map((name, i) =>
    node(`COLLECTIONS/COLLECTION_${name.toUpperCase()}`, i, {
      translation_key: `COLLECTIONS_${name.toUpperCase()}`,
      icon: name === "files" ? "lucide:folder-open" : "lucide:list-tree",
      url: `/udc/${name}`,
      is_dynamic: true,
    }),
  ),
];

const caps = { ...FILES_DESCRIBE.capabilities, subscribe: false };
const listing = (name: string, source_kind: string) => ({
  name,
  default_renderer: "table",
  capabilities: caps,
  source_kind,
  group: source_kind === "yaml_menu" ? "files" : "database",
});

export interface FakeOptions {
  /** Serve `/examples/config`. Default true (404 otherwise). */
  examples?: boolean;
  config?: Partial<ExamplesConfig>;
  /** Serve the `menu` collection. Default true. */
  menu?: boolean;
  files?: (FileInfo & { folder_path?: string })[];
  /** Thumbnails answer `202` until `ready()` is called. */
  generating?: boolean;
  /** `GET /keyrings/me/status` through the proxy: a status, or 503. */
  keyring?: { has_pin: boolean } | null;
  /** What ends a share's `url`: `#<secret>` for an encrypted file's link. */
  shareUrlSuffix?: string;
}

export interface FakeVola {
  fetch: typeof fetch;
  server: FakeServer;
  /** Every request: `METHOD path` (the proxied ones under `/vola/examples/write/`). */
  calls: string[];
  /** The `list` bodies of the UDC `files` collection. */
  lists: Record<string, unknown>[];
  files: (FileInfo & { folder_path?: string })[];
  shares: Record<string, unknown>[];
  ready: () => void;
}

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

export function fakeVola(options: FakeOptions = {}): FakeVola {
  const server = new FakeServer();
  const files = options.files ? [...options.files] : [...DEMO_FILES];
  const config = {
    ...CONFIG,
    ...options.config,
    limits: { ...CONFIG.limits, ...options.config?.limits },
    features: { ...CONFIG.features, ...options.config?.features },
  };
  const lists: Record<string, unknown>[] = [];
  const shares: Record<string, unknown>[] = [];
  let generating = options.generating ?? false;
  const UUID = "[0-9a-f-]{36}";
  const hasKey = (req: FakeRequest) =>
    req.headers.get("authorization") === `Bearer ${READ_KEY}` ||
    (req.headers.get("authorization") ?? "").startsWith("Bearer vola_");
  const find = (id: string) => files.find((f) => f.id === id);

  if (options.examples !== false) {
    server.on("GET", `${BASE}/examples/config`, () =>
      json(config, 200, { "cache-control": "no-store" }),
    );
  }
  server.on("GET", `${BASE}/health/ready`, () =>
    json({ status: "ok", checks: { database: "ok" } }),
  );
  server.on("GET", `${BASE}/health/live`, () => json({ status: "ok" }));

  // --- UDC -------------------------------------------------------------------------------
  server.on("POST", `${BASE}/udc/collections`, (req) =>
    hasKey(req)
      ? udcOk("collections", {
          collections: [
            listing("files", "postgres_jsonb"),
            ...(options.menu === false ? [] : [listing("menu", "yaml_menu")]),
          ],
        })
      : error(401, "unauthorized"),
  );
  server.on("POST", `${BASE}/udc/describe`, (req) => {
    const body = req.body as { collection: string };
    if (body.collection === "menu") {
      return udcOk("describe", {
        ...FILES_DESCRIBE,
        collection: "menu",
        source_kind: "yaml_menu",
        capabilities: caps,
        schema: {
          version: "v1",
          core_fields: [],
          field_order: ["code", "translation_key", "url"],
          fields: {
            code: { type: "string" },
            translation_key: { type: "string" },
            url: { type: "string" },
          },
        },
        view: {
          ...FILES_DESCRIBE.view,
          columns: [{ field: "code" }, { field: "translation_key" }, { field: "url" }],
        },
      });
    }
    return udcOk("describe", { ...FILES_DESCRIBE, capabilities: caps });
  });
  server.on("POST", `${BASE}/udc/list`, (req) => {
    const body = req.body as { collection: string; filter?: unknown };
    if (body.collection === "menu")
      return udcOk("list", { rows: SERVED_MENU, next_cursor: null, total: SERVED_MENU.length });
    lists.push(body);
    const folder = folderOf(body.filter);
    const rows = files
      .filter((f) => folder === null || (f.folder_path ?? "") === folder)
      .map((f) => fileRow(f));
    return udcOk("list", { rows, next_cursor: null, total: rows.length });
  });

  // --- files -----------------------------------------------------------------------------
  server.on("GET", `${BASE}/files/demo/${INSTANCE}`, (req) =>
    hasKey(req) ? json({ files, next_cursor: null }) : error(401, "unauthorized"),
  );
  server.on("POST", `${BASE}/files/demo/${INSTANCE}`, () =>
    error(403, "forbidden", { required: ["files:write"] }),
  );
  server.on("GET", new RegExp(`^${BASE}/files/demo/${INSTANCE}/${UUID}/info$`), (req) => {
    const id = req.url.pathname.split("/").at(-2) ?? "";
    const file = find(id);
    return file ? json({ ...file, ocr: { status: null } }) : error(404, "file_not_found");
  });
  server.on("GET", new RegExp(`^${BASE}/files/demo/${INSTANCE}/${UUID}/thumb/\\d+$`), () =>
    generating
      ? new Response(WEBP, {
          status: 202,
          headers: {
            "content-type": "image/webp",
            "x-thumbnail-status": "generating",
            "cache-control": "no-cache",
          },
        })
      : new Response(WEBP, {
          status: 200,
          headers: { "content-type": "image/webp", "x-thumbnail-status": "ready", etag: '"t"' },
        }),
  );
  server.on("GET", new RegExp(`^${BASE}/files/demo/${INSTANCE}/${UUID}$`), (req) => {
    const file = find(req.url.pathname.split("/").at(-1) ?? "");
    if (!file) return error(404, "file_not_found");
    return new Response(new Uint8Array(32), {
      status: 200,
      headers: {
        "content-type": file.mime_type,
        "content-length": "32",
        "accept-ranges": "bytes",
        etag: `"${file.hash}"`,
      },
    });
  });
  const publicRoute = (req: FakeRequest) => {
    const file = find(req.url.pathname.split("/").at(-1) ?? "");
    if (!file?.is_global_public) return error(404, "file_not_found");
    const range = req.headers.get("range");
    const headers: Record<string, string> = {
      "content-type": file.mime_type,
      "accept-ranges": "bytes",
      etag: `"${file.hash}"`,
      "cache-control": "public, max-age=300",
    };
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(m?.[1] ?? 0);
      const end = m?.[2] ? Number(m[2]) : file.size - 1;
      const length = end - start + 1;
      return new Response(req.method === "HEAD" ? null : new Uint8Array(length), {
        status: 206,
        headers: {
          ...headers,
          "content-range": `bytes ${start}-${end}/${file.size}`,
          "content-length": String(length),
        },
      });
    }
    return new Response(req.method === "HEAD" ? null : new Uint8Array(file.size), {
      status: 200,
      headers: { ...headers, "content-length": String(file.size) },
    });
  };
  server.on("GET", new RegExp(`^${BASE}/public/${UUID}$`), publicRoute);
  server.on("HEAD", new RegExp(`^${BASE}/public/${UUID}$`), publicRoute);
  server.on("GET", `${BASE}/shares`, () => error(403, "forbidden", { required: ["shares:write"] }));
  server.on("GET", `${BASE}/keyrings/me/status`, () =>
    error(403, "forbidden", { required: ["keyrings:write"] }),
  );

  // --- the demo routes ---------------------------------------------------------------------
  server.on("POST", new RegExp(`^${BASE}/examples/regenerate/${UUID}$`), (req) => {
    const id = req.url.pathname.split("/").at(-1) ?? "";
    if (!find(id)) return error(404, "file_not_found");
    generating = true;
    return json({ file_id: id, removed: 3 });
  });
  const W = `${BASE}/examples/write`;
  const visitor = (req: FakeRequest) =>
    /^demo-[a-z0-9]{6,32}$/.test(req.headers.get("x-user-id") ?? "");
  const guard = (req: FakeRequest, answer: () => Response) => {
    if (req.headers.has("authorization"))
      return error(400, "bad_request", { message: "the proxy takes no key" });
    if (!visitor(req)) return error(400, "demo_user_required");
    return answer();
  };
  server.on("POST", `${W}/files/demo/${INSTANCE}`, (req) =>
    guard(req, () => {
      const created = demoFile({
        id: `019a0000-0000-7000-8000-${String(files.length + 1).padStart(12, "0")}`,
        filename: "mine.png",
        mime_type: "image/png",
        kind: "image",
        created_by: req.headers.get("x-user-id"),
        folder_path: "uploads",
      });
      files.unshift(created);
      return json(created, 201);
    }),
  );
  server.on("POST", `${W}/shares`, (req) =>
    guard(req, () => {
      const body = req.body as Record<string, unknown>;
      const share = {
        id: `s-${shares.length + 1}`,
        file_id: body.file_id,
        folder_id: null,
        scope: "PUBLIC_LINK",
        has_password: Boolean(body.password),
        expires_at: body.expires_at ?? null,
        max_downloads: body.max_downloads ?? null,
        download_count: 0,
        created_by: req.headers.get("x-user-id"),
        created_at: new Date().toISOString(),
        revoked_at: null,
        encryption: "none",
      };
      shares.push(share);
      return json(
        {
          ...share,
          token: `tok${shares.length}`,
          url: `http://localhost:3000/vola/s/tok${shares.length}${options.shareUrlSuffix ?? ""}`,
        },
        201,
      );
    }),
  );
  server.on("GET", `${W}/shares`, (req) => guard(req, () => json({ shares })));
  server.on("DELETE", /^\/vola\/examples\/write\/shares\/[^/]+$/, (req) =>
    guard(req, () => {
      const id = req.url.pathname.split("/").at(-1);
      const share = shares.find((s) => s.id === id);
      if (!share) return error(404, "share_not_found");
      share.revoked_at = new Date().toISOString();
      return json(share);
    }),
  );
  server.on("GET", `${W}/keyrings/me/status`, (req) =>
    guard(req, () =>
      options.keyring === null
        ? error(503, "encryption_unavailable")
        : json({
            keyring_id: options.keyring?.has_pin ? "019a0000-0000-7000-8000-00000000ffff" : null,
            has_pin: options.keyring?.has_pin ?? false,
            locked: true,
            unlock_expires_in: null,
            locked_until: null,
            attempts: 0,
            pin_set_at: null,
          }),
    ),
  );
  server.on("POST", `${W}/keyrings/me`, (req) =>
    guard(req, () =>
      json(
        {
          keyring_id: "019a0000-0000-7000-8000-00000000ffff",
          recovery_key: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH",
        },
        201,
      ),
    ),
  );
  server.on("POST", `${W}/keyrings/me/unlock`, (req) =>
    guard(req, () => json({ token: "unlock-token", expires_in: 150 })),
  );
  server.on("DELETE", `${W}/keyrings/me/unlock`, (req) =>
    guard(req, () => new Response(null, { status: 204 })),
  );

  const calls: string[] = [];
  const doFetch: typeof fetch = (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, "http://localhost:3000/");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`);
    return server.fetch(url.href, init);
  };
  return { fetch: doFetch, server, calls, lists, files, shares, ready: () => (generating = false) };
}

/** The `folder_path` an `eq` condition of a UDC filter pins, or `null`. */
function folderOf(filter: unknown): string | null {
  if (!filter || typeof filter !== "object") return null;
  const node = filter as { and?: unknown[]; field?: string; op?: string; value?: unknown };
  if (node.field === "folder_path" && node.op === "eq") return String(node.value ?? "");
  for (const child of node.and ?? []) {
    const found = folderOf(child);
    if (found !== null) return found;
  }
  return null;
}
