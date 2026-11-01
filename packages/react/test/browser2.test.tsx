import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { FolderInfo } from "@vola/core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VolaFileBrowser } from "../src/index.js";
import {
  error,
  FakeServer,
  FILES_DESCRIBE,
  fileInfo,
  fileRow,
  filesServer,
  INSTANCE,
  json,
  keyringStatus,
  renderVola,
  udcOk,
} from "./fake.js";

const folder: FolderInfo = {
  id: "019a0000-0000-7000-8000-00000000f001",
  tenant_id: fileInfo().tenant_id,
  instance_type: "tickets",
  instance_id: INSTANCE,
  parent_id: null,
  name: "docs",
  path: "docs",
  default_keyring_id: null,
  created_by: null,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  deleted_at: null,
  deleted_by: null,
};

async function openMenu(name = "report.pdf") {
  await screen.findByText(name);
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu");
}

async function pick(item: string, name?: string) {
  const menu = await openMenu(name);
  await userEvent.click(within(menu).getByRole("menuitem", { name: item }));
}

describe("VolaFileBrowser dialogs", () => {
  let anchorClick: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
  });
  afterEach(() => anchorClick.mockRestore());

  it("moves a file to a folder path", async () => {
    const server = filesServer([fileRow()]);
    const patched: unknown[] = [];
    server.on("PATCH", /^\/vola\/files\//, ({ body }) => {
      patched.push(body);
      return json(fileInfo());
    });
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await pick("Move");
    const dialog = screen.getByRole("dialog", { name: "Move" });
    await userEvent.type(within(dialog).getByLabelText("Target folder"), "archive/2026");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(patched).toEqual([{ folder_path: "archive/2026" }]));
  });

  it("deletes after the confirmation, and shows a server error", async () => {
    const server = filesServer([fileRow()]);
    let deletes = 0;
    server.on("DELETE", /^\/vola\/files\//, () =>
      ++deletes === 1 ? error(409, "file_locked") : json(fileInfo()),
    );
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await pick("Delete");
    const dialog = screen.getByRole("alertdialog", { name: "Delete" });
    expect(within(dialog).getByText(/Delete “report.pdf”\?/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/file_locked/);
    await userEvent.click(within(alert).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).toBeNull();
    // the dialog stayed open: try again
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => expect(deletes).toBe(2));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("visibility: an encrypted file cannot be globally public", async () => {
    const server = filesServer([fileRow({ encryption: "keyring" })]);
    const patched: unknown[] = [];
    server.on("PATCH", /^\/vola\/files\//, ({ body }) => {
      patched.push(body);
      return json(fileInfo({ encryption: "keyring", is_public: true }));
    });
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await pick("Visibility", "<encrypted>");
    const dialog = screen.getByRole("dialog", { name: "Visibility" });
    expect(within(dialog).getByText("An encrypted file cannot be globally public.")).toBeTruthy();
    const global = within(dialog).getByRole("checkbox", {
      name: /Globally public/,
    }) as HTMLInputElement;
    expect(global.disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /^Public/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched).toEqual([{ is_public: true }]));
  });

  it("visibility of a plain file sends both flags", async () => {
    const server = filesServer([fileRow()]);
    const patched: unknown[] = [];
    server.on("PATCH", /^\/vola\/files\//, ({ body }) => {
      patched.push(body);
      return json(fileInfo());
    });
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await pick("Visibility");
    const dialog = screen.getByRole("dialog", { name: "Visibility" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Globally public/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched).toEqual([{ is_public: false, is_global_public: true }]));
  });

  it("lists the versions and downloads one of them; download fetches with the credentials", async () => {
    const server = filesServer([fileRow()]);
    const older = fileInfo({
      id: "019a0000-0000-7000-8000-000000000009",
      filename: "report-v1.pdf",
    });
    server.on("GET", /\/versions$/, () => json({ versions: [fileInfo(), older] }));
    server.on(
      "GET",
      /^\/vola\/files\/tickets\/[^/]+\/[^/]+$/,
      () => new Response(new Blob(["%PDF"]), { status: 200 }),
    );
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await pick("Versions");
    const dialog = screen.getByRole("dialog", { name: "Versions of report.pdf" });
    expect(await within(dialog).findByText(/report-v1\.pdf/)).toBeTruthy();
    expect(within(dialog).getByText(/\(current\)/)).toBeTruthy();
    const downloads = within(dialog).getAllByRole("button", { name: "Download" });
    await userEvent.click(downloads[1] as HTMLElement);
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    const call = server.of("GET", `/vola/files/tickets/${INSTANCE}/${older.id}?download=1`)[0];
    expect(call?.headers.get("authorization")).toBe("Bearer vola_test_key");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // the row's own download
    await pick("Download");
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(2));
  });

  it("opens the share dialog from the row", async () => {
    const server = filesServer([fileRow()]);
    server.on("GET", "/vola/shares", () => json({ shares: [] }));
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await pick("Share");
    expect(await screen.findByRole("dialog", { name: "Share “report.pdf”" })).toBeTruthy();
  });

  it("creates, renames and deletes folders", async () => {
    const server = filesServer([fileRow()]);
    server.on("GET", /^\/vola\/folders\//, () =>
      json({ folder: null, subfolders: [folder], files: [] }),
    );
    const folderCalls: string[] = [];
    server.on("POST", /^\/vola\/folders\//, ({ url }) => {
      folderCalls.push(`POST ${url.pathname}`);
      return json({ ...folder, name: "new", path: "new" }, 201);
    });
    server.on("PATCH", /^\/vola\/folders\//, ({ url, body }) => {
      folderCalls.push(`PATCH ${url.pathname} ${JSON.stringify(body)}`);
      return json({ ...folder, name: "renamed", path: "renamed" });
    });
    server.on("DELETE", /^\/vola\/folders\//, ({ url }) => {
      folderCalls.push(`DELETE ${url.pathname}${url.search}`);
      return json({ folder, folders: 1, files: 0 });
    });
    renderVola(
      <VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} folderPath="a" />,
      server,
    );
    await screen.findByText("report.pdf");
    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    let dialog = screen.getByRole("dialog", { name: "New folder" });
    await userEvent.type(within(dialog).getByLabelText("Folder name"), "new");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(folderCalls).toContain(`POST /vola/folders/tickets/${INSTANCE}/a/new`),
    );
    // the folder chip's menu
    const chip = (await screen.findByRole("button", { name: /docs/ })).parentElement as HTMLElement;
    await userEvent.click(within(chip).getByRole("button", { name: "Folder actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    dialog = screen.getByRole("dialog", { name: "Rename" });
    const input = within(dialog).getByLabelText("Folder name") as HTMLInputElement;
    expect(input.value).toBe("docs");
    await userEvent.clear(input);
    await userEvent.type(input, "renamed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(folderCalls.at(-1)).toBe(
        `PATCH /vola/folders/tickets/${INSTANCE}/docs {"name":"renamed"}`,
      ),
    );
    await userEvent.click(within(chip).getByRole("button", { name: "Folder actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete" });
    expect(within(confirm).getByText(/“docs” with everything in it/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(folderCalls.at(-1)).toBe(`DELETE /vola/folders/tickets/${INSTANCE}/docs?recursive=1`),
    );
  });
});

