import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { STATUSES, type Ticket } from "../shared/desk.ts";
import { Activity } from "./Activity.tsx";
import { assign, comment, getTicket, setStatus } from "./api.ts";
import { Files } from "./Files.tsx";
import { useSession } from "./session.ts";

export function TicketPage() {
  const id = String(useParams().id);
  const { user, users } = useSession();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [text, setText] = useState("");

  // Read at the start, and again on every new event: somebody else may have just moved it.
  const reload = useCallback(() => {
    getTicket(id, user).then(setTicket);
  }, [id, user]);
  useEffect(reload, [reload]);

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    await comment(id, user, text);
    setText("");
  };

  if (!ticket) return null;

  return (
    <main className="ticket-page">
      <div className="ticket-main">
        <h1>{ticket.title}</h1>
        <div className="row">
          <label>
            Status{" "}
            <select value={ticket.status} onChange={(e) => setStatus(id, user, e.target.value)}>
              {STATUSES.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </label>
          <label>
            Assignee{" "}
            <select
              value={ticket.assignee ?? ""}
              onChange={(e) => assign(id, user, e.target.value)}
            >
              <option value="" disabled>
                nobody
              </option>
              {users.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
        <form className="row" onSubmit={submitComment}>
          <input
            aria-label="Comment"
            placeholder="Write a comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={!text.trim()}>
            Comment
          </button>
        </form>
        <Files ticketId={id} />
      </div>
      <Activity ticketId={id} onEvent={reload} />
    </main>
  );
}
