import type { FileEventKind } from "@vol-a/core";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

export type { FileEventKind } from "@vol-a/core";

/**
 * One change of one file, as every writer announces it AFTER its transaction committed.
 * Only ids travel: a subscriber reads the row from the database before it tells a client,
 * through the same masking and decoration as `list`, so nothing an encrypted row hides
 * ever crosses a channel.
 */
export interface FileEvent {
  tenantId: string;
  instanceType: string;
  instanceId: string;
  /** The folder the file is in NOW (`null`: the root); for `purged`, where it was. */
  folderId: string | null;
  fileId: string;
  kind: FileEventKind;
}

export type FileEventListener = (event: FileEvent) => void;

/**
 * Where file events go and come from. Every server process (and the worker of plan 4.1)
 * publishes on it; the UDC `files` source subscribes a tenant while it has a client for it.
 * `subscribe` resolves once events of the tenant are flowing and answers the function
 * that ends the subscription.
 */
export interface FileEventBus {
  publish(event: FileEvent): Promise<void>;
  subscribe(tenantId: string, listener: FileEventListener): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** The Redis channel of a tenant's file events. */
export const FILE_EVENTS_CHANNEL_PREFIX = "vola:files";
export function fileEventsChannel(tenantId: string, prefix = FILE_EVENTS_CHANNEL_PREFIX): string {
  return `${prefix}:${tenantId}`;
}

/** Listeners per tenant, shared by both buses. */
class ListenerTable {
  private readonly byTenant = new Map<string, Set<FileEventListener>>();

  /** Adds `listener`; `true` when it is the first one of the tenant. */
  add(tenantId: string, listener: FileEventListener): boolean {
    let set = this.byTenant.get(tenantId);
    if (!set) {
      set = new Set();
      this.byTenant.set(tenantId, set);
    }
    set.add(listener);
    return set.size === 1;
  }

  /** Removes `listener`; `true` when it was the last one of the tenant. */
  remove(tenantId: string, listener: FileEventListener): boolean {
    const set = this.byTenant.get(tenantId);
    if (!set?.delete(listener)) return false;
    if (set.size > 0) return false;
    this.byTenant.delete(tenantId);
    return true;
  }

  listeners(tenantId: string): FileEventListener[] {
    return [...(this.byTenant.get(tenantId) ?? [])];
  }

  tenants(): string[] {
    return [...this.byTenant.keys()].sort();
  }

  clear(): void {
    this.byTenant.clear();
  }
}

/**
 * In-process bus: what is published is delivered straight to this process's listeners.
 * For one server without `VOLA_REDIS_URL`, embedded use and tests. A listener that throws
 * does not stop the others.
 */
export class LocalFileEventBus implements FileEventBus {
  private readonly table = new ListenerTable();
  /** Everything published, for tests (`messages.length`). */
  readonly published: FileEvent[] = [];

  async publish(event: FileEvent): Promise<void> {
    this.published.push(event);
    for (const listener of this.table.listeners(event.tenantId)) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own; the bus keeps delivering.
      }
    }
  }

  async subscribe(tenantId: string, listener: FileEventListener): Promise<() => Promise<void>> {
    this.table.add(tenantId, listener);
    return async () => {
      this.table.remove(tenantId, listener);
    };
  }

  /** Tenants with at least one listener. */
  subscribed(): string[] {
    return this.table.tenants();
  }

  async close(): Promise<void> {
    this.table.clear();
  }
}

export interface RedisFileEventBusOptions {
  /** Channel prefix; events of a tenant travel on `<prefix>:<tenantId>`. */
  prefix?: string | undefined;
  /** A connection error, or a message that is not an event's JSON (dropped). */
  onError?: ((error: unknown, channel?: string) => void) | undefined;
  /** Clients to use instead of opening two from `url` (tests). */
  clients?: { publisher: Redis; subscriber: Redis } | undefined;
}

/**
 * Redis pub/sub bus: `publish` sends the event as JSON on the tenant's channel; listeners
 * receive what ANY process published, this one included (its own events come back through
 * Redis, so nothing is delivered twice). Two connections: a subscribed Redis connection
 * cannot run other commands. ioredis reconnects and re-subscribes by itself.
 */
