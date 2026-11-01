import { randomUUID } from "node:crypto";
import { type FilterNode, type Row, UdcError } from "@jsudc/core";
import type { CollectionRegistry } from "@jsudc/server";
import {
  type ClientMessage,
  ClientMessageSchema,
  type FileEventKind,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  type ServerMessage,
  SUBSCRIBE_CLOSE_CODES,
  SUBSCRIBE_PROTOCOL_VERSION,
  SubscribePayloadSchema,
} from "@vola/core";
import type { FastifyBaseLogger } from "fastify";
import { type BoundTenantContext, runWithTenant } from "../context.js";
import { isSubscribable, type RowSink, type Subscription } from "./subscribable.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_BUFFERED_MESSAGES = 1000;
/** How long a slow consumer gets to complete the close handshake before it is cut off. */
const SLOW_CLOSE_GRACE_MS = 5_000;
const OPEN = 1; // WebSocket.OPEN

/** The part of a `ws` WebSocket the hub uses (a fake one in unit tests). */
export interface SubscribeSocket {
  readonly readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
}

export interface SubscriptionHubOptions {
  registry: CollectionRegistry;
  log: FastifyBaseLogger;
  /** Ping every connection this often; one that missed the last ping is cut off. Default 30 s. */
  heartbeatIntervalMs?: number | undefined;
  /** Unwritten messages a connection may accumulate before it is dropped (4008). Default 1000. */
  maxBufferedMessages?: number | undefined;
  /** Subscriptions one connection may hold. Default `MAX_SUBSCRIPTIONS_PER_CONNECTION`. */
  maxSubscriptions?: number | undefined;
}

interface OpenSubscription {
  collection: string;
  subscription: Subscription;
}

/**
 * One client. Messages go out through `send`; those `ws` has not yet handed to the kernel
 * are counted, and a client that lets `maxBuffered` of them pile up is disconnected with
 * 4008 — other clients are not affected. Subscriptions are opened and closed by messages
 * (`udc.subscribe` / `udc.unsubscribe`, keyed by the message `id`) and all end with the
 * connection.
 */
