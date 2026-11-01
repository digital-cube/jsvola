import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FileInfoSchema } from "@vola/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vola/server";
import { eq } from "drizzle-orm";
import * as tus from "tus-js-client";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

/**
 * The resumable upload through the reference client, `tus-js-client`, unchanged: creation,
 * PATCH in chunks, an abort after the first chunk, a resume from the `Location` the server
 * gave, and termination. The server speaks tus 1.0 natively; this is the compatibility proof.
 * Needs that server's database (skipped for an external `VOLA_E2E_URL`).
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("resumable uploads with tus-js-client", () => {
  let handle: DatabaseHandle;
  let key: string;
  const slug = `e2e-uploads-${Date.now().toString(36)}`;
  const instanceId = randomUUID();
  const endpoint = `${server}/uploads`;
  const auth = () => ({ authorization: `Bearer ${key}`, "x-user-id": "e2e-tus" });

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E uploads" });
    key = (
      await createApiKey(handle.db, {
        tenantId: tenant.id,
        env: "test",
        name: "e2e-uploads",
        scopes: ["files:read", "files:write"],
      })
    ).key;
  });
  afterAll(async () => {
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
    await handle.close();
  });

  function options(
    metadata: Record<string, string>,
    extra: Partial<tus.UploadOptions> = {},
  ): tus.UploadOptions {
    return {
      endpoint,
      headers: auth(),
      metadata: { instance_type: "tickets", instance_id: instanceId, ...metadata },
      chunkSize: 256 * 1024,
      retryDelays: null,
      storeFingerprintForResuming: false,
      ...extra,
    };
  }

  /** Runs `upload` to its end and resolves with the last response. */
  function finish(upload: tus.Upload): Promise<tus.HttpResponse> {
    return new Promise((resolve, reject) => {
      upload.options.onSuccess = (payload) => resolve(payload.lastResponse);
      upload.options.onError = reject;
      upload.start();
    });
  }

  it("uploads in chunks, survives an abort after the first chunk and resumes from the server's offset", async () => {
    const data = randomBytes(1_000_000);
    const hash = createHash("sha256").update(data).digest("hex");

    // 1. Start, let exactly one chunk through, abort.
    const first = new tus.Upload(
      data,
      options({ filename: "Račun.pdf", filetype: "application/pdf" }),
    );
    const accepted = await new Promise<number>((resolve, reject) => {
      first.options.onChunkComplete = (_chunk, bytesAccepted) => {
        void first.abort().then(() => resolve(bytesAccepted));
      };
      first.options.onError = reject;
      first.options.onSuccess = () => reject(new Error("the upload finished before the abort"));
      first.start();
    });
    expect(accepted).toBe(256 * 1024);
    const url = first.url as string;
    expect(url).toMatch(new RegExp(`^${endpoint}/[0-9a-f-]{36}$`));

    // 2. The server knows exactly how much is durable.
    const probe = await fetch(url, {
      method: "HEAD",
      headers: { ...auth(), "tus-resumable": "1.0.0" },
    });
    expect(probe.status).toBe(200);
    expect(probe.headers.get("upload-offset")).toBe(String(accepted));
    expect(probe.headers.get("upload-length")).toBe(String(data.length));
    expect(probe.headers.get("cache-control")).toBe("no-store");
    expect(probe.headers.get("vola-file-id")).toBeNull();

    // 3. A fresh client resumes from the URL and completes.
    const second = new tus.Upload(data, options({ filename: "Račun.pdf" }, { uploadUrl: url }));
    const patches: number[] = [];
    second.options.onBeforeRequest = (req) => {
      if (req.getMethod() === "PATCH") patches.push(Number(req.getHeader("Upload-Offset")));
    };
    const last = await finish(second);
    expect(last.getStatus()).toBe(204);
    expect(patches[0]).toBe(accepted); // resumed where the server said, not from 0
    const fileId = last.getHeader("Vola-File-Id") as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);

    // 4. The file is byte-identical, typed from the declared MIME, attributed, in the instance.
    const download = await fetch(`${server}/files/tickets/${instanceId}/${fileId}`, {
      headers: { "x-api-key": key },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("etag")).toBe(`"${hash}"`);
    expect(Buffer.from(await download.arrayBuffer()).equals(data)).toBe(true);
    const info = FileInfoSchema.parse(
      await (
        await fetch(`${server}/files/tickets/${instanceId}/${fileId}/info`, {
          headers: { "x-api-key": key },
        })
      ).json(),
    );
    expect(info).toMatchObject({
      filename: "Račun.pdf",
      mime_type: "application/pdf",
      size: data.length,
      hash,
      created_by: "e2e-tus",
    });

    // 5. HEAD after completion still answers, with the file id.
    const after = await fetch(url, {
      method: "HEAD",
      headers: { ...auth(), "tus-resumable": "1.0.0" },
    });
    expect(after.headers.get("upload-offset")).toBe(String(data.length));
    expect(after.headers.get("vola-file-id")).toBe(fileId);
  });

  it("places the file by folder_path and slug from the metadata, and terminates an upload", async () => {
    const data = randomBytes(300_000);
    const upload = new tus.Upload(
      data,
      options({ filename: "report.csv", folder_path: "exports/2026", slug: "latest-export" }),
    );
    const last = await finish(upload);
    const fileId = last.getHeader("Vola-File-Id") as string;
    const byPath = await fetch(
      `${server}/files/tickets/${instanceId}/path/exports/2026/report.csv`,
      {
        headers: { "x-api-key": key },
      },
    );
    expect(byPath.status).toBe(200);
    expect(Buffer.from(await byPath.arrayBuffer()).equals(data)).toBe(true);
    const bySlug = await fetch(`${server}/files/tickets/${instanceId}/slug/latest-export`, {
      headers: { "x-api-key": key },
    });
    expect(bySlug.status).toBe(200);
    expect(Buffer.from(await bySlug.arrayBuffer()).equals(data)).toBe(true);
    const info = FileInfoSchema.parse(
      await (
        await fetch(`${server}/files/tickets/${instanceId}/${fileId}/info`, {
          headers: { "x-api-key": key },
        })
      ).json(),
    );
    expect(info).toMatchObject({ slug: "latest-export", kind: "spreadsheet" });

    // Termination: create, send nothing, terminate; the URL is gone.
    const doomed = new tus.Upload(randomBytes(10_000), options({ filename: "doomed.bin" }));
    const url = await new Promise<string>((resolve, reject) => {
      doomed.options.onUploadUrlAvailable = () => {
        void doomed.abort().then(() => resolve(doomed.url as string));
      };
      doomed.options.onError = reject;
      doomed.start();
    });
    await tus.Upload.terminate(url, options({}));
    const gone = await fetch(url, {
      method: "HEAD",
      headers: { ...auth(), "tus-resumable": "1.0.0" },
    });
    expect(gone.status).toBe(404);
  });

  it("answers OPTIONS with the protocol and refuses a client of another version", async () => {
    const opts = await fetch(endpoint, { method: "OPTIONS" });
    expect(opts.status).toBe(204);
    expect(opts.headers.get("tus-resumable")).toBe("1.0.0");
    expect(opts.headers.get("tus-extension")).toBe("creation,termination,expiration");
    expect(Number(opts.headers.get("tus-max-size"))).toBeGreaterThan(0);

    const old = await fetch(endpoint, {
      method: "POST",
      headers: { ...auth(), "tus-resumable": "0.2.2", "upload-length": "1" },
    });
    expect(old.status).toBe(412);
    expect(old.headers.get("tus-version")).toBe("1.0.0");
  });
});
