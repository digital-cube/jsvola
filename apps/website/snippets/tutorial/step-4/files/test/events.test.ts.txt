import { describe, expect, it } from "vitest";
import { AS_IGOR, FILE, testApp } from "./helpers.ts";

type App = Awaited<ReturnType<typeof testApp>>;

async function newTicket(app: App) {
  const res = await app.inject({
    method: "POST",
    url: "/tickets",
    headers: AS_IGOR,
    payload: { title: "Printer on fire" },
  });
  return res.json();
}

const lastEvent = (app: App) => app.events.at(-1);

describe("every action is one memento event", () => {
  it("POST /tickets: TICKET_CREATED", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    expect(app.events).toEqual([
      {
        event_type: "TICKET_CREATED",
        instance_type: "tickets",
        instance_id: ticket.id,
        actor_id: "igor",
        payload: { title: "Printer on fire" },
      },
    ]);
  });

  it("POST /tickets/:id/comments: TICKET_COMMENTED", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/comments`,
      headers: { "x-user-id": "ana" },
      payload: { text: "On my way" },
    });
    expect(res.statusCode).toBe(201);
    expect(lastEvent(app)).toMatchObject({
      event_type: "TICKET_COMMENTED",
      actor_id: "ana",
      payload: { text: "On my way" },
    });
  });

  it("PATCH /tickets/:id/status: TICKET_STATUS_CHANGED, with the previous status", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    await app.inject({
      method: "PATCH",
      url: `/tickets/${ticket.id}/status`,
      headers: AS_IGOR,
      payload: { status: "done" },
    });
    expect(lastEvent(app)).toMatchObject({
      event_type: "TICKET_STATUS_CHANGED",
      payload: { status: "done", previous: "new" },
    });
  });

  it("PATCH to the status it already has changes nothing and says nothing", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/tickets/${ticket.id}/status`,
      headers: AS_IGOR,
      payload: { status: "new" },
    });
    expect(res.statusCode).toBe(200);
    expect(app.events).toHaveLength(1);
  });

  it("POST /tickets/:id/assign: TICKET_ASSIGNED", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/assign`,
      headers: AS_IGOR,
      payload: { assignee: "marko" },
    });
    expect(lastEvent(app)).toMatchObject({
      event_type: "TICKET_ASSIGNED",
      payload: { assignee: "marko" },
    });
  });

  it("POST /tickets/:id/files: TICKET_FILE_ATTACHED, with vola's facts", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/files`,
      headers: AS_IGOR,
      payload: { file_id: FILE.id, filename: "a lie the browser told.exe" },
    });
    expect(res.statusCode).toBe(201);
    expect(lastEvent(app)).toMatchObject({
      event_type: "TICKET_FILE_ATTACHED",
      payload: {
        file_id: FILE.id,
        filename: "report.pdf",
        size: 1024,
        mime_type: "application/pdf",
      },
    });
  });

  it("refuses a file that is not on the ticket, and says nothing", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/files`,
      headers: AS_IGOR,
      payload: { file_id: "someone-elses" },
    });
    expect(res.statusCode).toBe(422);
    expect(app.events).toHaveLength(1);
  });

  it("refuses an empty comment, and a comment on a ticket that is not there", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const empty = await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/comments`,
      headers: AS_IGOR,
      payload: { text: " " },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/tickets/0192f7a0-0000-7000-8000-000000000000/comments",
      headers: AS_IGOR,
      payload: { text: "hello?" },
    });
    expect([empty.statusCode, missing.statusCode]).toEqual([422, 404]);
    expect(app.events).toHaveLength(1);
  });
});

describe("a card dragged on the board (POST /udc/mutate)", () => {
  const drag = (app: App, id: string, row: Record<string, unknown>, user: string | null = "ana") =>
    app.inject({
      method: "POST",
      url: "/udc/mutate",
      headers: user ? { "x-user-id": user } : {},
      payload: { collection: "tickets", op: "update", id, row },
    });

  it("to another column: the same event as the status route", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await drag(app, ticket.id, { status: "in_progress", order: 50 });
    expect(res.json().kind).toBe("udc.mutate.ok");
    expect(lastEvent(app)).toMatchObject({
      event_type: "TICKET_STATUS_CHANGED",
      instance_id: ticket.id,
      actor_id: "ana",
      payload: { status: "in_progress", previous: "new" },
    });
  });

  it("inside its column: no event, it is only an order", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    await drag(app, ticket.id, { order: 50 });
    expect(app.events).toHaveLength(1);
  });

  it("by nobody: refused and not saved", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await drag(app, ticket.id, { status: "done", order: 50 }, null);
    expect(res.json().kind).toBe("udc.mutate.err");
    const stored = await app.inject({ method: "GET", url: `/tickets/${ticket.id}` });
    expect(stored.json().status).toBe("new");
    expect(app.events).toHaveLength(1);
  });

  it("a write that fails: no event", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await drag(app, ticket.id, { status: "lost", order: 50 });
    expect(res.json().kind).toBe("udc.mutate.err");
    expect(app.events).toHaveLength(1);
  });
});
