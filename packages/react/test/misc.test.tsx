import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { VolaClient, VolaError } from "@vol-a/client";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  BlobCache,
  KeyringStore,
  useFilesLive,
  useVolaKeyring,
  VOLA_MESSAGES,
  VolaMenu,
  VolaModal,
  VolaProvider,
  VolaThumb,
  VolaUploadButton,
} from "../src/index.js";
import {
  error,
  FakeServer,
  FakeWebSocket,
  fileInfo,
  filesScope,
  json,
  keyringStatus,
  makeClient,
  renderVola,
} from "./fake.js";

describe("VOLA_MESSAGES", () => {
  it("has every term in en and sr", () => {
    const section = VOLA_MESSAGES.VOLA ?? {};
    const terms = Object.keys(section);
    expect(terms.length).toBeGreaterThan(100);
    for (const term of terms) {
      const entry = section[term] ?? {};
      expect(entry.en, term).toBeTruthy();
      expect(entry.sr, term).toBeTruthy();
    }
  });
});

describe("VolaProvider", () => {
  it("builds a client from baseUrl and renders Serbian", async () => {
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    render(
      <VolaProvider baseUrl="http://vola.test/vola/" apiKey="k" fetch={server.fetch} locale="sr">
        <VolaUploadButton instanceType="tickets" instanceId="i" />
      </VolaProvider>,
    );
    expect(screen.getByRole("button", { name: "Otpremi" })).toBeTruthy();
  });

  it("needs a client or a baseUrl", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<VolaProvider />)).toThrow(/client or a baseUrl/);
    spy.mockRestore();
  });

  it("overrides a term through messages", () => {
    const server = new FakeServer();
    const client = makeClient(server);
    render(
      <VolaProvider
        client={client}
        locale="en"
        messages={{ VOLA: { UPLOAD: { en: "Add a file", sr: "Dodaj" } } }}
      >
        <VolaUploadButton instanceType="tickets" instanceId="i" />
      </VolaProvider>,
    );
    expect(screen.getByRole("button", { name: "Add a file" })).toBeTruthy();
  });
});

function ModalHost({ dismissable = true }: { dismissable?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">opener</button>
      <VolaModal
        open={open}
        title="A dialog"
        description="What it is about"
        onClose={() => setOpen(false)}
        dismissable={dismissable}
        footer={<button type="button">ok</button>}
      >
        <input aria-label="first" />
        <input aria-label="second" />
      </VolaModal>
      {open ? null : <p>closed</p>}
    </>
  );
}

function modalServer() {
  const server = new FakeServer();
  server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
  return server;
}

describe("VolaModal", () => {
  it("is a labelled modal dialog that traps the focus and closes on Escape and the overlay", async () => {
    renderVola(<ModalHost />, modalServer());
    const dialog = screen.getByRole("dialog", { name: "A dialog" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("What it is about")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("first"));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("second"));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "ok" }));
    // the end of the panel wraps to its first control (the close button, first in DOM order)
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "ok" }));
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByText("closed")).toBeTruthy();
  });

  it("closes on the overlay and the close button, not when not dismissable", async () => {
    const { unmount } = renderVola(<ModalHost />, modalServer());
    const overlay = screen.getByRole("dialog").parentElement as HTMLElement;
    await userEvent.click(overlay);
    expect(await screen.findByText("closed")).toBeTruthy();
    unmount();
    renderVola(<ModalHost dismissable={false} />, modalServer());
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(screen.queryByText("closed")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("closed")).toBeTruthy();
  });
});

