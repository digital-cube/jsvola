import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, routerBasename } from "../src/App.js";
import { defaultSettings, STORAGE_KEY, VISITOR_KEY } from "../src/settings.js";
import { FakeWebSocket, fakeVola, READ_KEY } from "./fake.js";

const saved = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");

beforeEach(() => {
  FakeWebSocket.instances = [];
  history.replaceState(null, "", "/examples/api");
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("the site", () => {
  it("connects with the server's demo key, no form, and keeps a visitor id for the session", async () => {
    const server = fakeVola();
    render(<App fetch={server.fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("key-badge").textContent).toBe("demo keytenant demo"),
    );
    expect(screen.queryByTestId("no-key")).toBeNull();
    expect(server.calls).toContain("GET /vola/examples/config");
    // Never stored: a fresh demo key is asked for on every load.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    const visitor = sessionStorage.getItem(VISITOR_KEY);
    expect(visitor).toMatch(/^demo-[a-z0-9]{12}$/);
    // The API page shows the demo key and the visitor id.
    const api = await screen.findByTestId("api");
    expect(api.textContent).toContain(READ_KEY);
    expect(api.textContent).toContain(visitor as string);
  });

  it("draws the sidebar from the menu collection, the active example highlighted", async () => {
    render(<App fetch={fakeVola().fetch} />);
    await waitFor(() => expect(screen.getByTestId("menu-tree").dataset.source).toBe("menu"), {
      timeout: 5000,
    });
    const tree = screen.getByTestId("menu-tree");
    const api = within(tree).getByTestId("menu-API");
    expect(api.getAttribute("aria-current")).toBe("page");
    expect(api.textContent).toBe("API");
    fireEvent.click(within(tree).getByTestId("menu-COLLECTIONS"));
    expect(within(tree).getByTestId("nav-files").getAttribute("href")).toBe("/udc/files");
    fireEvent.click(within(tree).getByTestId("menu-BROWSE"));
    await waitFor(() => expect(location.pathname).toBe("/examples/browse"));
  });

  it("asks for a key when the server has no examples, with the built-in menu", async () => {
    history.replaceState(null, "", "/examples/browse");
    const server = fakeVola({ examples: false });
    render(<App fetch={server.fetch} />);
    expect(await screen.findByTestId("no-key")).toBeTruthy();
    expect(screen.getByTestId("key-badge").textContent).toBe("no key");
    const tree = screen.getByTestId("menu-tree");
    expect(tree.dataset.source).toBe("builtin");
    expect(within(tree).getByTestId("menu-ENCRYPTED")).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(0);
    // The visitor pastes a key: it is kept and used.
    fireEvent.change(within(screen.getByTestId("no-key")).getByPlaceholderText("vola_live_…"), {
      target: { value: " vola_live_mine " },
    });
    fireEvent.click(within(screen.getByTestId("no-key")).getByRole("button", { name: "Connect" }));
    expect(saved().apiKey).toBe("vola_live_mine");
    await waitFor(() => expect(screen.getByTestId("key-badge").textContent).toBe("your key"));
  });

  it("shows the demo key badged in the settings, replaces it with the visitor's own, and comes back", async () => {
    const server = fakeVola();
    render(<App fetch={server.fetch} />);
    await screen.findByTestId("api");
    fireEvent.click(screen.getByTestId("settings-toggle"));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const input = within(dialog).getByPlaceholderText("vola_live_…") as HTMLInputElement;
    expect(input.value).toBe(READ_KEY);
    expect(within(dialog).getByTestId("key-badge").textContent).toContain("demo key");
    expect(within(dialog).getByTestId("visitor-id").textContent).toBe(
      sessionStorage.getItem(VISITOR_KEY),
    );
    // Connecting with the demo key unchanged keeps following it.
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(saved().apiKey).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.change(screen.getByPlaceholderText("vola_live_…"), {
      target: { value: "vola_live_mine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(saved().apiKey).toBe("vola_live_mine");
    await waitFor(() => expect(screen.getByTestId("key-badge").textContent).toBe("your key"));
    expect((await screen.findByTestId("api")).textContent).toContain("vola_live_mine");

    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Use the demo key" }));
    expect(saved().apiKey).toBe("");
    await waitFor(() => expect(screen.getByTestId("key-badge").textContent).toContain("demo key"));
  });

  it("makes a new visitor identity on request", async () => {
    render(<App fetch={fakeVola().fetch} />);
    await screen.findByTestId("api");
    const before = sessionStorage.getItem(VISITOR_KEY);
    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "New identity" }));
    const after = sessionStorage.getItem(VISITOR_KEY);
    expect(after).not.toBe(before);
    // A new principal is a new client and a new keyring store: the shell mounts again.
    await screen.findByTestId("api");
    fireEvent.click(screen.getByTestId("settings-toggle"));
    expect(screen.getByTestId("visitor-id").textContent).toBe(after);
  });

  it("closes the settings on Escape and on a click outside, and switches the language", async () => {
    render(<App fetch={fakeVola().fetch} />);
    await screen.findByTestId("api");
    fireEvent.click(screen.getByTestId("settings-toggle"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("locale-sr"));
    await waitFor(() => expect(screen.getByTestId("menu-API").textContent).toBe("API"));
    expect(screen.getByTestId("menu-ENCRYPTED").textContent).toBe("Šifrovani fajlovi");
    expect(localStorage.getItem("udc-locale")).toBe("sr");
  });

  it("leads / and unknown paths to Browse, and keeps working under /en/", async () => {
    expect(routerBasename("/en/")).toBe("/en");
    expect(routerBasename("/en/examples/api")).toBe("/en");
    expect(routerBasename("/")).toBe("/");
    expect(routerBasename("/english")).toBe("/");
    history.replaceState(null, "", "/");
    const first = render(<App fetch={fakeVola().fetch} />);
    await waitFor(() => expect(location.pathname).toBe("/examples/browse"));
    first.unmount();
    history.replaceState(null, "", "/nowhere");
    const second = render(<App fetch={fakeVola().fetch} />);
    await waitFor(() => expect(location.pathname).toBe("/examples/browse"));
    second.unmount();
    history.replaceState(null, "", "/en/");
    render(<App fetch={fakeVola().fetch} />);
    await waitFor(() => expect(location.pathname).toBe("/en/examples/browse"));
  });

  it("restores saved settings: the visitor's own key is not replaced by the demo key", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...defaultSettings({} as ImportMetaEnv), apiKey: "vola_live_mine" }),
    );
    const server = fakeVola();
    render(<App fetch={server.fetch} />);
    expect(await screen.findByTestId("api")).toBeTruthy();
    expect(screen.getByTestId("key-badge").textContent).toBe("your key");
    expect(server.calls).toContain("GET /vola/examples/config");
  });
});
