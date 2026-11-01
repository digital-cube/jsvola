import { CollectionRegistry } from "@jsudc/server";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION } from "@vola/core";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundTenantContext } from "../src/context.js";
import { type SubscribeSocket, SubscriptionConnection, SubscriptionHub } from "../src/udc/hub.js";
import { isSubscribable, type RowSink } from "../src/udc/subscribable.js";
import { selectSubprotocol } from "../src/udc/subscribe-route.js";

const tenant: BoundTenantContext = {
  tenantId: "t1",
  tenantSlug: "acme",
  apiKeyId: "k1",
  scopes: ["files:read"],
  isAdmin: false,
  userId: null,
};

/** A socket whose `send` callbacks fire only when the test says so. */
class FakeSocket implements SubscribeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly callbacks: ((error?: Error) => void)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(private readonly autoFlush: boolean) {}

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    if (this.autoFlush) callback();
    else this.callbacks.push(callback);
  }
  flush(error?: Error): void {
    for (const callback of this.callbacks.splice(0)) callback(error);
  }
  ping(): void {
    this.pings++;
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  messages(): { kind: string; id: string; payload: Record<string, unknown> }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const log = (): FastifyBaseLogger =>
  ({
    child: () => log(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as FastifyBaseLogger;

/** A registry with a subscribable `live` collection whose sinks the test drives. */
function registry() {
  const sinks: RowSink[] = [];
  const closed: number[] = [];
  const reg = new CollectionRegistry();
  const base = {
    describe: async () => ({ version: "v1", core_fields: [], fields: {}, field_order: [] }),
    list: async () => ({ rows: [], next_cursor: null, total: 0 }),
    read: async () => {
      throw new Error("no");
    },
    mutate: async () => {
      throw new Error("no");
    },
    addField: async () => {
      throw new Error("no");
    },
    updateField: async () => {
      throw new Error("no");
    },
    softDeleteField: async () => {
      throw new Error("no");
    },
  };
  const caps = {
    mutate: false,
    subscribe: true,
    total_count: false,
    schema_edit: false,
    config_edit: false,
    reindex: false,
    tree_reparent: false,
    source_yaml: false,
    supported_filter_ops: [],
  };
  const view = {
    default_renderer: "table",
    available_renderers: ["table"],
    columns: [],
    page_size_default: 50,
    pagination: "pages" as const,
    default_column_width: 100,
    row_actions: [],
  };
  reg.register({
    name: "live",
    view,
    source: {
      ...base,
      capabilities: caps,
      subscribe: async (_filter: unknown, sink: RowSink) => {
        await tick(); // like a real feed subscription: the connection may close meanwhile
        const index = sinks.push(sink) - 1;
        return { close: async () => void closed.push(index) };
      },
    } as never,
  });
  reg.register({
    name: "exploding",
    view,
    source: {
      ...base,
      capabilities: caps,
      subscribe: async () => {
        throw new Error("kaboom");
      },
    } as never,
  });
  reg.register({
    name: "static",
    view,
    source: { ...base, capabilities: { ...caps, subscribe: false } } as never,
  });
  return { reg, sinks, closed };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Enough ticks for a chain of queued messages, each subscribing over a tick, to settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
/** Fake timers that leave `setImmediate` (the test's `tick`) real. */
const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

describe("SubscriptionConnection", () => {
  const hubs: SubscriptionHub[] = [];
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.close();
    vi.useRealTimers();
  });
  function makeHub(options: { maxBufferedMessages?: number; heartbeatIntervalMs?: number } = {}) {
    const { reg, sinks, closed } = registry();
    const hub = new SubscriptionHub({ registry: reg, log: log(), ...options });
    hubs.push(hub);
    return { hub, sinks, closed };
  }

  it("counts unwritten messages and drops a consumer that lets too many pile up, terminating it after the grace", async () => {
    fakeTimers();
    const { hub, sinks } = makeHub({ maxBufferedMessages: 3 });
    const socket = new FakeSocket(false);
    const connection = hub.add(socket, tenant);
    expect(connection.pending).toBe(1); // the welcome
    socket.emit(
      "message",
      JSON.stringify({ kind: "udc.subscribe", id: "s", payload: { collection: "live" } }),
    );
    await settle();
    expect(connection.pending).toBe(2); // + subscribe.ok
    const sink = sinks[0] as RowSink;
    sink.upsert({ __meta: { id: "r1", version: 1 } }, "created");
    expect(connection.pending).toBe(3);
    expect(socket.closedWith).toBeNull();
    sink.upsert({ __meta: { id: "r2", version: 1 } }, "created");
    expect(socket.closedWith).toEqual({ code: 4008, reason: "slow consumer" });
    expect(socket.sent).toHaveLength(3); // the fourth was not queued
    expect(connection.closed).toBe(true);
    expect(socket.terminated).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(socket.terminated).toBe(true);
    expect(hub.size()).toBe(0);
    // Writes that complete later bring the count down; a failed one is only logged.
    socket.flush(new Error("EPIPE"));
    expect(connection.pending).toBe(0);
    expect(connection.send({ kind: "udc.pong", id: "x", payload: {} })).toBe(false);
  });

  it("pings on the heartbeat and terminates a client that did not answer the previous one", () => {
    fakeTimers();
    const { hub } = makeHub({ heartbeatIntervalMs: 1000 });
    const quiet = new FakeSocket(true);
    const chatty = new FakeSocket(true);
    hub.add(quiet, tenant);
    hub.add(chatty, tenant);
    vi.advanceTimersByTime(1000);
    expect(quiet.pings).toBe(1);
    expect(chatty.pings).toBe(1);
    chatty.emit("pong");
    vi.advanceTimersByTime(1000);
    expect(quiet.terminated).toBe(true);
    expect(chatty.terminated).toBe(false);
    expect(chatty.pings).toBe(2);
    // Any message counts as life too.
    chatty.emit("message", JSON.stringify({ kind: "udc.ping", id: "p" }));
    vi.advanceTimersByTime(1000);
    expect(chatty.terminated).toBe(false);
    expect(hub.size()).toBe(1);
  });

  it("opens and closes subscriptions, refusing a source that throws, a non-subscribable one and a closed connection", async () => {
    const { hub, sinks, closed } = makeHub();
    const socket = new FakeSocket(true);
    const connection = hub.add(socket, tenant);
    const send = (message: unknown) => socket.emit("message", JSON.stringify(message));
    send({ kind: "udc.subscribe", id: "a", payload: { collection: "live" } });
    send({ kind: "udc.subscribe", id: "b", payload: { collection: "static" } });
    send({ kind: "udc.subscribe", id: "c", payload: { collection: "exploding" } });
    await settle();
    expect(connection.open).toEqual(["a"]);
    expect(socket.messages().slice(1)).toEqual([
      { kind: "udc.subscribe.ok", id: "a", payload: { collection: "live" } },
      {
        kind: "udc.subscribe.err",
        id: "b",
        payload: { code: "unsupported_op", message: 'collection "static" cannot be subscribed' },
      },
      {
        kind: "udc.subscribe.err",
        id: "c",
        payload: { code: "internal", message: "subscribe failed" },
      },
    ]);
    expect(sinks).toHaveLength(1);
    send({ kind: "udc.unsubscribe", id: "a" });
    await settle();
    expect(closed).toEqual([0]);
    expect(connection.open).toEqual([]);
    expect(socket.messages().at(-1)).toEqual({ kind: "udc.unsubscribe.ok", id: "a", payload: {} });

    // A subscription that completes after the socket closed is closed again at once.
    send({ kind: "udc.subscribe", id: "late", payload: { collection: "live" } });
    await tick(); // the source is now subscribing
    socket.close(1000, "bye");
    await settle();
    expect(sinks).toHaveLength(2);
    expect(closed).toEqual([0, 1]);
    expect(connection.open).toEqual([]);
    expect(hub.size()).toBe(0);
    // Messages after the close are ignored.
    send({ kind: "udc.ping", id: "p" });
    await settle();
    expect(socket.messages().filter((m) => m.kind === "udc.pong")).toEqual([]);
  });

  it("closes every subscription with the connection and every connection with 1001 on close", async () => {
    const { hub, closed } = makeHub();
    const socket = new FakeSocket(true);
    hub.add(socket, tenant);
    for (let i = 0; i < 3; i++) {
      socket.emit(
        "message",
        JSON.stringify({ kind: "udc.subscribe", id: `s${i}`, payload: { collection: "live" } }),
      );
    }
    await settle();
    expect(hub.size()).toBe(1);
    hub.close();
    expect(socket.closedWith).toEqual({ code: 1001, reason: "server shutting down" });
    await settle();
    expect(closed.sort()).toEqual([0, 1, 2]);
    expect(hub.size()).toBe(0);
    hub.remove(new SubscriptionConnection(new FakeSocket(true), tenant, hub, log())); // unknown: no-op
  });

  it("uses the configured limits in the welcome", () => {
    const { hub } = makeHub();
    const socket = new FakeSocket(true);
    hub.add(socket, tenant);
    expect(socket.messages()[0]).toEqual({
      kind: "udc.welcome",
      id: "",
      payload: {
        protocol_version: "1",
        tenant: "acme",
        heartbeat_interval_ms: 30_000,
        max_buffered_messages: 1000,
        max_subscriptions: MAX_SUBSCRIPTIONS_PER_CONNECTION,
      },
    });
  });
});

describe("helpers", () => {
  it("isSubscribable needs the capability and the method", () => {
    const { reg } = registry();
    expect(isSubscribable(reg.get("live").source)).toBe(true);
    expect(isSubscribable(reg.get("static").source)).toBe(false);
    expect(
      isSubscribable({
        ...reg.get("static").source,
        capabilities: { ...reg.get("static").source.capabilities, subscribe: true },
      } as never),
    ).toBe(false);
  });

  it("selectSubprotocol prefers vola.v1, then a bearer, else none", () => {
    expect(selectSubprotocol(new Set(["bearer.k", "vola.v1"]))).toBe("vola.v1");
    expect(selectSubprotocol(new Set(["other", "bearer.k"]))).toBe("bearer.k");
    expect(selectSubprotocol(new Set(["other"]))).toBe(false);
    expect(selectSubprotocol(new Set())).toBe(false);
  });
});
