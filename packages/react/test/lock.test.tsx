import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  BlobCache,
  decideLock,
  useVolaKeyring,
  VolaKeyringStatus,
  VolaPinGate,
  VolaThumb,
} from "../src/index.js";
import { FakeServer, fileInfo, json, keyringStatus, renderVola } from "./fake.js";

const webp = () =>
  new Response(new Blob([new Uint8Array([1])], { type: "image/webp" }), {
    status: 200,
    headers: { "content-type": "image/webp", "x-thumbnail-status": "ready" },
  });

/** A server whose thumbnails need the unlock token (a keyring file). */
function lockedServer(): FakeServer {
  const server = new FakeServer();
  server.on("GET", /\/thumb\/\d+$/, ({ headers }) =>
    headers.get("x-vola-unlock") === "tok"
      ? webp()
      : json({ error: { code: "vola_locked", message: "locked" } }, 423),
  );
  server.on("GET", "/vola/keyrings/me/status", ({ headers }) =>
    json(keyringStatus({ locked: headers.get("x-vola-unlock") !== "tok", unlock_expires_in: 150 })),
  );
  server.on("DELETE", "/vola/keyrings/me/unlock", () => new Response(null, { status: 204 }));
  return server;
}

describe("decideLock", () => {
  it("is live, then counts down, then locks", () => {
    const policy = { idleMs: 120_000, countdownMs: 10_000 };
    expect(decideLock(0, policy)).toEqual({ phase: "live", remainingMs: null });
    expect(decideLock(119_999, policy)).toEqual({ phase: "live", remainingMs: null });
    expect(decideLock(120_000, policy)).toEqual({ phase: "countdown", remainingMs: 10_000 });
    expect(decideLock(127_000, policy)).toEqual({ phase: "countdown", remainingMs: 3_000 });
    expect(decideLock(130_000, policy)).toEqual({ phase: "locked", remainingMs: 0 });
    // a tab that slept through the whole countdown
    expect(decideLock(3_600_000, policy)).toEqual({ phase: "locked", remainingMs: 0 });
  });
});

describe("BlobCache", () => {
  it("revokes every URL on forget() and starts a new generation", () => {
    const cache = new BlobCache();
    const a = cache.put("a", new Blob(["a"]));
    const b = cache.put("b", new Blob(["b"]));
    expect(a).toMatch(/^blob:/);
    expect(cache.get("a")).toBe(a);
    expect(cache.size).toBe(2);
    const gen = cache.gen;
    cache.forget();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(a);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(b);
    expect(cache.size).toBe(0);
    expect(cache.gen).toBe(gen + 1);
  });

  it("refuses an answer that started in an older generation", () => {
    const cache = new BlobCache();
    const started = cache.gen;
    cache.forget();
    expect(cache.put("late", new Blob(["x"]), started)).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });
});

function Lock() {
  const keyring = useVolaKeyring();
  return (
    <button type="button" onClick={() => void keyring.lock()}>
      lock-now
    </button>
  );
}

describe("lock", () => {
  it("revokes every blob: URL, forgets the token and tells the server", async () => {
    const server = lockedServer();
    renderVola(
      <>
        <VolaKeyringStatus />
        <VolaThumb file={fileInfo({ encryption: "keyring" })} size={64} />
        <VolaThumb
          file={fileInfo({ encryption: "keyring", id: "019a0000-0000-7000-8000-000000000002" })}
          size={64}
        />
      </>,
      server,
      { clientOptions: { unlock: "tok" } },
    );
    await waitFor(() => expect(screen.getAllByAltText("report.pdf").length).toBe(2));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Unlocked")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Locked")).toBeTruthy();
    // the thumbnails went back to a placeholder: the next fetch carries no token and gets a 423
    await waitFor(() => expect(screen.getAllByRole("img", { name: "Locked" }).length).toBe(2));
    const ended = server.of("DELETE", "/vola/keyrings/me/unlock");
    expect(ended.length).toBe(1);
    expect(ended[0]?.headers.get("x-vola-unlock")).toBe("tok");
    expect(server.of("GET", "/vola/files/").at(-1)?.headers.get("x-vola-unlock")).toBeNull();
  });

  it("drops a thumbnail answer that arrives after the lock (generation counter)", async () => {
    const server = lockedServer();
    server.ignoreAbort = true;
    const releases: (() => void)[] = [];
    server.on(
      "GET",
      /\/thumb\/64$/,
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(webp()));
        }),
    );
    renderVola(
      <>
        <Lock />
        <VolaThumb file={fileInfo({ encryption: "keyring" })} size={64} />
      </>,
      server,
      { clientOptions: { unlock: "tok" } },
    );
    await waitFor(() => expect(releases.length).toBe(1));
    await userEvent.click(screen.getByText("lock-now"));
    // the answer of the fetch that started before the lock arrives now: dropped
    await act(async () => {
      releases[0]?.();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByAltText("report.pdf")).toBeNull();
  });

  it("locks after the idle time and the countdown; activity during the countdown keeps it open", async () => {
    const server = lockedServer();
    renderVola(
      <VolaPinGate>
        <p>secret content</p>
      </VolaPinGate>,
      server,
      { clientOptions: { unlock: "tok" }, lockAfterMs: 1200, lockCountdownMs: 1500 },
    );
    expect(await screen.findByText("secret content")).toBeTruthy();
    // the tick is every second: at 2 s the idle time (1.2 s) is over and the countdown runs
    expect(await screen.findByText(/Locking in \d s/, undefined, { timeout: 3500 })).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(screen.queryByText(/Locking in/)).toBeNull();
    expect(screen.getByText("secret content")).toBeTruthy();
    // without further activity: countdown again, then the lock (idle ≥ 2.7 s at the 3 s tick)
    await waitFor(() => expect(screen.queryByText("secret content")).toBeNull(), { timeout: 5000 });
    expect(server.of("DELETE", "/vola/keyrings/me/unlock").length).toBe(1);
    expect(screen.getByText("Enter your PIN")).toBeTruthy();
  }, 12_000);

  it("sends the beacon and forgets everything on pagehide", async () => {
    const server = lockedServer();
    const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    renderVola(<VolaThumb file={fileInfo({ encryption: "keyring" })} size={64} />, server, {
      clientOptions: { unlock: "tok" },
    });
    await screen.findByAltText("report.pdf");
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0] ?? [];
    expect(url).toBe("http://vola.test/vola/keyrings/me/unlock/close");
    expect(await (body as Blob).text()).toBe("tok");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText("report.pdf")).toBeNull();
  });
});
