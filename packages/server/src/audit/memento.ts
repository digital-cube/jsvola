/**
 * The audit trail of destructive and security-relevant operations, as memento events (plan
 * 5.2, decision 13 of `docs/PLAN.md`): every event is one `POST <VOLA_MEMENTO_URL>/events`
 * with a memento API key that holds the `write` scope. The integration is OPTIONAL — without
 * `VOLA_MEMENTO_URL` + `VOLA_MEMENTO_API_KEY` the sink is a `NoopSink` and nothing is logged
 * as an error (one INFO line at start). Delivery goes through `AuditLog` (`./log.ts`): a
 * BullMQ `audit` job with retries when the queue is there, one fire-and-forget try otherwise.
 *
 * What a payload NEVER carries: a share token, a password, an API key (plaintext or hash),
 * a file key — and the `filename` of an encrypted file (`encryption != none`).
 */
import type { FileRow } from "../db/schema.js";

/** The event types vola writes. `VOLA_KEYRING_*` join in phase 6.2 (TCKFT692JH). */
export const AUDIT_EVENT_TYPES = [
  "VOLA_FILE_DELETED",
  "VOLA_FILE_PURGED",
  "VOLA_FILE_VISIBILITY_CHANGED",
  "VOLA_SHARE_CREATED",
  "VOLA_SHARE_REVOKED",
  "VOLA_KEY_CREATED",
  "VOLA_KEY_REVOKED",
  "VOLA_INSTANCES_TRANSFERRED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** The memento `instance_type` of an event: what kind of thing it happened to. */
export const AUDIT_INSTANCE_TYPES = ["vola_file", "vola_share", "vola_key", "vola_tenant"] as const;
export type AuditInstanceType = (typeof AUDIT_INSTANCE_TYPES)[number];

/** Who did it: a principal of the host application (`X-User-Id`), an API key, the CLI. */
export const AUDIT_ACTOR_TYPES = ["user", "api_key", "cli"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** The body of `POST /events` as memento takes it (`EventCreate`). */
export interface AuditEvent {
  event_type: AuditEventType;
  instance_type: AuditInstanceType;
  /** The id of the file, share or key; the destination tenant's slug for a transfer. */
  instance_id: string;
  actor_type: AuditActorType | null;
  /** `X-User-Id`, `key:<prefix…last4>`, `cli:<user>`; `null` when nobody is known. */
  actor_id: string | null;
  payload: Record<string, unknown>;
  /** ISO 8601. */
  occurred_at: string;
}

/** Where audit events go. One `send` is one event; it rejects when the event did not land. */
export interface AuditSink {
  send(event: AuditEvent): Promise<void>;
}

/** The sink of a deployment without memento: every event is dropped, silently. */
export class NoopSink implements AuditSink {
  async send(): Promise<void> {}
}

/** Default wall-clock limit of one push to memento. */
export const MEMENTO_TIMEOUT_MS = 2000;

/** A push memento refused or that did not reach it; `retryable` says whether another try may help. */
export class AuditDeliveryError extends Error {
  constructor(
    message: string,
    /** The HTTP status memento answered; `null` for a network error or a timeout. */
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AuditDeliveryError";
  }
}

export interface MementoSinkOptions {
  /** The memento API base, e.g. `https://memento.example.com/memento`; `/events` is appended. */
  url: string;
  /** A memento API key with the `write` scope. */
  apiKey: string;
  /** Default `MEMENTO_TIMEOUT_MS` (2 s). */
  timeoutMs?: number | undefined;
  /** `fetch`, for tests. */
  fetch?: typeof fetch | undefined;
}

/**
 * The real sink: `POST <url>/events` with `Authorization: Bearer <key>`, JSON body, a 2 s
 * timeout. A `5xx`, `408`, `429` or a network failure is retryable (the queue tries again);
 * any other non-2xx is not (a bad key, a body memento refuses: another try changes nothing).
 */
export class MementoSink implements AuditSink {
  private readonly endpoint: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MementoSinkOptions) {
    this.endpoint = `${options.url.replace(/\/+$/, "")}/events`;
    this.authorization = `Bearer ${options.apiKey}`;
    this.timeoutMs = options.timeoutMs ?? MEMENTO_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Where events are posted (tests). */
  get url(): string {
    return this.endpoint;
  }

  async send(event: AuditEvent): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: this.authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AuditDeliveryError(`memento unreachable: ${reason}`, null, true);
    }
    if (response.ok) {
      await response.arrayBuffer().catch(() => undefined); // drain, so the socket is reused
      return;
    }
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new AuditDeliveryError(
      `memento answered ${response.status} to ${event.event_type}`,
      response.status,
      retryable,
    );
  }
}

// --- payloads ----------------------------------------------------------------------------

/**
 * What every file event says about its file: ids, size, MIME, kind, where it was — and the
 * name ONLY for a file that is not encrypted (the name of an encrypted file is itself
 * protected, plan 6).
 */
export function fileAuditPayload(
  row: Pick<
    FileRow,
    | "id"
    | "instanceType"
    | "instanceId"
    | "folderId"
    | "slug"
    | "size"
    | "mimeType"
    | "kind"
    | "encryption"
    | "filename"
  >,
): Record<string, unknown> {
  return {
    file_id: row.id,
    instance_type: row.instanceType,
    instance_id: row.instanceId,
    folder_id: row.folderId,
    slug: row.slug,
    size: Number(row.size),
    mime_type: row.mimeType,
    kind: row.kind,
    encryption: row.encryption,
    ...(row.encryption === "none" ? { filename: row.filename } : {}),
  };
}
