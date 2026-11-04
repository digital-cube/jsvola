import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { THUMBABLE } from "../src/examples/thumbnails/Thumbnails.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import {
  DEMO_FILES,
  type FakeOptions,
  FakeWebSocket,
  fakeVola,
  INSTANCE,
  READ_KEY,
} from "./fake.js";

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

function open(path: string, options: FakeOptions = {}) {
  history.replaceState(null, "", path);
  const server = fakeVola(options);
  const view = render(<App fetch={server.fetch} />);
  return { server, view };
}

describe("Browse", () => {
  it("draws the file browser over the demo instance, live, the folder in the URL", async () => {
    const { server } = open("/examples/browse?folder=images");
    const browse = await screen.findByTestId("browse");
    await within(browse).findByText("aurora.jpg");
    expect(within(browse).queryByText("clip.mp4")).toBeNull();
    // The list was scoped to the demo instance and the folder of the URL.
    expect(server.lists.at(-1)).toBeTruthy();
    expect(JSON.stringify(server.lists.at(-1))).toContain(INSTANCE);
    expect(JSON.stringify(server.lists.at(-1))).toContain('"images"');
    // One WebSocket to /udc/subscribe with the key as the subprotocol.
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    expect(FakeWebSocket.last.url).toContain("/vola/udc/subscribe");
    expect(FakeWebSocket.last.protocols).toContain(`bearer.${READ_KEY}`);
  });

  it("says that writes need a key when the visitor's own key is in use without the proxy", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...defaultSettings({} as ImportMetaEnv), apiKey: "vola_live_mine" }),
    );
    open("/examples/browse", { examples: false });
    expect(await screen.findByText(/Writing needs a key/)).toBeTruthy();
  });
});

describe("Upload", () => {
  it("shows the demo's limits, a drop zone and the upload button", async () => {
    open("/examples/upload");
    const upload = await screen.findByTestId("upload");
    expect(upload.textContent).toContain("up to 5 MiB per file");
    expect(upload.textContent).toContain("purged after 24 h");
    expect(upload.textContent).toContain("60 writes per 10 min");
    expect(screen.getByTestId("drop-zone")).toBeTruthy();
    expect(within(upload).getByRole("button", { name: /Upload/ })).toBeTruthy();
    expect(screen.getByText(/one multipart POST under 1 MiB/)).toBeTruthy();
  });

  it("uploads a dropped file through the write proxy, attributed to the visitor", async () => {
    const { server } = open("/examples/upload");
    const zone = await screen.findByTestId("drop-zone");
    const file = new File([new Uint8Array(2048)], "mine.png", { type: "image/png" });
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    await screen.findByTestId("uploaded");
    const call = server.calls.find((c) => c.startsWith("POST /vola/examples/write/files/demo/"));
    expect(call).toBeTruthy();
    expect(server.files[0]?.filename).toBe("mine.png");
    expect(screen.getByTestId("uploaded").textContent).toContain("mine.png");
  });
});

describe("Thumbnails", () => {
  it("shows every size × crop of the first image, each tile with its state", async () => {
    open("/examples/thumbnails");
    const grid = await screen.findByTestId("thumbnails");
    const tiles = within(grid).getAllByTestId("tile");
    expect(tiles).toHaveLength(12);
    await waitFor(() => expect(tiles.every((t) => t.dataset.state === "ready")).toBe(true));
    expect(grid.textContent).toContain("?crop=attention");
    expect(grid.textContent).toContain("/thumb/512");
    const picker = within(grid).getByTestId("file-picker") as HTMLSelectElement;
    const names = [...picker.options].map((o) => o.textContent);
    expect(names).toContain("ocr-sample.pdf");
    expect(names).not.toContain("clip.mp4");
    expect(names).not.toContain("notes.txt");
    expect(DEMO_FILES.filter((f) => THUMBABLE.test(f.mime_type)).length).toBe(names.length);
  });

  it("regenerates: the tiles ask again and show 202 until the worker is done", async () => {
    const { server } = open("/examples/thumbnails");
    const grid = await screen.findByTestId("thumbnails");
    await waitFor(() =>
      expect(within(grid).getAllByTestId("tile")[0]?.dataset.state).toBe("ready"),
    );
    fireEvent.click(within(grid).getByTestId("regenerate"));
    await screen.findByText(/3 rendition\(s\) dropped/);
    expect(server.calls.some((c) => c.startsWith("POST /vola/examples/regenerate/"))).toBe(true);
    await waitFor(() =>
      expect(within(grid).getAllByTestId("tile")[0]?.dataset.state).toBe("generating"),
    );
    expect(within(grid).getAllByTestId("tile")[0]?.textContent).toContain("202");
    server.ready();
    await waitFor(
      () => expect(within(grid).getAllByTestId("tile")[0]?.dataset.state).toBe("ready"),
      {
        timeout: 4000,
      },
    );
  });

  it("says when there is nothing to show", async () => {
    open("/examples/thumbnails", { files: [] });
    expect(await screen.findByTestId("seed-hint")).toBeTruthy();
    expect(screen.getByText(/--profile demo up -d seeder/)).toBeTruthy();
  });
});

