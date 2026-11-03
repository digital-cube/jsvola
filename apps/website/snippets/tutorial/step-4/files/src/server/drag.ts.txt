import type { Source } from "@jsudc/server";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { STATUSES, type Status } from "../shared/desk.ts";
import { ticketStatusChanged } from "./events.ts";
import type { Emit } from "./memento.ts";
import { actorOf, toTicket } from "./tickets.ts";

/** A card dropped in another column. A drop inside its own column carries no `status`. */
const CardMove = z.looseObject({
  collection: z.literal("tickets"),
  op: z.literal("update"),
  id: z.uuid(),
  row: z.looseObject({ status: z.enum(STATUSES) }),
});

/**
 * The board writes through UDC's `POST /udc/mutate`, not through our routes. These two hooks stand
 * around that route, so a dragged card gives the same TICKET_STATUS_CHANGED as the status route.
 */
export function emitOnDrag(app: FastifyInstance, tickets: Source, emit: Emit) {
  const moves = new WeakMap<FastifyRequest, { actor: string; previous: Status }>();

  app.addHook("preHandler", async (request) => {
    if (request.url !== "/udc/mutate") return;
    const move = CardMove.safeParse(request.body);
    if (!move.success) return;
    const actor = actorOf(request);
    const row = await tickets.read(move.data.id).catch(() => null); // mutate will answer not_found
    if (row) moves.set(request, { actor, previous: toTicket(row).status });
  });

  app.addHook("onSend", async (request, _reply, payload) => {
    const move = moves.get(request);
    if (!move) return payload;
    const answer = JSON.parse(String(payload));
    if (answer.kind === "udc.mutate.ok") {
      const ticket = toTicket(answer.payload.row);
      if (ticket.status !== move.previous) {
        await emit(ticketStatusChanged(ticket, move.actor, move.previous));
      }
    }
    return payload;
  });
}
