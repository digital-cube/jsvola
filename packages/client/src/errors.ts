import { ErrorResponseSchema, INTEGRITY_ERROR_CODE, REQUEST_ID_HEADER } from "@vola/core";

export interface VolaErrorInit {
  /** The HTTP status; `0` for an error raised by the SDK itself (before any request went out). */
  status: number;
  /** The server's snake_case code (`file_not_found`, `vola_locked`, …) or an SDK code (`invalid_response`). */
  code: string;
  message: string;
  /** Seconds to wait before trying again (`Retry-After`, or `retry_after` of the body), when the server said so. */
  retryAfter?: number | undefined;
  /** Everything else the error envelope carried (`required` scopes, `attempts`, `reason`, …). */
  details?: Record<string, unknown> | undefined;
  /** `X-Request-Id` of the answer, for a support ticket. */
  requestId?: string | null | undefined;
}

/**
 * A non-2xx answer of the server, carrying its `{ error: { code, message, … } }` envelope —
 * or an error the SDK raised itself (`status: 0`). Never a secret: no key, token, PIN or
 * share secret is ever part of the message or the details.
 */
export class VolaError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(init: VolaErrorInit) {
    super(init.message);
    this.name = "VolaError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
  }
}

/** `423 vola_locked`: the request needs an unlock token (keyring) or a content key (caller) it did not carry, or the one it carried is dead. */
export class VolaLockedError extends VolaError {
  constructor(init: VolaErrorInit) {
    super(init);
    this.name = "VolaLockedError";
  }
}

/** `409 vola_integrity`: the file (or a share grant) could not be decrypted — a wrong key, a wrong secret, or damaged bytes. */
export class VolaIntegrityError extends VolaError {
  constructor(init: VolaErrorInit) {
    super(init);
    this.name = "VolaIntegrityError";
  }
}

/** @deprecated The name of the health-only client's error; `VolaError` is the same class. */
export const VolaApiError = VolaError;

const INTEGER_RE = /^\d{1,9}$/;

/** `Retry-After` in seconds (the delta form only; an HTTP date is ignored). */
function retryAfterOf(response: Response, details: Record<string, unknown>): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (header && INTEGER_RE.test(header)) return Number(header);
  const body = details.retry_after;
  return typeof body === "number" && Number.isFinite(body) ? body : undefined;
}

/**
 * The `VolaError` of a non-2xx `response`: the envelope when the body is one, `unknown_error`
 * with `HTTP <status>` otherwise. `423` is a `VolaLockedError`, `409 vola_integrity` a
 * `VolaIntegrityError`. Consumes the body.
 */
export async function errorFromResponse(response: Response): Promise<VolaError> {
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = ErrorResponseSchema.safeParse(body);
  const raw =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
  const details: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
  delete details.code;
  delete details.message;
  const init: VolaErrorInit = parsed.success
    ? {
        status: response.status,
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        details,
        retryAfter: retryAfterOf(response, details),
        requestId: response.headers.get(REQUEST_ID_HEADER),
      }
    : {
        status: response.status,
        code: "unknown_error",
        message: `HTTP ${response.status}`,
        details,
        retryAfter: retryAfterOf(response, details),
        requestId: response.headers.get(REQUEST_ID_HEADER),
      };
  if (response.status === 423) return new VolaLockedError(init);
  if (response.status === 409 && init.code === INTEGRITY_ERROR_CODE) {
    return new VolaIntegrityError(init);
  }
  return new VolaError(init);
}
