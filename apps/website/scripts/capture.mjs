#!/usr/bin/env node
/**
 *   VOLA_DEMO_WRITE_KEY=vola_live_… pnpm --filter @vol-a/website capture
 *
 * The home page's "One file, every way to read it" and "The API": one upload to the examples
 * instance and the answers to it, recorded. It uploads the demo pack's aurora.jpg with a few
 * bytes appended (new bytes, so the thumbnails do not exist yet and the first answer really is a
 * 202), then records: info, a Range read, /thumb/256 as 202 and as 200, a share link and opening
 * it, the UDC row. Writes snippets/wire/<name>.req.txt + <name>.out.txt, and the twelve
 * renditions to src/assets/wire/. Then it revokes the share and purges the file; nothing stays.
 *
 * It also runs snippets/api/*.sh as written, one shell, and writes each one's .out.txt.
 *
 * Records are 72 columns wide: an object that fits goes on one line, UUIDs are cut to their first
 * eight characters and hashes to sixteen. The key is never written anywhere: requests show $KEY.
 *
 * VOLA_URL   default {EXAMPLE_URL}/vola. Commit what it writes; the build only reads it.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_URL } from "../src/site.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIRE = join(SITE, "snippets", "wire");
const API = join(SITE, "snippets", "api");
const SHEET = join(SITE, "src", "assets", "wire");
const BASE = (process.env.VOLA_URL || `${EXAMPLE_URL}/vola`).replace(/\/$/, "");
const KEY = process.env.VOLA_DEMO_WRITE_KEY;
if (!KEY) {
  console.error("capture: VOLA_DEMO_WRITE_KEY is not set");
  process.exit(2);
}
const PREFIX = new URL(BASE).pathname;
const INSTANCE = "00000000-0000-4000-8000-000000000001";
// The purge selects on this principal if the script dies before its own clean-up.
const USER = "demo-capture";
const WIDTH = 72;
const RANGE = "bytes=8192-16383";

const short = (text) =>
  text
    .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "$1")
    .replace(/\b([0-9a-f]{16})[0-9a-f]{48}\b/g, "$1…");

/** Indented JSON; whatever fits in the line stays on one line. */
function pretty(value, indent = 0) {
  if (indent === 0) value = JSON.parse(short(JSON.stringify(value)));
  const flat = JSON.stringify(value).replace(/":/g, '": ').replace(/,"/g, ', "');
  if (typeof value !== "object" || value === null || indent + flat.length <= WIDTH) return flat;
  const pad = " ".repeat(indent + 2);
  const items = Array.isArray(value)
    ? value.map((v) => pad + pretty(v, indent + 2))
    : Object.entries(value).map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pretty(v, indent + 2)}`);
  const [open, close] = Array.isArray(value) ? "[]" : "{}";
  return `${open}\n${items.join(",\n")}\n${" ".repeat(indent)}${close}`;
}

/** What the home page shows of a file: the record is the answer, these fields of it. */
const fileView = (j) => ({
  id: j.id,
  hash: j.hash,
  size: j.size,
  filename: j.filename,
  mime_type: j.mime_type,
  kind: j.kind,
  encryption: j.encryption,
  processing_status: j.processing_status,
});

const HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
  "content-disposition",
  "x-thumbnail-status",
  "x-robots-tag",
];
// A body's length changes between a JSON record's full answer and the fields it keeps.
const DROP_FOR_JSON = new Set(["content-length"]);

const title = (header) =>
  header === "etag" ? "ETag" : header.replace(/(^|-)[a-z]/g, (c) => c.toUpperCase());

async function record(
  name,
  { method = "GET", path, headers = {}, body, shown, auth = true, view },
) {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${KEY}` } : {}), "x-user-id": USER, ...headers },
    body,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const answer = [`HTTP/1.1 ${response.status} ${response.statusText}`];
  for (const h of HEADERS) {
    const v = response.headers.get(h);
    if (v && !(contentType.includes("json") && DROP_FOR_JSON.has(h)))
      answer.push(`${title(h)}: ${v}`);
  }
  let json;
  if (contentType.includes("json")) {
    json = JSON.parse(bytes.toString("utf8"));
    answer.push("", pretty(view ? view(json) : json));
  } else if (method !== "HEAD" && bytes.length) {
    answer.push("", `<${bytes.length} bytes of ${contentType.split(";")[0]}>`);
  }
  const request = [
    `${method} ${PREFIX}${path} HTTP/1.1`,
    ...(auth ? ["Authorization: Bearer $KEY"] : []),
    ...Object.entries(headers)
      .filter(([k]) => k !== "x-user-id")
      .map(([k, v]) => `${title(k)}: ${v}`),
    ...(shown ? ["", shown] : []),
  ];
  await writeFile(join(WIRE, `${name}.req.txt`), `${short(request.join("\n"))}\n`);
  await writeFile(join(WIRE, `${name}.out.txt`), `${short(answer.join("\n"))}\n`);
  console.log(`${String(response.status).padEnd(4)} ${name}`);
  return { response, json, bytes };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await rm(WIRE, { recursive: true, force: true });
await mkdir(WIRE, { recursive: true });
await mkdir(SHEET, { recursive: true });

