import type { Status, Ticket } from "../shared/desk.ts";

/** One memento event: what happened (`event_type`), to what (`instance_*`), and who did it. */
export interface DeskEvent {
  event_type: string;
  instance_type: "tickets";
  instance_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}

const onTicket = (
  event_type: string,
  ticketId: string,
  actor: string,
  payload: Record<string, unknown>,
): DeskEvent => ({
  event_type,
  instance_type: "tickets",
  instance_id: ticketId,
  actor_id: actor,
  payload,
});

export const ticketCreated = (ticket: Ticket, actor: string) =>
  onTicket("TICKET_CREATED", ticket.id, actor, { title: ticket.title });

export const ticketCommented = (ticket: Ticket, actor: string, text: string) =>
  onTicket("TICKET_COMMENTED", ticket.id, actor, { text });

export const ticketStatusChanged = (ticket: Ticket, actor: string, previous: Status) =>
  onTicket("TICKET_STATUS_CHANGED", ticket.id, actor, { status: ticket.status, previous });

export const ticketAssigned = (ticket: Ticket, actor: string) =>
  onTicket("TICKET_ASSIGNED", ticket.id, actor, { assignee: ticket.assignee });

export const ticketFileAttached = (
  ticket: Ticket,
  actor: string,
  file: { id: string; filename: string; size: number; mime_type: string },
) =>
  onTicket("TICKET_FILE_ATTACHED", ticket.id, actor, {
    file_id: file.id,
    filename: file.filename,
    size: file.size,
    mime_type: file.mime_type,
  });