export class RedisFileEventBus implements FileEventBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly prefix: string;
  private readonly table = new ListenerTable();

  constructor(url: string, options: RedisFileEventBusOptions = {}) {
    this.prefix = options.prefix ?? FILE_EVENTS_CHANNEL_PREFIX;
    this.publisher =
      options.clients?.publisher ?? new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.subscriber = options.clients?.subscriber ?? new Redis(url, { lazyConnect: true });
    const onError = options.onError ?? (() => {});
    // Without a listener an `error` event would crash the process.
    this.publisher.on("error", (error) => onError(error));
    this.subscriber.on("error", (error) => onError(error));
    this.subscriber.on("message", (channel: string, raw: string) => {
      const tenantId = this.tenantOf(channel);
      if (tenantId === null) return;
      let event: FileEvent;
      try {
        event = parseEvent(raw);
      } catch (error) {
        onError(error, channel);
        return;
      }
      if (event.tenantId !== tenantId) return; // a channel only ever carries its own tenant
      for (const listener of this.table.listeners(tenantId)) {
        try {
          listener(event);
        } catch (error) {
          onError(error, channel);
        }
      }
    });
  }

  channel(tenantId: string): string {
    return fileEventsChannel(tenantId, this.prefix);
  }

  private tenantOf(channel: string): string | null {
    const head = `${this.prefix}:`;
    return channel.startsWith(head) ? channel.slice(head.length) : null;
  }

  async publish(event: FileEvent): Promise<void> {
    await this.publisher.publish(this.channel(event.tenantId), JSON.stringify(event));
  }

  async subscribe(tenantId: string, listener: FileEventListener): Promise<() => Promise<void>> {
    if (this.table.add(tenantId, listener)) {
      try {
        await this.subscriber.subscribe(this.channel(tenantId));
      } catch (error) {
        this.table.remove(tenantId, listener);
        throw error;
      }
    }
    return async () => {
      if (this.table.remove(tenantId, listener)) {
        await this.subscriber.unsubscribe(this.channel(tenantId));
      }
    };
  }

  /** Tenants with at least one listener (whose channels are subscribed). */
  subscribed(): string[] {
    return this.table.tenants();
  }

  async close(): Promise<void> {
    this.table.clear();
    await Promise.all([
      this.publisher.quit().catch(() => this.publisher.disconnect()),
      this.subscriber.quit().catch(() => this.subscriber.disconnect()),
    ]);
  }
}

const KINDS = new Set<string>([
  "created",
  "updated",
  "deleted",
  "restored",
  "purged",
  "processing",
]);

/** The event a channel message carries; throws on anything that is not one. */
export function parseEvent(raw: string): FileEvent {
  const value = JSON.parse(raw) as Partial<FileEvent> | null;
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.tenantId !== "string" ||
    typeof value.instanceType !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.fileId !== "string" ||
    (value.folderId !== null && typeof value.folderId !== "string") ||
    typeof value.kind !== "string" ||
    !KINDS.has(value.kind)
  ) {
    throw new TypeError("not a file event");
  }
  return {
    tenantId: value.tenantId,
    instanceType: value.instanceType,
    instanceId: value.instanceId,
    folderId: value.folderId,
    fileId: value.fileId,
    kind: value.kind as FileEventKind,
  };
}

/**
 * The bus for a configuration: Redis pub/sub with `VOLA_REDIS_URL` (several server and
 * worker processes), in-process without one.
 */
export function createFileEventBus(
  redisUrl: string | null | undefined,
  options: { log?: FastifyBaseLogger | undefined; prefix?: string | undefined } = {},
): FileEventBus {
  if (!redisUrl) return new LocalFileEventBus();
  return new RedisFileEventBus(redisUrl, {
    prefix: options.prefix,
    onError: (error, channel) =>
      options.log?.warn({ err: error, ...(channel ? { channel } : {}) }, "file event bus error"),
  });
}

/** What a writer needs to announce a change; absent `events` means nobody listens. */
export interface FileEventPublisher {
  events?: FileEventBus | undefined;
  logger?: FastifyBaseLogger | undefined;
}

/**
 * Announces `event` after a commit. A failure to publish is logged and never raised: the
 * change is already durable, and the request that made it must not fail because a client
 * will have to reload.
 */
export async function publishFileEvent(deps: FileEventPublisher, event: FileEvent): Promise<void> {
  if (!deps.events) return;
  try {
    await deps.events.publish(event);
  } catch (error) {
    deps.logger?.warn(
      { err: error, file: event.fileId, kind: event.kind },
      "file event not published",
    );
  }
}

/** `publishFileEvent` for several files of the same instance and kind. */
export async function publishFileEvents(
  deps: FileEventPublisher,
  base: Pick<FileEvent, "tenantId" | "instanceType" | "instanceId" | "kind">,
  rows: { id: string; folderId: string | null }[],
): Promise<void> {
  for (const row of rows) {
    await publishFileEvent(deps, { ...base, folderId: row.folderId, fileId: row.id });
  }
}

/**
 * A `processing` event: the aggregate `processing_status` of a file changed. Published by
 * the worker of plan 4.1 after it recorded the job's outcome.
 *
 * TODO(4.1): call this from `worker.ts` when a thumbnail / OCR / metadata job finishes.
 */
export function publishProcessingStatus(
  deps: FileEventPublisher,
  file: Omit<FileEvent, "kind">,
): Promise<void> {
  return publishFileEvent(deps, { ...file, kind: "processing" });
}
