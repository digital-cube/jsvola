/** An error that maps to a `{ error: { code, message, …details } }` response with `status`. */
export class VolaError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    /** Extra fields of the error body (`required` of a `forbidden`, …). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VolaError";
  }
}

/** Error codes of the framework's own errors (bad JSON, wrong content type, …), by HTTP status. */
export const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  408: "request_timeout",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  416: "range_not_satisfiable",
  422: "unprocessable",
  423: "locked",
  429: "too_many_requests",
  500: "internal_error",
  501: "not_implemented",
  503: "service_unavailable",
};

/** The stable code of an HTTP status; `bad_request` / `internal_error` for unlisted ones. */
export function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? "internal_error" : "bad_request");
}
