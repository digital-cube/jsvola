import { describe, expect, it } from "vitest";
import { jsonResponse, makeClient } from "./fake.js";

describe("stats, keys, admin", () => {
  it("stats.tenant / instance / storage with ?recompute=1", async () => {
    const { client, last } = makeClient(() => jsonResponse({ scope: "tenant" }));
    await client.stats.tenant({ recompute: true });
    expect(last().url).toBe("http://vola.test/vola/stats/tenant?recompute=1");
    await client.stats.instance("tickets", "i-1");
    expect(last().url).toBe("http://vola.test/vola/stats/instance/tickets/i-1");
    await client.stats.storage();
    expect(last().url).toBe("http://vola.test/vola/stats/storage");
  });

  it("keys.create / list / revoke", async () => {
    const { client, last } = makeClient((call) =>
      call.method === "GET" ? jsonResponse({ keys: [] }) : jsonResponse({ id: "k" }, 201),
    );
    await client.keys.create({ name: "ci", scopes: ["files:read"], env: "test" });
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/vola/keys");
    expect(last().json).toEqual({ name: "ci", scopes: ["files:read"], env: "test" });
    expect(await client.keys.list()).toEqual({ keys: [] });
    await client.keys.revoke("k-1");
    expect(last().method).toBe("DELETE");
    expect(last().path).toBe("/vola/keys/k-1");
  });

  it("admin.transfer posts the request as given", async () => {
    const { client, last } = makeClient(() => jsonResponse({ dry_run: true }));
    const body = {
      from_tenant: "a",
      to_tenant: "b",
      instances: [{ instance_type: "tickets", instance_id: "i" }],
      dry_run: true,
    };
    await client.admin.transfer(body);
    expect(last().path).toBe("/vola/admin/transfer");
    expect(last().json).toEqual(body);
  });
});
