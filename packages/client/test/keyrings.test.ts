import { describe, expect, it } from "vitest";
import type { VolaError } from "../src/index.js";
import { errorResponse, jsonResponse, makeClient } from "./fake.js";

const STATUS = {
  keyring_id: "66666666-6666-4666-8666-666666666666",
  has_pin: true,
  locked: false,
  unlock_expires_in: 100,
  locked_until: null,
  attempts: 0,
  pin_set_at: "2026-01-01T00:00:00.000Z",
};

describe("keyrings", () => {
  it("status, setup, unlock (remembers the token), status with the token, lock (forgets it)", async () => {
    const { client, last, calls } = makeClient(
      (call) => {
        if (call.path.endsWith("/status")) return jsonResponse(STATUS);
        if (call.path === "/vola/keyrings/me" && call.method === "POST")
          return jsonResponse({ keyring_id: STATUS.keyring_id, recovery_key: "AAAA-BBBB" }, 201);
        if (call.path.endsWith("/unlock") && call.method === "POST")
          return jsonResponse({ token: "tok-1", expires_in: 150 });
        if (call.path.endsWith("/unlock") && call.method === "DELETE")
          return new Response(null, { status: 204 });
        return undefined;
      },
      { userId: "u-1" },
    );
    expect(await client.keyrings.status()).toEqual(STATUS);
    expect(last().headers.get("x-user-id")).toBe("u-1");
    expect((await client.keyrings.setup("123456")).recovery_key).toBe("AAAA-BBBB");
    expect(last().json).toEqual({ pin: "123456" });
    expect(last().url).not.toContain("123456");

    const unlocked = await client.keyrings.unlock("123456");
    expect(unlocked.token).toBe("tok-1");
    expect(client.unlocked).toBe(true);
    await client.keyrings.status();
    expect(last().headers.get("x-vola-unlock")).toBe("tok-1");

    await client.lock();
    expect(last().method).toBe("DELETE");
    expect(last().path).toBe("/vola/keyrings/me/unlock");
    expect(last().headers.get("x-vola-unlock")).toBe("tok-1");
    expect(client.unlocked).toBe(false);
    const before = calls.length;
    await client.lock(); // nothing held: nothing sent
    expect(calls).toHaveLength(before);
    await client.keyrings.lock({ unlock: "other" }); // an explicit token is ended without touching the instance
    expect(last().headers.get("x-vola-unlock")).toBe("other");

    await client.keyrings.unlock("123456", { remember: false });
    expect(client.unlocked).toBe(false);
  });

  it("changePin, recover and reset forget the token; close is the anonymous beacon alias", async () => {
    const { client, last } = makeClient((call) => {
      if (call.path.endsWith("/pin")) return new Response(null, { status: 204 });
      if (call.path.endsWith("/recover"))
        return jsonResponse({ keyring_id: STATUS.keyring_id, recovery_key: "NEW" });
      if (call.path.endsWith("/reset"))
        return jsonResponse({ keyring_id: STATUS.keyring_id, files: 2, blobs: 2 });
      if (call.path.endsWith("/unlock/close")) return new Response(null, { status: 204 });
      if (call.path.endsWith("/delete-preview"))
        return jsonResponse({ keyring_id: STATUS.keyring_id, files: 2, live_files: 1, bytes: 10 });
      return undefined;
    });
    client.setUnlock("tok");
    await client.keyrings.changePin("111111", "222222");
    expect(last().method).toBe("PUT");
    expect(last().json).toEqual({ current_pin: "111111", new_pin: "222222" });
    expect(client.unlocked).toBe(false);

    client.setUnlock("tok");
    expect((await client.keyrings.recover("AAAA-BBBB", "333333")).recovery_key).toBe("NEW");
    expect(last().json).toEqual({ recovery_key: "AAAA-BBBB", new_pin: "333333" });
    expect(client.unlocked).toBe(false);

    client.setUnlock("tok");
    expect((await client.keyrings.reset()).files).toBe(2);
    expect(last().json).toEqual({ confirm: "RESET" });
    expect(client.unlocked).toBe(false);

    expect((await client.keyrings.deletePreview()).live_files).toBe(1);

    await client.keyrings.close("tok-x");
    expect(last().json).toEqual({ token: "tok-x" });
    expect(last().headers.get("authorization")).toBeNull();
  });

  it("a lock-out comes back as 429 with retryAfter; a wrong PIN with its attempts", async () => {
    let attempts = 0;
    const { client } = makeClient(() =>
      attempts++ === 0
        ? errorResponse(403, "pin_wrong", "wrong", { attempts: 1 })
        : errorResponse(
            429,
            "too_many_attempts",
            "wait",
            { retry_after: 30 },
            { "retry-after": "30" },
          ),
    );
    const wrong = await client.keyrings.unlock("000000").catch((e: unknown) => e as VolaError);
    expect(wrong).toMatchObject({ status: 403, code: "pin_wrong", details: { attempts: 1 } });
    const locked = await client.keyrings.unlock("000000").catch((e: unknown) => e as VolaError);
    expect(locked).toMatchObject({ status: 429, retryAfter: 30 });
    expect(client.unlocked).toBe(false);
  });

  it("admin: statusOf and resetOf address another principal", async () => {
    const { client, last } = makeClient((call) =>
      call.path.endsWith("/status")
        ? jsonResponse(STATUS)
        : jsonResponse({ keyring_id: STATUS.keyring_id, files: 0, blobs: 0 }),
    );
    await client.keyrings.statusOf("user/1");
    expect(last().path).toBe("/vola/keyrings/by-principal/user%2F1/status");
    await client.keyrings.resetOf("user/1");
    expect(last().path).toBe("/vola/keyrings/by-principal/user%2F1/reset");
    expect(last().json).toEqual({ confirm: "RESET" });
  });
});
