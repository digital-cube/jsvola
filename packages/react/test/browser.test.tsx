import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VolaFileBrowser } from "../src/index.js";
import {
  FakeWebSocket,
  fileInfo,
  fileRow,
  filesServer,
  INSTANCE,
  json,
  renderVola,
} from "./fake.js";

const other = fileRow({
  id: "019a0000-0000-7000-8000-000000000002",
  filename: "photo.jpg",
  kind: "image",
  mime_type: "image/jpeg",
  extension: "jpg",
});
const locked = fileRow({
  id: "019a0000-0000-7000-8000-000000000003",
  encryption: "keyring",
  filename: "secret.txt",
});

describe("VolaFileBrowser", () => {
  it("renders the rows of the fake UDC, scoped to the instance and the folder", async () => {
    const filters: unknown[] = [];
    const server = filesServer([fileRow(), other, locked], (body) =>
      filters.push((body as { filter: unknown }).filter),
    );
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("photo.jpg")).toBeTruthy();
    // an encrypted row keeps its masked name and a lock mark
    expect(screen.getByText("<encrypted>")).toBeTruthy();
    expect(screen.getAllByLabelText("Encrypted").length).toBeGreaterThan(0);
    expect(filters[0]).toEqual({
      and: [
        { field: "instance_type", op: "eq", value: "tickets" },
        { field: "instance_id", op: "eq", value: INSTANCE },
        { field: "folder_path", op: "eq", value: "" },
      ],
    });
  });

  it("lists the subfolders and navigates into one; the breadcrumbs follow", async () => {
    const filters: unknown[] = [];
    const server = filesServer([fileRow()], (body) =>
      filters.push((body as { filter: unknown }).filter),
    );
    server.on("GET", /^\/vola\/folders\//, ({ url }) =>
      json({
        folder: null,
        subfolders: url.pathname.endsWith(INSTANCE)
          ? [
              {
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
              },
            ]
          : [],
        files: [],
      }),
    );
    const onFolderChange = vi.fn();
    renderVola(
      <VolaFileBrowser
        instanceType="tickets"
        instanceId={INSTANCE}
        onFolderChange={onFolderChange}
      />,
      server,
    );
    const folder = await screen.findByRole("button", { name: /docs/ });
    await userEvent.click(folder);
    expect(onFolderChange).toHaveBeenCalledWith("docs");
    const crumbs = screen.getByRole("navigation", { name: "Folder path" });
    expect(within(crumbs).getByRole("button", { name: "docs" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await waitFor(() =>
      expect(filters.at(-1)).toMatchObject({
        and: expect.arrayContaining([{ field: "folder_path", op: "eq", value: "docs" }]),
      }),
    );
  });

  it("offers the row actions and renames through a dialog", async () => {
    const server = filesServer([fileRow()]);
    const patched: unknown[] = [];
    server.on("PATCH", /^\/vola\/files\//, ({ body }) => {
      patched.push(body);
      return json(fileInfo({ filename: "renamed.pdf" }));
    });
    const onOpen = vi.fn();
    renderVola(
      <VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} onOpen={onOpen} />,
      server,
    );
    await screen.findByText("report.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Actions for report.pdf" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Open", "Download", "Rename", "Move", "Delete", "Versions", "Share", "Visibility"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = screen.getByRole("dialog", { name: "Rename" });
    const input = within(dialog).getByLabelText("New name") as HTMLInputElement;
    expect(input.value).toBe("report.pdf");
    await userEvent.clear(input);
    await userEvent.type(input, "renamed.pdf");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched).toEqual([{ filename: "renamed.pdf" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
    // the name is the "open" link
    await userEvent.click(screen.getByRole("button", { name: "report.pdf" }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: fileInfo().id, filename: "report.pdf" }),
    );
  });

  it("subscribes to /udc/subscribe and patches a live row in place", async () => {
    FakeWebSocket.instances.length = 0;
    const server = filesServer([fileRow()]);
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await screen.findByText("report.pdf");
    const ws = FakeWebSocket.last;
    expect(ws.url).toBe("ws://vola.test/vola/udc/subscribe");
    expect(ws.protocols).toEqual(["vola.v1", "bearer.vola_test_key"]);
    act(() => {
      ws.open();
      ws.receive({
        kind: "udc.welcome",
        id: "",
        payload: {
          protocol_version: "1",
          tenant: "t",
          heartbeat_interval_ms: 30000,
          max_buffered_messages: 1000,
          max_subscriptions: 32,
        },
      });
    });
    expect(ws.messages[0]).toMatchObject({
      kind: "udc.subscribe",
      id: "files",
      payload: { collection: "files", filter: { and: expect.any(Array) } },
    });
    act(() => {
      ws.receive({ kind: "udc.subscribe.ok", id: "files", payload: { collection: "files" } });
    });
    expect(screen.getByRole("status", { name: "Live" })).toBeTruthy();
    const row = screen.getByText("report.pdf").closest("tr") as HTMLTableRowElement;
    expect(row.dataset.processing).toBeUndefined();
    act(() => {
      ws.receive({
        kind: "udc.row.upsert",
        id: "files",
        payload: {
          collection: "files",
          event: "processing",
          row: fileRow({ processing_status: "DONE" }),
        },
      });
    });
    await waitFor(() =>
      expect(
        (screen.getByText("report.pdf").closest("tr") as HTMLTableRowElement).dataset.processing,
      ).toBe("DONE"),
    );
  });

  it("uploads what is dropped on it into the current folder", async () => {
    const server = filesServer([fileRow()]);
    server.on("POST", /^\/vola\/files\/tickets\//, () =>
      json(fileInfo({ filename: "dropped.txt" }), 201),
    );
    renderVola(<VolaFileBrowser instanceType="tickets" instanceId={INSTANCE} />, server);
    await screen.findByText("report.pdf");
    const zone = screen.getByText("report.pdf").closest("section") as HTMLElement;
    const file = new File(["hello"], "dropped.txt", { type: "text/plain" });
    const dataTransfer = { files: [file], types: ["Files"] };
    await act(async () => {
      const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
        dataTransfer: unknown;
      };
      event.dataTransfer = dataTransfer;
      zone.dispatchEvent(event);
    });
    await waitFor(() => expect(server.of("POST", "/vola/files/tickets/").length).toBe(1));
    expect(await screen.findByText("Uploaded")).toBeTruthy();
  });
});
