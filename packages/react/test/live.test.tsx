import type { FilterNode } from "@jsudc/core";
import { UdcClient } from "@jsudc/core/client";
import { udcKeys } from "@jsudc/react";
import { useQueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { filesScope, ScopedUdcClient, subscribeUrl, useFilesLive } from "../src/index.js";
import { FakeServer, FakeWebSocket, fileRow, json, keyringStatus, renderVola } from "./fake.js";

describe("ScopedUdcClient", () => {
  it("ANDs the scope into every list of the collection and leaves the rest alone", async () => {
    const calls: unknown[] = [];
    const inner = new UdcClient({
      httpUrl: "http://x",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return json({
          kind: "udc.list.ok",
          id: "1",
          payload: { rows: [], next_cursor: null, total: 0 },
        });
      },
    });
    const scope = filesScope("tickets", "i1", "docs");
    const scoped = new ScopedUdcClient(inner, "files", scope);
    await scoped.list({ collection: "files", page: { limit: 10 } });
    await scoped.list({
      collection: "files",
      page: { limit: 10 },
      filter: { field: "kind", op: "eq", value: "image" },
    });
    await scoped.list({ collection: "menu", page: { limit: 10 } });
    expect(calls).toEqual([
      { collection: "files", page: { limit: 10 }, filter: scope },
      {
        collection: "files",
        page: { limit: 10 },
        filter: { and: [scope, { field: "kind", op: "eq", value: "image" }] },
      },
      { collection: "menu", page: { limit: 10 } },
    ]);
  });

  it("subscribeUrl turns the API base into the WebSocket of /udc/subscribe", () => {
    expect(subscribeUrl("https://files.example.com/vola")).toBe(
      "wss://files.example.com/vola/udc/subscribe",
    );
    expect(subscribeUrl("http://localhost:8300/vola")).toBe(
      "ws://localhost:8300/vola/udc/subscribe",
    );
  });
});

let qc: ReturnType<typeof useQueryClient> | null = null;
const cache = () => {
  if (!qc) throw new Error("the Probe did not render");
  return qc;
};
const PROBE_FILTER: FilterNode = filesScope("tickets", "i1", "");
function Probe() {
  qc = useQueryClient();
  const status = useFilesLive({
    filter: PROBE_FILTER,
    reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
  });
  return <span data-testid="status">{status}</span>;
}

describe("useFilesLive", () => {
  it("subscribes, patches a cached row, invalidates on a removal and reconnects", async () => {
    FakeWebSocket.instances.length = 0;
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    const filter = PROBE_FILTER;
    const params = { filter: undefined, sort: [], limit: 50, mode: "pages" as const, page: 1 };
    const row = fileRow();
    renderVola(<Probe />, server);
    const ws = FakeWebSocket.last;
    expect(screen.getByTestId("status").textContent).toBe("connecting");
    act(() => {
      cache().setQueryData(udcKeys.list("files", params), {
        rows: [row],
        next_cursor: null,
        total: 1,
      });
      ws.open();
      ws.receive({ kind: "udc.welcome", id: "", payload: {} });
    });
    expect(ws.messages).toEqual([
      { kind: "udc.subscribe", id: "files", payload: { collection: "files", filter } },
    ]);
    act(() =>
      ws.receive({ kind: "udc.subscribe.ok", id: "files", payload: { collection: "files" } }),
    );
    expect(screen.getByTestId("status").textContent).toBe("live");
    act(() =>
      ws.receive({
        kind: "udc.row.upsert",
        id: "files",
        payload: {
          collection: "files",
          event: "updated",
          row: { ...row, filename: "renamed.pdf" },
        },
      }),
    );
    const cached = cache().getQueryData(udcKeys.list("files", params)) as {
      rows: { filename: string }[];
    };
    expect(cached.rows[0]?.filename).toBe("renamed.pdf");
    expect(cache().getQueryState(udcKeys.list("files", params))?.isInvalidated).toBe(false);
    act(() =>
      ws.receive({
        kind: "udc.row.remove",
        id: "files",
        payload: { collection: "files", event: "deleted", id: row.__meta.id },
      }),
    );
    expect(cache().getQueryState(udcKeys.list("files", params))?.isInvalidated).toBe(true);
    // the socket drops: offline, then a new socket
    act(() => ws.close());
    expect(screen.getByTestId("status").textContent).toBe("offline");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
  });
});
