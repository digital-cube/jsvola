import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Row } from "@jsudc/core";
import { UdcClient } from "@jsudc/core/client";
import {
  createUdcQueryClient,
  FALLBACK_ICON,
  LUCIDE_ICONS,
  resolveIcon,
  UdcI18nProvider,
  UdcProvider,
} from "@jsudc/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Circle } from "lucide-react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { EXAMPLES_MESSAGES } from "../src/i18n/messages.js";
import { MenuTree, RemoteMenu } from "../src/shell/MenuTree.js";
import {
  activeLeaf,
  BUILTIN_MENU_ROWS,
  buildMenu,
  EXAMPLES,
  loadMenuExpanded,
  MENU_EXPAND_KEY,
  menuLabel,
  parseMenuUrl,
  saveMenuExpanded,
  visibleItems,
  withOpen,
} from "../src/shell/menu.js";
import { node, SERVED_MENU } from "./fake.js";

// Ported from the jsudc example (frontend/test/menu.test.tsx, MIT) through jsmemento.

beforeEach(() => localStorage.clear());

const repo = (path: string) => join(import.meta.dirname, "..", "..", "..", path);

// Out of order on purpose: the tree sorts siblings by `order`.
const ROWS: Row[] = [
  node("VIEWS", 2, { translation_key: "MENU_VIEWS", icon: "lucide:layout-grid" }),
  node("HOME", 0, { translation_key: "MENU_HOME", icon: "lucide:house", url: "/" }),
  node("COLLECTIONS", 1, { translation_key: "MENU_COLLECTIONS", icon: "lucide:layers" }),
  node("COLLECTIONS/DATABASE", 0, { translation_key: "MENU_DATABASE" }),
  node("COLLECTIONS/DATABASE/COLLECTION_TICKETS", 1, {
    translation_key: "COLLECTIONS_TICKETS",
    icon: "lucide:kanban",
    url: "/udc/tickets",
    is_dynamic: true,
  }),
  node("COLLECTIONS/DATABASE/COLLECTION_COMPANIES", 0, {
    translation_key: "COLLECTIONS_COMPANIES",
    icon: "lucide:no-such-icon",
    url: "/udc/companies",
    is_dynamic: true,
  }),
  node("VIEWS/TICKETS_KANBAN", 0, {
    translation_key: "MENU_VIEW_TICKETS",
    icon: "lucide:kanban",
    url: "/udc/tickets?tab=kanban",
  }),
  node("VIEWS/DOC_ORG", 1, { translation_key: "UNTRANSLATED_THING", url: "/udc/org?tab=doc" }),
  node("VIEWS/ORG_PLAIN", 2, { translation_key: "MENU_ORG", url: "/udc/org/" }),
  node("COLLECTIONS/DATABASE/COLLECTION_ORG", 2, {
    translation_key: "COLLECTIONS_ORG",
    url: "/udc/org",
    is_dynamic: true,
  }),
  node("ORPHAN", 0, { parent_id: "NOWHERE", url: "/x" }),
];

const EN: Record<string, string> = { "MENU.HOME": "Home", "COLLECTIONS.TICKETS": "Tickets" };
const tEn = (section: string, term: string) => EN[`${section}.${term}`] ?? null;
const built = () => buildMenu(ROWS, (key, code) => menuLabel(key, code, tEn));

describe("menu labels", () => {
  it("splits on the first underscore and reads t(section, term); falls back to the key, then the code", () => {
    expect(menuLabel("MENU_HOME", "HOME", tEn)).toBe("Home");
    expect(menuLabel("COLLECTIONS_TICKETS", "X", tEn)).toBe("Tickets");
    expect(menuLabel("UNTRANSLATED_THING", "X", tEn)).toBe("UNTRANSLATED_THING");
    expect(menuLabel(null, "CODE", tEn)).toBe("CODE");
  });
});

describe("icons", () => {
  it("resolves lucide:<kebab-name>, a circle for an unknown name, nothing for none", () => {
    expect(resolveIcon("lucide:folder-open")).toBeTruthy();
    expect(FALLBACK_ICON).toBe(Circle);
    expect(resolveIcon("lucide:no-such-icon")).toBe(Circle);
    expect(resolveIcon(null)).toBeNull();
  });

  it("knows every lucide: name of menu.yaml, the server's collection icons and the built-ins", () => {
    const names = new Set<string>();
    for (const text of [
      readFileSync(repo("menu.yaml"), "utf8"),
      readFileSync(repo("packages/server/src/udc/menu.ts"), "utf8"),
      JSON.stringify(BUILTIN_MENU_ROWS),
    ]) {
      for (const m of text.matchAll(/lucide:([a-z0-9-]+)/g)) names.add(m[1] as string);
    }
    expect(names.size).toBeGreaterThan(5);
    const missing = [...names].filter((n) => !(n in LUCIDE_ICONS));
    expect(missing, "not in @jsudc/react's LUCIDE_ICONS: pick another").toEqual([]);
  });

  it("keeps the built-in rows the same as menu.yaml", () => {
    const yaml = readFileSync(repo("menu.yaml"), "utf8");
    for (const [code, icon, slug] of EXAMPLES) {
      expect(yaml).toContain(`code: ${code}\n`);
      expect(yaml).toContain(`icon: lucide:${icon}\n`);
      expect(yaml).toContain(`url: /examples/${slug}\n`);
    }
  });
});

