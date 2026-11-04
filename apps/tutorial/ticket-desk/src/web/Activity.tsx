import { formatTime, type MementoEvent, StatusIndicator, useMementoEvents } from "@memento/react";
import { useEffect } from "react";
import { ticketEvents } from "./feed.ts";

/**
 * The feed: memento's sentence for each event, newest first, and every new event as it is stored.
 * One subscription to the whole desk: with `ticketId` it shows that ticket's part of it. A write
 * by anybody, in any tab, arrives here, so nothing has to reload after an action any more.
 */
export function Activity({
  ticketId,
  onEvent,
}: {
  ticketId?: string;
  /** Called with each newest event: what else on the page has to catch up. */
  onEvent?: (event: MementoEvent) => void;
}) {
  const { events, status, liveIds } = useMementoEvents({}, { limit: 200 });
  const shown = ticketId ? ticketEvents(events, ticketId) : events;
  const newest = events[0];

  useEffect(() => {
    if (newest) onEvent?.(newest);
  }, [newest, onEvent]);

  return (
    <section className="activity memento" aria-label="Activity">
      <h2>
        Activity <StatusIndicator status={status} />
      </h2>
      <ol>
        {shown.map((event) => (
          <li key={event.id} className={liveIds.has(event.id) ? "fresh" : undefined}>
            <time dateTime={event.occurred_at}>{formatTime(event.occurred_at)}</time>
            <span data-event-type={event.event_type}>{event.rendered}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