describe("VolaMenu", () => {
  it("opens, moves with the arrows, selects with Enter, closes on Escape and outside", async () => {
    const picked: string[] = [];
    render(
      <>
        <button type="button">outside</button>
        <VolaMenu
          label="More"
          items={[
            { key: "a", label: "Alpha", onSelect: () => picked.push("a") },
            { key: "b", label: "Beta", onSelect: () => picked.push("b"), disabled: true },
            { key: "c", label: "Gamma", onSelect: () => picked.push("c"), danger: true },
          ]}
        />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Alpha" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Gamma" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Alpha" }));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Gamma" }));
    await userEvent.keyboard("{Enter}");
    expect(picked).toEqual(["c"]);
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("KeyringStore", () => {
  it("reads the status, reports errors, gates the lock phase and handles 423", async () => {
    const server = new FakeServer();
    let fail = true;
    server.on("GET", "/vola/keyrings/me/status", () =>
      fail ? error(500, "boom") : json(keyringStatus()),
    );
    const client = makeClient(server);
    const store = new KeyringStore(client, new BlobCache());
    expect(store.getSnapshot().unlocked).toBe(false);
    expect(await store.refresh()).toBeNull();
    expect(store.getSnapshot().error).toBeInstanceOf(VolaError);
    fail = false;
    const both = [store.refresh(), store.refresh()];
    expect(both[0]).toBe(both[1]); // one read at a time
    expect((await both[0])?.has_pin).toBe(true);
    expect(store.getSnapshot().hasPin).toBe(true);
    // not unlocked: the auto-lock has nothing to report
    store.setLockPhase("countdown", 500);
    expect(store.getSnapshot().lockPhase).toBe("locked");
    expect(store.handleError(new Error("other"))).toBe(false);
    // a 423 while locked is nothing new: no generation bump
    const blobs = store.blobs;
    const gen = blobs.gen;
    expect(
      store.handleError(new VolaError({ status: 423, code: "vola_locked", message: "" })),
    ).toBe(false);
    expect(blobs.gen).toBe(gen);
  });

  it("an unlocked store: touch() cancels the countdown, a status that says locked locks", async () => {
    const server = new FakeServer();
    let serverLocked = false;
    server.on("GET", "/vola/keyrings/me/status", () =>
      json(keyringStatus({ locked: serverLocked })),
    );
    const client = new VolaClient({
      baseUrl: "http://vola.test/vola",
      apiKey: "k",
      userId: "u",
      fetch: server.fetch,
      unlock: "tok",
    });
    const blobs = new BlobCache();
    const store = new KeyringStore(client, blobs);
    expect(store.getSnapshot().unlocked).toBe(true);
    store.setLockPhase("countdown", 500);
    expect(store.getSnapshot().lockPhase).toBe("countdown");
    store.touch();
    expect(store.getSnapshot().lockPhase).toBe("live");
    blobs.put("x", new Blob(["x"]));
    serverLocked = true; // the token expired on the server
    await store.refresh();
    expect(store.getSnapshot().unlocked).toBe(false);
    expect(blobs.size).toBe(0);
  });
});

function StayProbe() {
  const k = useVolaKeyring();
  return (
    <>
      <span data-testid="phase">{k.lockPhase}</span>
      <button type="button" onClick={() => k.store.setLockPhase("countdown", 3000)}>
        countdown
      </button>
      <button type="button" onClick={k.stay}>
        stay
      </button>
    </>
  );
}

describe("useVolaKeyring", () => {
  it("exposes the phase and stay()", async () => {
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ locked: false })));
    renderVola(<StayProbe />, server, { clientOptions: { unlock: "tok" } });
    expect(screen.getByTestId("phase").textContent).toBe("live");
    await userEvent.click(screen.getByText("countdown"));
    expect(screen.getByTestId("phase").textContent).toBe("countdown");
    await userEvent.click(screen.getByText("stay"));
    expect(screen.getByTestId("phase").textContent).toBe("live");
  });
});

describe("VolaThumb errors", () => {
  it("shows the error placeholder on a 500 and stops retrying after maxRetries", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("GET", /000001\/thumb\/64$/, () => error(500, "boom"));
    server.on("GET", /000002\/thumb\/64$/, () => {
      calls += 1;
      return new Response(new Blob([new Uint8Array([0])]), {
        status: 202,
        headers: { "x-thumbnail-status": "generating" },
      });
    });
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    renderVola(
      <>
        <VolaThumb file={fileInfo()} size={64} />
        <VolaThumb
          file={fileInfo({ id: "019a0000-0000-7000-8000-000000000002" })}
          size={64}
          maxRetries={1}
          retryBaseMs={5}
        />
      </>,
      server,
    );
    expect(await screen.findByRole("img", { name: "Preview failed" })).toBeTruthy();
    await waitFor(() => expect(calls).toBe(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(2);
    expect(screen.getByRole("img", { name: "Thumbnail is being made" })).toBeTruthy();
  });
});

function LiveProbe({ enabled }: { enabled: boolean }) {
  const status = useFilesLive({ filter: filesScope("tickets", "i", ""), enabled });
  return <span data-testid="status">{status}</span>;
}

describe("useFilesLive extras", () => {
  it("is off when disabled, offers vola.v1 alone without a key, goes offline on subscribe.err", async () => {
    FakeWebSocket.instances.length = 0;
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    const { rerender, client } = renderVola(<LiveProbe enabled={false} />, server, {
      clientOptions: { apiKey: undefined },
    });
    expect(screen.getByTestId("status").textContent).toBe("off");
    expect(FakeWebSocket.instances.length).toBe(0);
    await act(async () => {
      rerender(
        <VolaProvider
          client={client}
          locale="en"
          WebSocket={FakeWebSocket as never}
          lockAfterMs={0}
        >
          <LiveProbe enabled />
        </VolaProvider>,
      );
    });
    const ws = FakeWebSocket.last;
    expect(ws.protocols).toEqual(["vola.v1"]);
    act(() => {
      ws.open();
      ws.receive({ kind: "udc.welcome", id: "", payload: {} });
      ws.receive({
        kind: "udc.subscribe.err",
        id: "files",
        payload: { code: "validation_error", message: "no" },
      });
    });
    expect(screen.getByTestId("status").textContent).toBe("offline");
    act(() => ws.receive("not json"));
  });
});

describe("VolaUploadList", () => {
  it("cancels from the list and shows a failure with resume", async () => {
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    let release: (() => void) | null = null;
    let attempt = 0;
    server.on("POST", /^\/vola\/files\//, () => {
      attempt += 1;
      if (attempt === 1)
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(fileInfo(), 201));
        });
      if (attempt === 2) return error(413, "file_too_large");
      return json(fileInfo(), 201);
    });
    const onError = vi.fn();
    renderVola(
      <VolaUploadButton instanceType="tickets" instanceId="i" onError={onError} />,
      server,
    );
    const input = screen.getByLabelText("Choose files");
    await userEvent.upload(input, new File(["a"], "a.txt"));
    await waitFor(() => expect(release).not.toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/Uploading/);
    await userEvent.click(screen.getByRole("button", { name: "Cancel upload of a.txt" }));
    expect(await screen.findByText("Cancelled — can be resumed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Failed: file_too_large")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Uploaded")).toBeTruthy();
  });
});
