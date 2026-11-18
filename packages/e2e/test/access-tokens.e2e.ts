import { randomBytes, randomUUID } from "node:crypto";
import { VolaClient, VolaError } from "@vol-a/client";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vol-a/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

/**
 * Access tokens (1.2) over real HTTP, BUILT packages: the host's backend (an API key with
 * `access:grant`) issues a token for one row of an e-mail attachment sent to two addresses
 * (one blob, two rows); a client that holds only the token — what a browser gets — downloads
 * its row and the thumbnail, never the other recipient's row, never a list; after a revoke
 * it gets a fresh token through `getAccessToken`. Needs the server's database (skipped for an
 * external `VOLA_E2E_URL`).
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("access tokens (built server)", () => {
  let handle: DatabaseHandle;
  let backend: VolaClient;
  const slug = `e2e-at-${Date.now().toString(36)}`;
  const T = "mail";

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E access tokens" });
    const { key } = await createApiKey(handle.db, {
      tenantId: tenant.id,
      env: "test",
      name: "e2e-host-backend",
      scopes: ["files:read", "files:write", "access:grant"],
    });
    backend = new VolaClient({ baseUrl: server, apiKey: key, validate: true });
  });
  afterAll(async () => {
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
    await handle.close();
  });

  it("the backend issues a token, the token client downloads its row and nothing else", async () => {
    const attachment = randomBytes(50_000);
    const alice = await backend.files.upload(T, randomUUID(), attachment, { filename: "a.bin" });
    const bob = await backend.files.upload(T, randomUUID(), attachment, { filename: "a.bin" });
    expect(bob.hash).toBe(alice.hash);

    const issued = await backend.accessTokens.create({ file_ids: [alice.id], principal: "alice" });
    expect(issued.token).toMatch(/^vola_at_/);

    let refreshes = 0;
    const browser = new VolaClient({
      baseUrl: server,
      accessToken: issued.token,
      getAccessToken: async () => {
        refreshes++;
        return (await backend.accessTokens.create({ file_ids: [alice.id], principal: "alice" }))
          .token;
      },
    });
    const response = await browser.files.download(T, alice.instance_id, alice.id);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(attachment)).toBe(true);
    const part = await browser.files.download(T, alice.instance_id, alice.id, {
      range: { start: 100, end: 199 },
    });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(attachment.subarray(100, 200))).toBe(true);

    await expect(browser.files.download(T, bob.instance_id, bob.id)).rejects.toMatchObject({
      status: 404,
      code: "file_not_found",
    });
    const list = browser.files.list(T, alice.instance_id);
    await expect(list).rejects.toBeInstanceOf(VolaError);
    await expect(list).rejects.toMatchObject({ status: 401 });
    expect(refreshes).toBe(0);

    // Revoked by the backend: the next download fetches a fresh token and goes through.
    await backend.accessTokens.revoke(issued.id);
    const again = await browser.files.download(T, alice.instance_id, alice.id);
    expect(again.status).toBe(200);
    await again.arrayBuffer();
    expect(refreshes).toBe(1);
    expect(browser.accessToken).not.toBe(issued.token);
  });
});
