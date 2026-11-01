import type { FastifyBaseLogger } from "fastify";
import type { MementoConfig } from "../config.js";
import { currentContext, type TenantContext } from "../context.js";
import type { ProcessingQueue } from "../jobs/queue.js";
import {
  type AuditActorType,
  type AuditEvent,
  type AuditEventType,
  type AuditInstanceType,
  type AuditSink,
  MementoSink,
  NoopSink,
} from "./memento.js";

/** What a writer hands to `AuditLog.emit`; the actor and the tenant come from the request context unless given. */
export interface AuditEventInput {
  event_type: AuditEventType;
  instance_type: AuditInstanceType;
  instance_id: string;
  /** Ids, sizes, MIME types, slugs — never a secret, never the name of an encrypted file. */
  payload: Record<string, unknown>;
  /** Default: the request's actor (`actorOf(currentContext())`). */
  actor?: { type: AuditActorType; id: string } | null | undefined;
  /** Default: now. */
  occurredAt?: Date | undefined;
}

/** The actor of a request: its `X-User-Id`, else the key that called (`key:vola_live…k3Qz`). */
export function actorOf(
  context: Pick<TenantContext, "userId" | "apiKeyLabel"> | undefined,
): { type: AuditActorType; id: string } | null {
  if (!context) return null;
  if (context.userId) return { type: "user", id: context.userId };
  return { type: "api_key", id: `key:${context.apiKeyLabel}` };
}

export interface AuditLogOptions {
  sink: AuditSink;
  /**
   * The BullMQ queue (`async` mode): every event is an `audit` job the worker delivers with
   * retries. Absent: one direct try through `sink`, fire and forget.
   */
  queue?: ProcessingQueue | null | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

/**
 * The audit trail a request writes to. `emit` NEVER throws and is never awaited by the
 * request: the change it describes is already durable and must not fail because memento is
 * slow or down. With a queue the event is enqueued (five tries with exponential backoff in
 * the worker; a queue failure falls back to one direct try); without one it is pushed once.
 * `close()` waits for what is in flight (the app's `onClose`).
 */
export class AuditLog {
  private readonly sink: AuditSink;
  private readonly queue: ProcessingQueue | null;
  private readonly logger: FastifyBaseLogger | undefined;
  private readonly clock: () => Date;
  private readonly pending = new Set<Promise<void>>();
  /** `false`: a `NoopSink` and no queue — `emit` returns at once. */
  readonly enabled: boolean;

  constructor(options: AuditLogOptions) {
    this.sink = options.sink;
    this.queue = options.queue ?? null;
    this.logger = options.logger;
    this.clock = options.now ?? (() => new Date());
    this.enabled = !(options.sink instanceof NoopSink);
  }

  /** The complete event `input` becomes: actor and tenant from the current request context. */
  complete(input: AuditEventInput): AuditEvent {
    const context = currentContext();
    const actor = input.actor === undefined ? actorOf(context) : input.actor;
    const payload = { ...input.payload };
    if (payload.tenant === undefined && context?.tenantSlug) payload.tenant = context.tenantSlug;
    return {
      event_type: input.event_type,
      instance_type: input.instance_type,
      instance_id: input.instance_id,
      actor_type: actor?.type ?? null,
      actor_id: actor?.id ?? null,
      payload,
      occurred_at: (input.occurredAt ?? this.clock()).toISOString(),
    };
  }

  /** Records `input`; returns at once. */
  emit(input: AuditEventInput): void {
    if (!this.enabled) return;
    const event = this.complete(input);
    const task = this.deliver(event)
      .catch((error: unknown) => {
        this.logger?.warn(
          { err: error, event: event.event_type, instance: event.instance_id },
          "audit event not delivered",
        );
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  private async deliver(event: AuditEvent): Promise<void> {
    if (this.queue) {
      try {
        await this.queue.enqueueAudit(event);
        return;
      } catch (error) {
        this.logger?.warn({ err: error }, "audit job not queued: one direct try instead");
      }
    }
    await this.sink.send(event);
  }

  /** Waits for every emit in flight (bounded by the sink's timeout). */
  async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

/**
 * The sink of a configuration: memento when configured, a `NoopSink` otherwise. The one
 * place the choice is logged — INFO either way, never an error: a deployment without
 * memento is a supported one.
 */
export function createAuditSink(
  memento: MementoConfig | null,
  log?: Pick<FastifyBaseLogger, "info"> | undefined,
): AuditSink {
  if (!memento) {
    log?.info("audit disabled: VOLA_MEMENTO_URL / VOLA_MEMENTO_API_KEY are not set");
    return new NoopSink();
  }
  const sink = new MementoSink(memento);
  log?.info({ url: sink.url }, "audit enabled: events go to memento");
  return sink;
}

/** An `AuditLog` that records nothing (tests, embedded use without memento). */
export function disabledAuditLog(): AuditLog {
  return new AuditLog({ sink: new NoopSink() });
}
