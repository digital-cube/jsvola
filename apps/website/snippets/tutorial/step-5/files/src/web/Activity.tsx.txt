import type { MementoEvent } from "@memento/react";
import { formatTime } from "@memento/react";
import type { ReactNode } from "react";

/** The feed: memento's sentence for each event, newest first. */
export function Activity({ events, status }: { events: MementoEvent[]; status?: ReactNode }) {
  return (
    <section className="activity" aria-label="Activity">
      <h2>Activity {status}</h2>
      <ol>
        {events.map((event) => (
          <li key={event.id}>
            <time dateTime={event.occurred_at}>{formatTime(event.occurred_at)}</time>
            <span data-event-type={event.event_type}>{event.rendered}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
