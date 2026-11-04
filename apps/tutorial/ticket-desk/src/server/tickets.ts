import type { Row } from "@jsudc/core";
import type { Source } from "@jsudc/server";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BOARD_ID, STATUSES, type Status, type Ticket, USERS } from "../shared/desk.ts";
import {
  ticketAssigned,
  ticketCommented,
  ticketCreated,
  ticketFileAttached,
  ticketStatusChanged,
} from "./events.ts";
import type { Emit } from "./memento.ts";

const IdParams = z.object({ id: z.uuid() });
const NewTicket = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(5000).default(""),
});
const NewStatus = z.object({ status: z.enum(STATUSES) });
const Assignment = z.object({ assignee: z.enum(USERS) });
const NewComment = z.object({ text: z.string().trim().min(1).max(5000) });
const AttachedFile = z.object({ file_id: z.string().min(1) });

/** The facts of a file in vola, or a rejection when it is not on this ticket. */
export type FileLookup = (
  ticketId: string,
  fileId: string,
) => Promise<{ id: string; filename: string; size: number; mime_type: string }>;

export interface TicketRoutesOptions {
  tickets: Source;
  emit: Emit;
  lookupFile: FileLookup;
}

/** What goes wrong is an HTTP status: Fastify answers with the error's `statusCode`. */
function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** `X-User-Id` is the signed-in user of this program: one of USERS, or the request is refused. */
export function actorOf(request: FastifyRequest): string {
  const actor = request.headers["x-user-id"];
  if (typeof actor === "string" && (USERS as readonly string[]).includes(actor)) return actor;
  throw httpError(401, "X-User-Id must name one of the desk's users");
}

/** A row of the `tickets` collection as the API shows it. */
export function toTicket(row: Row): Ticket {
  return {
    id: row.__meta.id,
    title: String(row.title),
    body: String(row.body ?? ""),
    status: row.status as Status,
    assignee: (row.assignees as string[] | undefined)?.[0] ?? null,
  };
}

/** The first free place at the top of a column: 100 above the card that is there now. */
async function topOrder(tickets: Source, status: Status): Promise<number> {
  const { rows } = await tickets.list({
    filter: { field: "status", op: "eq", value: status },
    sort: [{ field: "order" }],
    page: { limit: 1 },
  });
  return Number(rows[0]?.order ?? 0) - 100;
}

export async function ticketRoutes(app: FastifyInstance, opts: TicketRoutesOptions) {
  const { tickets, emit, lookupFile } = opts;

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(422).send({ error: z.prettifyError(error) });
    if (error.code === "not_found") return reply.code(404).send({ error: "no such ticket" });
    return reply.code(error.statusCode ?? 500).send({ error: error.message });
  });

  app.post("/tickets", async (request, reply) => {
    const actor = actorOf(request);
    const { title, body } = NewTicket.parse(request.body);
    const row = await tickets.mutate({
      op: "insert",
      row: {
        board_id: BOARD_ID,
        status: "new",
        order: await topOrder(tickets, "new"),
        title,
        body,
        assignees: [],
      },
    });
    const ticket = toTicket(row);
    await emit(ticketCreated(ticket, actor));
    return reply.code(201).send(ticket);
  });

  app.get("/tickets/:id", async (request) => {
    const { id } = IdParams.parse(request.params);
    return toTicket(await tickets.read(id));
  });

  app.patch("/tickets/:id/status", async (request) => {
    const actor = actorOf(request);
    const { id } = IdParams.parse(request.params);
    const { status } = NewStatus.parse(request.body);
    const before = toTicket(await tickets.read(id));
    if (before.status === status) return before;
    const ticket = toTicket(
      await tickets.mutate({
        op: "update",
        id,
        row: { status, order: await topOrder(tickets, status) },
      }),
    );
    await emit(ticketStatusChanged(ticket, actor, before.status));
    return ticket;
  });

  app.post("/tickets/:id/assign", async (request) => {
    const actor = actorOf(request);
    const { id } = IdParams.parse(request.params);
    const { assignee } = Assignment.parse(request.body);
    const ticket = toTicket(
      await tickets.mutate({ op: "update", id, row: { assignees: [assignee] } }),
    );
    await emit(ticketAssigned(ticket, actor));
    return ticket;
  });

  // A comment is nothing but its event: memento is where the comments live.
  app.post("/tickets/:id/comments", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = IdParams.parse(request.params);
    const { text } = NewComment.parse(request.body);
    await emit(ticketCommented(toTicket(await tickets.read(id)), actor, text));
    return reply.code(201).send({ ok: true });
  });

  // The browser uploads straight to vola and then says so here. We ask vola for the file, so the
  // event carries vola's facts and a file that is not on this ticket is refused.
  app.post("/tickets/:id/files", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = IdParams.parse(request.params);
    const { file_id } = AttachedFile.parse(request.body);
    const ticket = toTicket(await tickets.read(id));
    const file = await lookupFile(id, file_id).catch(() => {
      throw httpError(422, "that file is not on this ticket");
    });
    await emit(ticketFileAttached(ticket, actor, file));
    return reply.code(201).send({ ok: true });
  });
}