/** A host that moves the browser's `folderPath` prop from `a` to `a/b`. */
function PathHost() {
  const [path, setPath] = useState("a");
  return (
    <>
      <button type="button" onClick={() => setPath("a/b")}>
        deeper
      </button>
      <VolaFileBrowser
        instanceType="tickets"
        instanceId={INSTANCE}
        folderPath={path}
        urlState="window"
        upload={false}
        keyringStatus={false}
      />
    </>
  );
}

describe("VolaFileBrowser options", () => {
  it("shows the chosen columns, sorts by a header, loads the next page, shows the keyring status", async () => {
    const bodies: { sort?: unknown; page?: { cursor?: string | null } }[] = [];
    const server = new FakeServer();
    server
      .on("POST", "/vola/udc/describe", () => udcOk("describe", FILES_DESCRIBE))
      .on("POST", "/vola/udc/list", ({ body }) => {
        const request = body as (typeof bodies)[number];
        bodies.push(request);
        const second = request.page?.cursor === "c2";
        return udcOk("list", {
          rows: second
            ? [fileRow({ id: "019a0000-0000-7000-8000-000000000002", filename: "page2.txt" })]
            : [fileRow()],
          next_cursor: second ? null : "c2",
          total: 2,
        });
      })
      .on("GET", /^\/vola\/folders\//, () => json({ folder: null, subfolders: [], files: [] }))
      .on("GET", "/vola/keyrings/me/status", () => json(keyringStatus()))
      .on("GET", /\/thumb\/\d+$/, () => error(404, "no_thumbnail"));
    renderVola(
      <VolaFileBrowser
        instanceType="tickets"
        instanceId={INSTANCE}
        columns={["filename", "size", "nonsense"]}
        live={false}
        title="Files of the ticket"
      />,
      server,
    );
    await screen.findByText("report.pdf");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["filename", "size", "Actions"]);
    expect(screen.getByRole("status", { name: "Not live" })).toBeTruthy();
    expect(await screen.findByText("Locked")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Files of the ticket" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sort by size" }));
    await waitFor(() => expect(bodies.at(-1)?.sort).toEqual([{ field: "size", dir: "asc" }]));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("page2.txt")).toBeTruthy();
  });

  it("follows the folderPath prop and keeps the view state in the page URL when asked", async () => {
    const filters: unknown[] = [];
    const server = filesServer([fileRow()], (body) =>
      filters.push((body as { filter: unknown }).filter),
    );
    renderVola(<PathHost />, server);
    await screen.findByText("report.pdf");
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "deeper" }));
    await waitFor(() =>
      expect(filters.at(-1)).toMatchObject({
        and: expect.arrayContaining([{ field: "folder_path", op: "eq", value: "a/b" }]),
      }),
    );
    const crumbs = within(screen.getByRole("navigation", { name: "Folder path" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(crumbs).toEqual(["Root", "a", "b"]);
  });
});
