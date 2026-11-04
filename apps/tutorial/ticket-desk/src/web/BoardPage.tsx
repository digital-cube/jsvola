import { type FormEvent, useState } from "react";
import { Activity } from "./Activity.tsx";
import { createTicket } from "./api.ts";
import { Board, refreshBoard } from "./Board.tsx";
import { useSession } from "./session.ts";

export function BoardPage() {
  const { user } = useSession();
  const [title, setTitle] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await createTicket(user, title, "");
    setTitle("");
  };

  return (
    <main className="board-page">
      <form className="row" onSubmit={submit}>
        <input
          aria-label="Title of the new ticket"
          placeholder="What is wrong?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" disabled={!title.trim()}>
          New ticket
        </button>
      </form>
      <Board />
      <Activity onEvent={refreshBoard} />
    </main>
  );
}
