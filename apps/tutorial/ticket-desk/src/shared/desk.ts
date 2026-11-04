/** Who can "sign in": a pick from this list is the whole login of this program. */
export const USERS = ["igor", "ana", "marko"] as const;

/** A ticket's status. Each one is a column of the board (collections/buckets/seed.json). */
export const STATUSES = ["new", "in_progress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export const BOARD_ID = "desk";

export interface Ticket {
  id: string;
  title: string;
  body: string;
  status: Status;
  assignee: string | null;
}
