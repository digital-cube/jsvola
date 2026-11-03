/**
 * The main flow against the running stack: `docker compose up -d --build`, `make setup`, then
 * `pnpm test:e2e`. Everything goes through the desk's own port, as the browser's requests do.
 */
import { VolaClient } from "@vola/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ticketEvents } from "../src/web/feed.ts";

const DESK = process.env.DESK_URL ?? `http://localhost:${process.env.DESK_PORT ?? 8080}`;

interface MementoEvent {
  id: string;
  event_type: string;
  instance_type: string;
  instance_id: string;
  actor_id: string;
  rendered: string;
  payload: Record<string, unknown>;
}

interface Config {
  memento_key: string;
  vola_key: string;
}

interface Ticket {
  id: string;
}

interface RowList {
  payload: { rows: { __meta: { id: string } }[] };
}

let mementoKey: string;
let vola: VolaClient;

async function call<T>(method: string, path: string, user: string | null, body?: unknown) {
  const response = await fetch(`${DESK}${path}`, {
    method,
    headers: {
      ...(user ? { "x-user-id": user } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBeLessThan(300);
  return response.json() as Promise<T>;
}

async function desksEvents(locale: string): Promise<MementoEvent[]> {
  const response = await fetch(`${DESK}/memento/events?limit=200&locale=${locale}`, {
    headers: { authorization: `Bearer ${mementoKey}` },
  });
  return ((await response.json()) as { data: MementoEvent[] }).data;
}

/** vola's events arrive through its worker, so the last ones take a moment. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; ; tries++) {
    const value = await read();
    if (done(value) || tries === 40) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  const config = await call<Config>("GET", "/config", null);
  mementoKey = config.memento_key;
  vola = new VolaClient({ baseUrl: `${DESK}/vola`, apiKey: config.vola_key, userId: "ana" });
});

describe("the main flow", () => {
  it("every action, ours and vola's, lands in one feed as a sentence", async () => {
    const { id } = await call<Ticket>("POST", "/tickets", "igor", { title: "Printer on fire" });

    // The stream is open before anything happens, through the desk's WebSocket passage.
    const heard: MementoEvent[] = [];
    const stream = new WebSocket(
      `${DESK.replace(/^http/, "ws")}/memento/ws?instance_type=tickets&instance_id=${id}`,
      ["memento.v1", `bearer.${mementoKey}`],
    );
    stream.onmessage = (message) => {
      const { kind, payload } = JSON.parse(String(message.data));
      if (kind === "memento.event.new") heard.push(payload);
    };
    await new Promise((resolve, reject) => {
      stream.onopen = resolve;
      stream.onerror = reject;
    });

    await call("POST", `/tickets/${id}/comments`, "ana", { text: "On my way" });
    await call("POST", `/tickets/${id}/assign`, "igor", { assignee: "ana" });
    await call("PATCH", `/tickets/${id}/status`, "ana", { status: "in_progress" });
    await new Promise((resolve) => setTimeout(resolve, 1100)); // occurred_at orders the feed

    // A card dragged on the board.
    const dragged = await call<{ kind: string }>("POST", "/udc/mutate", "marko", {
      collection: "tickets",
      op: "update",
      id,
      row: { status: "done", order: 1 },
    });
    expect(dragged.kind).toBe("udc.mutate.ok");

    // A file, straight to vola, then announced to the backend.
    const file = await vola.files.upload("tickets", id, Buffer.from("smoke\n"), {
      filename: "report.txt",
      contentType: "text/plain",
    });
    await call("POST", `/tickets/${id}/files`, "ana", { file_id: file.id });

    // The audit: nothing in this program sends these two.
    const share = await vola.shares.create({ file_id: file.id, max_downloads: 5 });
    const shared = await fetch(new URL(new URL(share.url).pathname, DESK));
    expect(shared.status).toBe(200);
    await vola.files.delete("tickets", id, file.id);

    const all = await eventually(
      () => desksEvents("sr"),
      (events) =>
        ticketEvents(events, id).some(({ event_type }) => event_type === "VOLA_FILE_DELETED"),
    );
    const feed = ticketEvents(all, id);

    expect(feed.map(({ event_type }) => event_type).sort()).toEqual(
      [
        "TICKET_CREATED",
        "TICKET_COMMENTED",
        "TICKET_ASSIGNED",
        "TICKET_STATUS_CHANGED",
        "TICKET_STATUS_CHANGED",
        "TICKET_FILE_ATTACHED",
        "VOLA_SHARE_CREATED",
        "VOLA_FILE_DELETED",
      ].sort(),
    );

    const sentence = (type: string) => feed.find((event) => event.event_type === type)?.rendered;
    expect(sentence("TICKET_COMMENTED")).toBe('ana komentariše: „On my way"');
    expect(sentence("TICKET_ASSIGNED")).toBe("igor dodeljuje tiket: ana");
    expect(sentence("TICKET_FILE_ATTACHED")).toBe("ana kači fajl report.txt");
    expect(sentence("VOLA_SHARE_CREATED")).toBe("ana pravi link za deljenje");
    expect(sentence("VOLA_FILE_DELETED")).toBe("ana briše fajl report.txt");

    // The dragged card has its user, and the previous column.
    expect(feed.find(({ actor_id }) => actor_id === "marko")?.payload).toMatchObject({
      previous: "in_progress",
      status: "done",
    });

    // English from the same events.
    const english = ticketEvents(await desksEvents("en"), id);
    expect(english.find(({ event_type }) => event_type === "VOLA_FILE_DELETED")?.rendered).toBe(
      "ana deleted report.txt",
    );

    // And the stream carried the program's events as they happened.
    const types = heard.map(({ event_type }) => event_type);
    stream.close();
    expect(types).toContain("TICKET_COMMENTED");
    expect(types).toContain("TICKET_FILE_ATTACHED");
  }, 30_000);

  it("the board sees the move", async () => {
    const ticket = await call<Ticket>("POST", "/tickets", "igor", { title: "On the board" });
    await call("PATCH", `/tickets/${ticket.id}/status`, "igor", { status: "done" });
    const { payload } = await call<RowList>("POST", "/udc/list", null, {
      collection: "tickets",
      filter: { field: "status", op: "eq", value: "done" },
    });
    expect(payload.rows.map((row) => row.__meta.id)).toContain(ticket.id);
  });
});
