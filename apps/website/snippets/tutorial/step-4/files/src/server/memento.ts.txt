import type { DeskEvent } from "./events.ts";

export type Emit = (event: DeskEvent) => Promise<void>;

interface Log {
  warn(obj: unknown, msg: string): void;
}

/**
 * `POST /memento/events`. The change is already saved when the event goes out, so a memento that
 * is down costs a log line, never the user's request.
 */
export function mementoEmitter(url: string, key: string, log: Log): Emit {
  return async (event) => {
    try {
      const response = await fetch(`${url}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error(`memento answered ${response.status}`);
    } catch (error) {
      log.warn({ err: error, event_type: event.event_type }, "event not delivered");
    }
  };
}
