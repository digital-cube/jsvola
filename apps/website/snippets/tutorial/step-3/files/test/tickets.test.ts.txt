import { describe, expect, it } from "vitest";
import { AS_IGOR, testApp } from "./helpers.ts";

async function newTicket(app: Awaited<ReturnType<typeof testApp>>, title = "Printer on fire") {
  const res = await app.inject({
    method: "POST",
    url: "/tickets",
    headers: AS_IGOR,
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("POST /tickets", () => {
  it("creates a ticket in the first column", async () => {
    const app = await testApp();
    expect(await newTicket(app)).toMatchObject({
      title: "Printer on fire",
      status: "new",
      assignee: null,
    });
  });

  it("puts a newer ticket above an older one", async () => {
    const app = await testApp();
    const older = await newTicket(app, "older");
    const newer = await newTicket(app, "newer");
    const { payload } = (
      await app.inject({
        method: "POST",
        url: "/udc/list",
        payload: { collection: "tickets", sort: [{ field: "order" }] },
      })
    ).json();
    expect(payload.rows.map((row: { __meta: { id: string } }) => row.__meta.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("refuses a request from nobody", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "POST", url: "/tickets", payload: { title: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a user the desk does not know", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/tickets",
      headers: { "x-user-id": "mallory" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an empty title", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/tickets",
      headers: AS_IGOR,
      payload: { title: "   " },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("GET /tickets/:id", () => {
  it("answers with the ticket", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({ method: "GET", url: `/tickets/${ticket.id}` });
    expect(res.json()).toEqual(ticket);
  });

  it("answers 404 for a ticket that is not there", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "GET",
      url: "/tickets/0192f7a0-0000-7000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /tickets/:id/status", () => {
  it("moves the ticket", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/tickets/${ticket.id}/status`,
      headers: AS_IGOR,
      payload: { status: "in_progress" },
    });
    expect(res.json().status).toBe("in_progress");
  });

  it("refuses a status that is not a column", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/tickets/${ticket.id}/status`,
      headers: AS_IGOR,
      payload: { status: "lost" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /tickets/:id/assign", () => {
  it("sets the assignee", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/assign`,
      headers: AS_IGOR,
      payload: { assignee: "ana" },
    });
    expect(res.json().assignee).toBe("ana");
  });

  it("refuses somebody who is not on the desk", async () => {
    const app = await testApp();
    const ticket = await newTicket(app);
    const res = await app.inject({
      method: "POST",
      url: `/tickets/${ticket.id}/assign`,
      headers: AS_IGOR,
      payload: { assignee: "mallory" },
    });
    expect(res.statusCode).toBe(422);
  });
});
