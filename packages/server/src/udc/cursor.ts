import { UdcError } from "@jsudc/core";

/**
 * Where a page of a keyset-paged collection ended: the sort key and its value on the last
 * row, and that row's id (the tiebreak). Opaque on the wire — base64url of a JSON tuple, the
 * same approach as the `?cursor=` of `GET /files/:type/:id` — and bound to the sort it was
 * produced under: a cursor of another sort is refused.
 */
export interface PageCursor {
  field: string;
  dir: "asc" | "desc";
  value: string | number;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodePageCursor(cursor: PageCursor): string {
  const tuple = [cursor.field, cursor.dir, cursor.value, cursor.id];
  return Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url");
}

/** `validation_error` for anything that is not a cursor of this collection. */
export function decodePageCursor(raw: string): PageCursor {
  let tuple: unknown;
  try {
    tuple = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    tuple = null;
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 4 ||
    typeof tuple[0] !== "string" ||
    (tuple[1] !== "asc" && tuple[1] !== "desc") ||
    (typeof tuple[2] !== "string" && typeof tuple[2] !== "number") ||
    typeof tuple[3] !== "string" ||
    !UUID_RE.test(tuple[3])
  ) {
    throw new UdcError("validation_error", "cursor: not a cursor of this collection");
  }
  return { field: tuple[0], dir: tuple[1], value: tuple[2], id: tuple[3] };
}