describe("Range & streaming", () => {
  it("plays the public media and shows the 206 of its own Range probe", async () => {
    const { server } = open("/examples/streaming");
    const page = await screen.findByTestId("streaming");
    const video = within(page).getByTestId("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(`/vola/public/${DEMO_FILES[4]?.id}`);
    const result = await screen.findByTestId("probe-result");
    expect(result.dataset.status).toBe("206");
    expect(result.textContent).toContain("bytes 0-1023/313912");
    expect(result.textContent).toContain("1024");
    expect(server.calls).toContain(`GET /vola/public/${DEMO_FILES[4]?.id}`);
    // The audio file through the picker.
    fireEvent.change(within(page).getByTestId("file-picker"), {
      target: { value: DEMO_FILES[5]?.id },
    });
    expect(await within(page).findByTestId("audio")).toBeTruthy();
    // A HEAD.
    fireEvent.click(screen.getByRole("button", { name: "HEAD" }));
    await waitFor(() =>
      expect(screen.getByTestId("probe-result").textContent).toContain("HEAD /vola/public/"),
    );
    expect(screen.getByTestId("probe-result").dataset.status).toBe("200");
  });
});

describe("Share", () => {
  it("opens the share dialog and shows the last link made through the proxy", async () => {
    const { server } = open("/examples/share");
    const page = await screen.findByTestId("share");
    fireEvent.click(within(page).getByTestId("share-open"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Create link/i }));
    const last = await screen.findByTestId("share-last");
    expect(last.textContent).toContain("http://localhost:3000/vola/s/tok1");
    expect(server.calls).toContain("POST /vola/examples/write/shares");
    expect(server.shares[0]?.file_id).toBe(DEMO_FILES[0]?.id);
    expect(
      within(last).getByRole("link", { name: "Open in a new tab" }).getAttribute("target"),
    ).toBe("_blank");
    expect(last.textContent).not.toContain("X-Share-Secret");
    expect(within(last).queryByTestId("share-open-secret")).toBeNull();
  });

  it("opens an encrypted file's link with X-Share-Secret, and the curl sends it too", async () => {
    open("/examples/share", { shareUrlSuffix: "#s3cret" });
    const sent = vi.fn(async () => new Response("the bytes", { status: 200 }));
    vi.stubGlobal("fetch", sent);
    const tab = { location: { href: "" }, close: vi.fn() };
    const opened = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    URL.createObjectURL = vi.fn(() => "blob:the-file");
    URL.revokeObjectURL = vi.fn();
    const page = await screen.findByTestId("share");
    fireEvent.click(within(page).getByTestId("share-open"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Create link/i }));
    const last = await screen.findByTestId("share-last");
    expect(within(last).queryByRole("link", { name: "Open in a new tab" })).toBeNull();
    expect(last.textContent).toContain('-H "X-Share-Secret: s3cret"');
    expect(last.textContent).toContain("share_secret_required");
    fireEvent.click(within(last).getByTestId("share-open-secret"));
    await waitFor(() => expect(tab.location.href).toBe("blob:the-file"));
    expect(opened).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith("http://localhost:3000/vola/s/tok1", {
      headers: { "x-share-secret": "s3cret" },
    });
    opened.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("Encrypted files", () => {
  it("lists the tenant-encrypted files and gates the keyring section behind a PIN", async () => {
    open("/examples/encrypted");
    const tenant = await screen.findByTestId("tenant-section");
    const files = await within(tenant).findAllByTestId("tenant-file");
    expect(files).toHaveLength(1);
    expect(files[0]?.textContent).toContain("vault-poster.png");
    expect(files[0]?.textContent).toContain("encryption: tenant");
    const keyring = screen.getByTestId("keyring-section");
    expect(keyring.textContent).toContain(
      sessionStorage.getItem("vola-examples:visitor") as string,
    );
    // No keyring yet: the gate offers the PIN setup (through the proxy).
    expect((await within(keyring).findAllByText(/PIN/)).length).toBeGreaterThan(1);
    expect(within(keyring).queryByTestId("unlock-left")).toBeNull();
  });

  it("says when the server has no keyring provider", async () => {
    open("/examples/encrypted", {
      config: { features: { keyring: false, tenant_encryption: false, worker: false } },
      keyring: null,
    });
    expect(await screen.findByTestId("keyring-off")).toBeTruthy();
    expect(screen.getByText(/no key file/)).toBeTruthy();
  });
});

describe("API", () => {
  it("lists the routes and the curl examples with the demo key and the visitor id", async () => {
    open("/examples/api");
    // The tree mounts again when the key arrives: query the page afresh every time.
    const text = () => screen.getByTestId("api").textContent ?? "";
    await waitFor(() => expect(text()).toContain(`Authorization: Bearer ${READ_KEY}`), {
      timeout: 5000,
    });
    expect(text()).toContain("/files/:type/:id/:fileId/thumb/:size?crop=");
    expect(text()).toContain(`/files/demo/${INSTANCE}?limit=5`);
    expect(text()).toContain("/examples/write/files/demo/");
    expect(text()).toContain("X-User-Id: demo-");
    fireEvent.click(screen.getByTestId("locale-sr"));
    await waitFor(() => expect(text()).toContain("preuzimanje: Range/206"));
  });
});

describe("/udc/:collection", () => {
  it("draws any collection the server lists as a plain data view", async () => {
    const { server } = open("/udc/files");
    await screen.findByText("aurora.jpg");
    expect(server.lists.at(-1)).toMatchObject({ collection: "files" });
  });
});
