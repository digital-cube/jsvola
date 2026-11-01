import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { VolaClient } from "@vola/client";
import type { FileEncryption, FileInfo } from "@vola/core";
import { SEEDER_USER, VolaError } from "@vola/server";

/** One entry of `assets/manifest.json`. */
export interface SeedEntry {
  /** The file, relative to the manifest's directory. */
  path: string;
  /** The slug the upload is upserted under (`PUT /files/:type/:id/slug/:slug`). */
  slug: string;
  /** The folder path it lands in (created when missing); the root when absent. */
  folder?: string | undefined;
  /** The MIME type sent with it (the server sniffs anyway). */
  mime?: string | undefined;
  /** `tenant` for a file stored encrypted at rest; absent: the tenant's default. */
  encryption?: FileEncryption | undefined;
  /** Mark it `is_global_public` afterwards (the streaming page plays it without a key). */
  public?: boolean | undefined;
  /** A human title, kept in the file's metadata. */
  title?: string | undefined;
}

export interface SeedManifest {
  files: SeedEntry[];
}

export interface SeedOptions {
  /** The API base URL (`http://vola:8300/vola`). */
  url: string;
  /** A key with `files:write` and `folders:write` of the demo tenant (`VOLA_DEMO_WRITE_KEY`). */
  key: string;
  /** The directory with `manifest.json` and the files it names. */
  assets: string;
  instanceType: string;
  instanceId: string;
  /** Seconds to wait for `GET /health/ready` before giving up. Default 120; `0` does not wait. */
  waitS?: number | undefined;
  fetch?: typeof fetch | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface SeedResult {
  uploaded: string[];
  /** Entries whose slug already held the same bytes (or an encrypted file of the same size). */
  unchanged: string[];
  /** Entries marked `is_global_public` this run. */
  published: string[];
}

/** Reads and checks `manifest.json`. */
export async function readManifest(dir: string): Promise<SeedManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new VolaError(
      "validation_error",
      422,
      `${join(dir, "manifest.json")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(files)) {
    throw new VolaError("validation_error", 422, "manifest.json: a `files` array is required");
  }
  for (const entry of files as SeedEntry[]) {
    if (typeof entry?.path !== "string" || typeof entry?.slug !== "string") {
      throw new VolaError(
        "validation_error",
        422,
        "manifest.json: every file needs `path` and `slug`",
      );
    }
  }
  return { files: files as SeedEntry[] };
}

async function waitReady(client: VolaClient, waitS: number, log: (line: string) => void) {
  const deadline = Date.now() + waitS * 1000;
  let said = false;
  for (;;) {
    try {
      const ready = await client.ready();
      if (ready.status === "ok") return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) {
      throw new VolaError(
        "service_unavailable",
        503,
        `${client.baseUrl} is not ready after ${waitS} s`,
      );
    }
    if (!said) {
      log(`waiting for ${client.baseUrl}/health/ready …`);
      said = true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The live files of the instance by slug (one listing, so a restart costs one request per page). */
async function bySlug(
  client: VolaClient,
  type: string,
  id: string,
): Promise<Map<string, FileInfo>> {
  const map = new Map<string, FileInfo>();
  for await (const file of client.files.iterate(type, id, { limit: 200 })) {
    if (file.slug) map.set(file.slug, file);
  }
  return map;
}

/**
 * Uploads the demo pack: every manifest entry is upserted under its slug, attributed to the
 * seeder (`X-User-Id: seeder`), so the purge never touches it and the proxy never lets a
 * visitor write to it. A slug that already holds the same bytes is left alone, so a restart
 * of the stack adds nothing. Media marked `public` are set `is_global_public` afterwards.
 */
export async function seedDemo(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);
  const dir = isAbsolute(options.assets) ? options.assets : resolve(options.assets);
  const manifest = await readManifest(dir);
  const client = new VolaClient({
    baseUrl: options.url,
    apiKey: options.key,
    userId: SEEDER_USER,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  await waitReady(client, options.waitS ?? 120, log);

  const type = options.instanceType;
  const id = options.instanceId;
  const result: SeedResult = { uploaded: [], unchanged: [], published: [] };
  const slugs = await bySlug(client, type, id);
  for (const entry of manifest.files) {
    const bytes = await readFile(join(dir, entry.path));
    const filename = entry.path.split("/").pop() ?? entry.slug;
    const before = slugs.get(entry.slug) ?? null;
    const same =
      before !== null &&
      (before.encryption === "none"
        ? before.hash === createHash("sha256").update(bytes).digest("hex")
        : before.size === bytes.length && before.filename === filename);
    let info = before;
    if (same) {
      result.unchanged.push(entry.slug);
    } else {
      info = await client.files.putSlug(type, id, entry.slug, bytes, {
        filename,
        contentType: entry.mime,
        folderPath: entry.folder ?? "",
        encryption: entry.encryption,
        metadata: { source: "demo pack", title: entry.title ?? filename },
      });
      result.uploaded.push(entry.slug);
      log(`uploaded ${entry.path} → ${info.id}${entry.encryption ? ` (${entry.encryption})` : ""}`);
    }
    if (entry.public && info && !info.is_global_public) {
      await client.files.patch(type, id, info.id, { is_global_public: true });
      result.published.push(entry.slug);
      log(`published ${entry.path} (is_global_public)`);
    }
  }
  log(
    `demo pack: ${result.uploaded.length} uploaded, ${result.unchanged.length} unchanged, ${result.published.length} published`,
  );
  return result;
}