describe("the menu tree from flat rows", () => {
  it("nests children under their parent, siblings by order, orphans dropped", () => {
    const items = built();
    expect(items.map((i) => i.code)).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
    const db = items[1]?.children[0];
    expect(db?.code).toBe("DATABASE");
    expect(db?.children.map((c) => [c.code, c.isDynamic])).toEqual([
      ["COLLECTION_COMPANIES", true],
      ["COLLECTION_TICKETS", true],
      ["COLLECTION_ORG", true],
    ]);
    expect(items[0]).toMatchObject({ label: "Home", icon: "lucide:house", url: "/" });
  });

  it("lists what is on screen: roots and the children of open items", () => {
    const items = built();
    const codes = (open: string[]) => visibleItems(items, new Set(open)).map((i) => i.code);
    expect(codes([])).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
    expect(codes(["menu:COLLECTIONS"])).toEqual(["HOME", "COLLECTIONS", "DATABASE", "VIEWS"]);
    expect(codes(["menu:COLLECTIONS/DATABASE"])).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
  });

  it("builds the built-in EXAMPLES › every page", () => {
    const items = buildMenu(BUILTIN_MENU_ROWS, (key, code) => key ?? code);
    expect(items.map((i) => i.code)).toEqual(["EXAMPLES"]);
    expect(items[0]?.children.map((c) => [c.code, c.url])).toEqual(
      EXAMPLES.map(([code, , slug]) => [code, `/examples/${slug}`]),
    );
  });
});

describe("the active leaf", () => {
  const at = (pathname: string, search = "") => activeLeaf(built(), { pathname, search })?.id;

  it("parses a menu url into a path and a tab", () => {
    expect(parseMenuUrl("/udc/tickets?tab=kanban")).toEqual({
      pathname: "/udc/tickets",
      tab: "kanban",
    });
    expect(parseMenuUrl("/udc/tickets/")).toEqual({ pathname: "/udc/tickets", tab: null });
  });

  it("matches the path, prefers a tab-naming leaf, then a written one; nothing elsewhere", () => {
    expect(at("/udc/tickets")).toBe("menu:COLLECTIONS/DATABASE/COLLECTION_TICKETS");
    expect(at("/udc/tickets", "?tab=kanban")).toBe("menu:VIEWS/TICKETS_KANBAN");
    expect(at("/udc/org")).toBe("menu:VIEWS/ORG_PLAIN");
    expect(at("/")).toBe("menu:HOME");
    expect(at("/udc/nothing")).toBeUndefined();
  });
});

