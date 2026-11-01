import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemBackend } from "../src/storage/index.js";
import { bearer, type Fixture, setupFixture, testDatabase, truncate } from "./helpers.js";

const MiB = 1024 * 1024;
const UPLOAD_SIZE = 100 * MiB;
/** How much the process may grow while 100 MiB flow through it. */
const RSS_BUDGET = 32 * MiB;
const BOUNDARY = "----vola-streaming-test";

/**
 * [slow] A 100 MiB upload must stream: the bytes go from the socket through the hasher to the
 * temp file without the request body or the file being held in memory. Measured over a real
 * HTTP connection (light-my-request copies chunks while re-reading its payload stream), after
 * one warm-up upload of the same size: every socket read is a fresh buffer that V8 lets pile up
 * to its external-memory allowance (~64 MiB) before collecting, and the allocator keeps those
 * pages — so the first big upload of a process grows the RSS by that allowance WHATEVER its
 * size (100 MiB and 300 MiB alike), and every later one reuses the memory. A server that
 * buffered the body would grow by the upload size on every run. `VOLA_SKIP_SLOW=1` skips it.
 */
describe.skipIf(process.env.VOLA_SKIP_SLOW === "1")("streaming upload [slow]", () => {
  const handle = testDatabase(2);
  let fx: Fixture;
  let app: FastifyInstance;
  let port: number;
  let root: string;
  let storage: FilesystemBackend;

  beforeAll(async () => {
    await truncate(handle);
    root = await mkdtemp(join(tmpdir(), "vola-stream-"));
    storage = new FilesystemBackend(root);
    fx = await setupFixture(handle, { storage });
    app = fx.app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  /**
   * A multipart body whose file part is `size` bytes in 64 KiB chunks, hashed on the way. The
   * chunks are views of ONE random seed: a generator allocating a fresh buffer per chunk would
   * add 100 MiB of its own garbage to the process and say nothing about the server (in
   * production the client is another process).
   */
  function multipartOf(size: number, hasher: ReturnType<typeof createHash>): Readable {
    const seed = randomBytes(64 * 1024);
    let produced = 0;
    let stage: "head" | "file" | "tail" | "done" = "head";
    return new Readable({
      read() {
        switch (stage) {
          case "head":
            stage = "file";
            this.push(
              Buffer.from(
                `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
                  "Content-Type: application/octet-stream\r\n\r\n",
              ),
            );
            return;
          case "file": {
            if (produced >= size) {
              stage = "tail";
              this.push(
                Buffer.from(
                  `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"big":true}\r\n--${BOUNDARY}--\r\n`,
                ),
              );
              return;
            }
            const chunk = seed.subarray(0, Math.min(seed.length, size - produced));
            produced += chunk.length;
            hasher.update(chunk);
            this.push(chunk);
            return;
          }
          case "tail":
            stage = "done";
            this.push(null);
            return;
          default:
            return;
        }
      },
    });
  }

  /** POSTs a streamed multipart body of `size` bytes over HTTP; resolves with status and body. */
  function post(instanceId: string, size: number, hasher: ReturnType<typeof createHash>) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/vola/files/stream_test/${instanceId}`,
          headers: {
            ...bearer(fx.full.key),
            "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      pipeline(multipartOf(size, hasher), req).catch(reject);
    });
  }

  it("uploads 100 MiB without raising the RSS by more than ~32 MiB", async () => {
    // Warm-up: the first big request of the process pays for the allocator, not for the bytes.
    const warmHasher = createHash("sha256");
    const warm = await post(randomUUID(), UPLOAD_SIZE, warmHasher);
    expect(warm.status, warm.body).toBe(201);
    expect(JSON.parse(warm.body).hash).toBe(warmHasher.digest("hex"));

    const hasher = createHash("sha256");
    const instanceId = randomUUID();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    let response: { status: number; body: string };
    try {
      response = await post(instanceId, UPLOAD_SIZE, hasher);
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    const grew = peak - before;
    console.log(
      `streaming upload: rss before ${(before / MiB).toFixed(1)} MiB, peak +${(grew / MiB).toFixed(1)} MiB`,
    );

    expect(response.status, response.body).toBe(201);
    const info = JSON.parse(response.body) as {
      id: string;
      hash: string;
      size: number;
      metadata: unknown;
    };
    expect(info).toMatchObject({
      size: UPLOAD_SIZE,
      hash: hasher.digest("hex"),
      metadata: { big: true },
    });
    expect(await readdir(storage.tmpDir)).toEqual([]);
    expect((await storage.stat(info.hash))?.size).toBe(UPLOAD_SIZE);
    expect(grew).toBeLessThan(RSS_BUDGET);

    // A seek into the big file reads only the slice.
    const tail = await app.inject({
      method: "GET",
      url: `/vola/files/stream_test/${instanceId}/${info.id}`,
      headers: { ...bearer(fx.full.key), range: `bytes=${UPLOAD_SIZE - 16}-` },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers["content-range"]).toBe(
      `bytes ${UPLOAD_SIZE - 16}-${UPLOAD_SIZE - 1}/${UPLOAD_SIZE}`,
    );
    expect(tail.rawPayload).toHaveLength(16);
  }, 120_000);
});