export class SubscriptionConnection {
  readonly id = randomUUID();
  readonly tenant: BoundTenantContext;
  readonly log: FastifyBaseLogger;
  /** Messages handed to the socket whose write has not completed yet. */
  pending = 0;
  closed = false;
  private alive = true;
  private readonly subscriptions = new Map<string, OpenSubscription>();
  /** `udc.subscribe` messages are served one after another: no race between two of one id. */
  private inbox: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: SubscribeSocket,
    tenant: BoundTenantContext,
    private readonly hub: SubscriptionHub,
    log: FastifyBaseLogger,
  ) {
    this.tenant = tenant;
    this.log = log.child({ tenant: tenant.tenantSlug, connection: this.id });
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (data) => {
      this.alive = true; // any message counts as an answer to the heartbeat
      this.inbox = this.inbox.then(() => this.receive(data));
    });
  }

  /** Open subscriptions by id. */
  get open(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Sends the welcome: from now on `udc.subscribe` is answered. */
  welcome(): void {
    this.send({
      kind: "udc.welcome",
      id: "",
      payload: {
        protocol_version: SUBSCRIBE_PROTOCOL_VERSION,
        tenant: this.tenant.tenantSlug,
        heartbeat_interval_ms: this.hub.heartbeatIntervalMs,
        max_buffered_messages: this.hub.maxBufferedMessages,
        max_subscriptions: this.hub.maxSubscriptions,
      },
    });
  }

  /** Queues one message; `false` when it was not sent (closed, or too slow and now dropped). */
  send(message: ServerMessage): boolean {
    if (this.closed || this.socket.readyState !== OPEN) return false;
    if (this.pending >= this.hub.maxBufferedMessages) {
      this.dropSlow();
      return false;
    }
    this.pending++;
    this.socket.send(JSON.stringify(message), (error) => {
      this.pending--;
      if (error) this.log.debug({ err: error }, "subscribe send failed");
    });
    return true;
  }

  /** One heartbeat tick: cut off a client that did not answer the previous ping. */
  heartbeat(): void {
    if (this.closed) return;
    if (!this.alive) {
      this.log.info("subscribe client missed a heartbeat; terminating");
      this.closed = true;
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(code, reason);
  }

  /** Ends every subscription (the socket is already closed or closing). */
  async dispose(): Promise<void> {
    this.closed = true;
    const open = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(open.map((s) => s.subscription.close().catch(() => undefined)));
  }

  private dropSlow(): void {
    this.log.warn(
      { pending: this.pending, max_buffered_messages: this.hub.maxBufferedMessages },
      "slow consumer threshold exceeded; disconnecting",
    );
    this.close(SUBSCRIBE_CLOSE_CODES.slow_consumer, "slow consumer");
    // The close frame queues behind everything the client has not read: do not wait for it.
    setTimeout(() => this.socket.terminate(), SLOW_CLOSE_GRACE_MS).unref();
  }

  private async receive(data: unknown): Promise<void> {
    if (this.closed) return;
    let message: ClientMessage;
    try {
      const parsed = ClientMessageSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) {
        throw new UdcError(
          "validation_error",
          "a client message is {kind: udc.subscribe | udc.unsubscribe | udc.ping, id, payload?}",
        );
      }
      message = parsed.data;
    } catch (error) {
      this.send({
        kind: "udc.error",
        id: "",
        payload: {
          code: error instanceof UdcError ? error.code : "validation_error",
          message: error instanceof UdcError ? error.message : "not a JSON message",
        },
      });
      return;
    }
    switch (message.kind) {
      case "udc.ping":
        this.send({ kind: "udc.pong", id: message.id, payload: {} });
        return;
      case "udc.unsubscribe":
        await this.unsubscribe(message.id);
        return;
      case "udc.subscribe":
        await this.subscribe(message.id, message.payload);
        return;
    }
  }

  private async subscribe(id: string, payload: unknown): Promise<void> {
    const refuse = (error: UdcError): void => {
      this.send({ kind: "udc.subscribe.err", id, payload: error.toPayload() });
    };
    const parsed = SubscribePayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      return refuse(new UdcError("validation_error", "payload: {collection, filter?} is required"));
    }
    if (this.subscriptions.has(id)) {
      return refuse(new UdcError("validation_error", `subscription "${id}" is already open`));
    }
    if (this.subscriptions.size >= this.hub.maxSubscriptions) {
      return refuse(
        new UdcError(
          "validation_error",
          `at most ${this.hub.maxSubscriptions} subscriptions per connection`,
        ),
      );
    }
    const { collection, filter } = parsed.data;
    let source: ReturnType<CollectionRegistry["get"]>["source"];
    try {
      source = this.hub.registry.get(collection).source;
    } catch {
      return refuse(new UdcError("not_found", `no collection "${collection}"`));
    }
    if (!isSubscribable(source)) {
      return refuse(
        new UdcError("unsupported_op", `collection "${collection}" cannot be subscribed`),
      );
    }
    const sink: RowSink = {
      upsert: (row: Row, event: FileEventKind) =>
        this.send({ kind: "udc.row.upsert", id, payload: { collection, row, event } }),
      remove: (rowId: string, event: FileEventKind) =>
        this.send({ kind: "udc.row.remove", id, payload: { collection, id: rowId, event } }),
    };
    let subscription: Subscription;
    try {
      subscription = await runWithTenant(this.tenant, () =>
        source.subscribe(filter as FilterNode | undefined, sink),
      );
    } catch (error) {
      if (error instanceof UdcError) {
        if (error.code === "internal") {
          refuse(error);
          this.close(SUBSCRIBE_CLOSE_CODES.feed_unavailable, "event feed unavailable");
          return;
        }
        return refuse(error);
      }
      this.log.error({ err: error, collection }, "subscribe failed");
      return refuse(new UdcError("internal", "subscribe failed"));
    }
    if (this.closed) {
      await subscription.close().catch(() => undefined);
      return;
    }
    this.subscriptions.set(id, { collection, subscription });
    this.log.info({ subscription: id, collection, filter }, "subscribed");
    this.send({ kind: "udc.subscribe.ok", id, payload: { collection, filter } });
  }

  private async unsubscribe(id: string): Promise<void> {
    const open = this.subscriptions.get(id);
    if (!open) {
      this.send({
        kind: "udc.error",
        id,
        payload: { code: "not_found", message: `no subscription "${id}"` },
      });
      return;
    }
    this.subscriptions.delete(id);
    await open.subscription.close().catch(() => undefined);
    this.send({ kind: "udc.unsubscribe.ok", id, payload: {} });
  }
}

/**
 * The WebSocket connections of `/udc/subscribe`. Each one belongs to the tenant its key
 * authenticated; what it may subscribe to is decided by the collection's source, which
 * reads that tenant and nothing else.
 */
export class SubscriptionHub {
  readonly registry: CollectionRegistry;
  readonly heartbeatIntervalMs: number;
  readonly maxBufferedMessages: number;
  readonly maxSubscriptions: number;
  private readonly log: FastifyBaseLogger;
  private readonly connections = new Set<SubscriptionConnection>();
  private readonly timer: NodeJS.Timeout;

  constructor(options: SubscriptionHubOptions) {
    this.registry = options.registry;
    this.log = options.log;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxBufferedMessages = options.maxBufferedMessages ?? DEFAULT_MAX_BUFFERED_MESSAGES;
    this.maxSubscriptions = options.maxSubscriptions ?? MAX_SUBSCRIPTIONS_PER_CONNECTION;
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.timer.unref();
  }

  /** Registers a connected socket and welcomes it. */
  add(socket: SubscribeSocket, tenant: BoundTenantContext): SubscriptionConnection {
    const connection = new SubscriptionConnection(socket, tenant, this, this.log);
    this.connections.add(connection);
    socket.on("close", () => this.remove(connection));
    connection.welcome();
    connection.log.info("subscribe client connected");
    return connection;
  }

  /** Forgets a closed connection and ends its subscriptions. */
  remove(connection: SubscriptionConnection): void {
    if (!this.connections.delete(connection)) return;
    void connection.dispose();
    connection.log.info("subscribe client disconnected");
  }

  /** Open connections. */
  size(): number {
    return this.connections.size;
  }

  private heartbeat(): void {
    for (const connection of this.connections) connection.heartbeat();
  }

  /** Closes every connection (1001) and stops the heartbeat. */
  close(): void {
    clearInterval(this.timer);
    for (const connection of this.connections) {
      connection.close(SUBSCRIBE_CLOSE_CODES.going_away, "server shutting down");
    }
  }
}