// --- the upload ----------------------------------------------------------------------------
const original = await readFile(join(SITE, "..", "examples", "assets", "images", "aurora.jpg"));
const bytes = Buffer.concat([original, Buffer.from(`captured ${new Date().toISOString()}`)]);
const form = new FormData();
form.append("file", new Blob([bytes], { type: "image/jpeg" }), "aurora.jpg");
const files = `/files/demo/${INSTANCE}`;
const upload = await record("upload", {
  method: "POST",
  path: files,
  body: form,
  shown: `<multipart: file=aurora.jpg, ${bytes.length} bytes>`,
  view: fileView,
});
if (upload.response.status !== 201) throw new Error("the upload failed");
const id = upload.json.id;
const file = `${files}/${id}`;

let shareId;
try {
  // Right after the upload: the worker has not rendered it yet.
  const first = await record("thumb-202", { path: `${file}/thumb/256` });
  if (first.response.status !== 202)
    throw new Error(`the first thumb answered ${first.response.status}`);
  await record("info", { path: `${file}/info`, view: fileView });
  await record("range", { path: file, headers: { range: RANGE } });

  // --- the renditions: every size and every crop ------------------------------------------
  const crops = ["cover", "fit", "attention"];
  for (const crop of crops) {
    for (const size of [64, 128, 256, 512]) {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(`${BASE}${file}/thumb/${size}?crop=${crop}`, {
          headers: { authorization: `Bearer ${KEY}` },
        });
        const body = Buffer.from(await r.arrayBuffer());
        if (r.status === 200) {
          await writeFile(join(SHEET, `aurora-${size}-${crop}.webp`), body);
          break;
        }
        if (attempt > 40) throw new Error(`thumb ${size} ${crop} is still ${r.status}`);
        await sleep(500);
      }
    }
  }
  await record("thumb-200", { path: `${file}/thumb/256` });

  // --- a share link and opening it, without a key ------------------------------------------
  const expires_at = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z/, "Z");
  const payload = { file_id: id, expires_at, max_downloads: 3 };
  const token = (url) => url.split("/s/")[1];
  const cut = (json) => ({
    file_id: json.file_id,
    has_password: json.has_password,
    expires_at: json.expires_at,
    max_downloads: json.max_downloads,
    download_count: json.download_count,
    token: `${json.token.slice(0, 8)}…`,
    url: json.url.replace(token(json.url), `${token(json.url).slice(0, 8)}…`),
  });
  const share = await record("share", {
    method: "POST",
    path: "/shares",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    shown: pretty(payload),
    view: cut,
  });
  shareId = share.json.id;
  await record("share-open", {
    method: "HEAD",
    path: `/s/${share.json.token}`,
    auth: false,
  });
  // The token is live while this runs; the record keeps only its first eight characters.
  for (const suffix of ["req", "out"]) {
    const path = join(WIRE, `share-open.${suffix}.txt`);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replaceAll(share.json.token, `${share.json.token.slice(0, 8)}…`));
  }

  // --- the same file as a row of the files collection --------------------------------------
  const query = {
    collection: "files",
    filter: {
      and: [
        { field: "instance_type", op: "eq", value: "demo" },
        { field: "instance_id", op: "eq", value: INSTANCE },
        { field: "filename", op: "eq", value: "aurora.jpg" },
      ],
    },
    sort: [{ field: "created_at", dir: "desc" }],
    page: { limit: 1 },
  };
  await record("udc-row", {
    method: "POST",
    path: "/udc/list",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    shown: pretty(query),
    view: (j) => ({
      rows: j.payload.rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        kind: r.kind,
        size: r.size,
        hash: r.hash,
        processing_status: r.processing_status,
        thumb_url: r.thumb_url,
        download_url: r.download_url,
      })),
      total: j.payload.total,
    }),
  });
} finally {
  const clean = { authorization: `Bearer ${KEY}`, "x-user-id": USER };
  if (shareId) await fetch(`${BASE}/shares/${shareId}`, { method: "DELETE", headers: clean });
  const gone = await fetch(`${BASE}${file}/purge`, { method: "DELETE", headers: clean });
  console.log(`${gone.status}  purge`);
}

// --- snippets/api/*.sh, one shell, as written ----------------------------------------------
const scripts = (await readdir(API)).filter((n) => n.endsWith(".sh")).sort();
const MARK = "@@capture@@";
const sources = await Promise.all(scripts.map((n) => readFile(join(API, n), "utf8")));
const scratch = join(tmpdir(), `vola-capture-${process.pid}`);
await mkdir(scratch, { recursive: true });
const run = spawnSync("bash", ["-eu", "-c", sources.map((t) => `${t}\necho ${MARK}`).join("\n")], {
  cwd: scratch,
  encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
});
await rm(scratch, { recursive: true, force: true });
if (run.status !== 0) throw new Error(`snippets/api failed:\n${run.stderr}`);
const outs = run.stdout.split(`${MARK}\n`);
await Promise.all(
  scripts.map((name, i) =>
    outs[i]?.trim()
      ? writeFile(join(API, name.replace(/\.sh$/, ".out.txt")), short(outs[i]).replaceAll("\r", ""))
      : rm(join(API, name.replace(/\.sh$/, ".out.txt")), { force: true }),
  ),
);
console.log(`ran snippets/api: ${scripts.join(", ")}`);