describe("expand persistence", () => {
  it("round-trips the open ids under udc:menu:expanded", () => {
    expect(loadMenuExpanded()).toBeNull();
    saveMenuExpanded(["a", "b"]);
    expect(localStorage.getItem(MENU_EXPAND_KEY)).toBe('["a","b"]');
    expect(loadMenuExpanded()).toEqual(["a", "b"]);
    localStorage.setItem(MENU_EXPAND_KEY, "{not json");
    expect(loadMenuExpanded()).toBeNull();
    localStorage.setItem(MENU_EXPAND_KEY, '["a", 3, null]');
    expect(loadMenuExpanded()).toEqual(["a"]);
    const open = ["a"];
    expect(withOpen(open, ["a"])).toBe(open);
    expect(withOpen(open, ["b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
});

function renderTree(url: string, rows: readonly Row[] = ROWS) {
  return render(
    <UdcI18nProvider messages={EXAMPLES_MESSAGES}>
      <MemoryRouter initialEntries={[url]}>
        <MenuTree rows={rows} source="menu" />
      </MemoryRouter>
    </UdcI18nProvider>,
  );
}

const attr = (el: HTMLElement, name: string) => el.getAttribute(name);

describe("the sidebar tree", () => {
  it("opens the way to the active leaf and highlights it", () => {
    renderTree("/udc/companies");
    const tree = screen.getByTestId("menu-tree");
    const active = within(tree).getByTestId("nav-companies");
    expect(attr(active, "aria-current")).toBe("page");
    expect(attr(active, "data-active")).toBe("true");
    expect(within(tree).getByTestId("menu-COLLECTIONS").textContent).toBe("Collections");
    expect(within(tree).getByTestId("menu-HOME").textContent).toBe("MENU_HOME");
    expect(attr(within(tree).getByTestId("menu-COLLECTIONS"), "aria-expanded")).toBe("true");
    expect(attr(within(active).getByTestId("menu-icon"), "data-icon")).toBe("lucide:no-such-icon");
    expect(JSON.parse(localStorage.getItem(MENU_EXPAND_KEY) ?? "[]")).toContain("menu:COLLECTIONS");
  });

  it("toggles a branch, persists it, and opens it again on the next mount", async () => {
    saveMenuExpanded([]);
    const first = renderTree("/udc/companies");
    fireEvent.click(screen.getByTestId("menu-VIEWS"));
    expect(await screen.findByTestId("menu-TICKETS_KANBAN")).toBeTruthy();
    expect(loadMenuExpanded()).toContain("menu:VIEWS");
    first.unmount();

    renderTree("/");
    expect(await screen.findByTestId("menu-TICKETS_KANBAN")).toBeTruthy();
    fireEvent.click(screen.getByTestId("menu-VIEWS"));
    await waitFor(() => expect(screen.queryByTestId("menu-TICKETS_KANBAN")).toBeNull());
    expect(loadMenuExpanded()).not.toContain("menu:VIEWS");
  });

  it("opens every branch on the first visit", async () => {
    renderTree("/udc/nothing");
    expect(await screen.findByTestId("menu-DATABASE")).toBeTruthy();
    expect(screen.getByTestId("menu-TICKETS_KANBAN")).toBeTruthy();
  });

  it("moves with the arrow keys", async () => {
    saveMenuExpanded([]);
    renderTree("/");
    const home = screen.getByTestId("menu-HOME");
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowDown" });
    const coll = screen.getByTestId("menu-COLLECTIONS");
    expect(document.activeElement).toBe(coll);
    fireEvent.keyDown(coll, { key: "ArrowRight" });
    expect(await screen.findByTestId("menu-DATABASE")).toBeTruthy();
    fireEvent.keyDown(coll, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("menu-DATABASE"));
    fireEvent.keyDown(screen.getByTestId("menu-DATABASE"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(coll);
    fireEvent.keyDown(coll, { key: "ArrowUp" });
    expect(document.activeElement).toBe(home);
    fireEvent.keyDown(coll, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.queryByTestId("menu-DATABASE")).toBeNull());
  });

  it("labels vola's menu through the site's messages, in Serbian too", () => {
    localStorage.setItem("udc-locale", "sr");
    renderTree("/examples/thumbnails", SERVED_MENU);
    expect(screen.getByTestId("menu-EXAMPLES").textContent).toBe("Primeri");
    expect(screen.getByTestId("menu-THUMBNAILS").textContent).toBe("Sličice");
    expect(attr(screen.getByTestId("menu-THUMBNAILS"), "aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("menu-COLLECTIONS"));
    expect(screen.getByTestId("nav-files").textContent).toBe("files");
  });
});

describe("the served menu", () => {
  const listing = {
    name: "menu",
    capabilities: { paging: ["offset"], subscribe: false, total_count: true },
  } as never;

  function renderRemote(reply: () => Response) {
    const client = new UdcClient({
      httpUrl: "",
      fetch: (async () => reply()) as unknown as typeof fetch,
    });
    return render(
      <QueryClientProvider client={createUdcQueryClient()}>
        <UdcI18nProvider messages={EXAMPLES_MESSAGES}>
          <UdcProvider client={client}>
            <MemoryRouter initialEntries={["/"]}>
              <RemoteMenu listing={listing} fallback={BUILTIN_MENU_ROWS} />
            </MemoryRouter>
          </UdcProvider>
        </UdcI18nProvider>
      </QueryClientProvider>,
    );
  }

  it("loads the menu collection's rows", async () => {
    renderRemote(
      () =>
        new Response(
          JSON.stringify({
            kind: "udc.list.ok",
            id: "",
            payload: { rows: SERVED_MENU, next_cursor: null, total: SERVED_MENU.length },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(screen.getByTestId("menu-loading")).toBeTruthy();
    const tree = await screen.findByTestId("menu-tree");
    expect(tree.dataset.source).toBe("menu");
    expect(screen.getByTestId("menu-COLLECTIONS")).toBeTruthy();
  });

  it("falls back to the built-in entries when it cannot be read", async () => {
    renderRemote(() => new Response("nope", { status: 500 }));
    const tree = await screen.findByTestId("menu-tree", {}, { timeout: 5000 });
    expect(tree.dataset.source).toBe("builtin");
    expect(screen.getByTestId("menu-BROWSE")).toBeTruthy();
    expect(screen.queryByTestId("menu-COLLECTIONS")).toBeNull();
  });
});
