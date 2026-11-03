interface FeedEvent {
  event_type: string;
  instance_type: string;
  instance_id: string;
  payload: Record<string, unknown>;
}

/**
 * The events of one ticket, out of the events of the whole desk.
 *
 * Our own events are on the instance `tickets/<id>`. vola's are not: it knows nothing about
 * tickets, so a deleted file is on `vola_file/<file id>` and a new share on `vola_share/<share
 * id>`. They still lead back to the ticket: a file's event says which instance the file is in, and
 * a share's says which file it is for, and TICKET_FILE_ATTACHED says which ticket has that file.
 */
export function ticketEvents<E extends FeedEvent>(events: E[], ticketId: string): E[] {
  const files = new Set(
    events
      .filter((e) => e.event_type === "TICKET_FILE_ATTACHED" && e.instance_id === ticketId)
      .map((e) => e.payload.file_id),
  );
  return events.filter((e) => {
    if (e.instance_type === "tickets") return e.instance_id === ticketId;
    if (e.payload.instance_type === "tickets") return e.payload.instance_id === ticketId;
    return files.has(e.payload.file_id);
  });
}
