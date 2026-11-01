import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFileEventBus,
  type FileEvent,
  fileEventsChannel,
  LocalFileEventBus,
  parseEvent,
  publishFileEvent,
  publishFileEvents,
  publishProcessingStatus,
  RedisFileEventBus,
} from "../src/events/bus.js";
import { config } from "./helpers.js";

const event = (over: Partial<FileEvent> = {}): FileEvent => ({
  tenantId: "t1",
  instanceType: "tickets",
  instanceId: "i1",
  folderId: null,
  fileId: "f1",
  kind: "created",
  ...over,
});

describe("LocalFileEventBus", () => {
  it("delivers to the listeners of the event's tenant only, and survives a throwing listener", async () => {
    const bus = new LocalFileEventBus();
    const t1: FileEvent[] = [];
    const t2: FileEvent[] = [];
    const off = await bus.subscribe("t1", () => {
      throw new Error("boom");
    });
    await bus.subscribe("t1", (e) => t1.push(e));
    await bus.subscribe("t2", (e) => t2.push(e));
    expect(bus.subscribed()).toEqual(["t1", "t2"]);
    await bus.publish(event());
    await bus.publish(event({ tenantId: "t2", fileId: "f2" }));
    expect(t1.map((e) => e.fileId)).toEqual(["f1"]);
    expect(t2.map((e) => e.fileId)).toEqual(["f2"]);
    expect(bus.published).toHaveLength(2);
    await off();
    await off(); // idempotent
    expect(bus.subscribed()).toEqual(["t1", "t2"]);
    await bus.close();
    expect(bus.subscribed()).toEqual([]);
  });
});

describe("parseEvent", () => {
  it("accepts a well-formed event and refuses anything else", () => {
    expect(parseEvent(JSON.stringify(event({ folderId: "d1" })))).toEqual(
      event({ folderId: "d1" }),
    );
    for (const bad of [
      "null",
      "1",
      "{}",
      JSON.stringify({ ...event(), kind: "exploded" }),
      JSON.stringify({ ...event(), folderId: 1 }),
      JSON.stringify({ ...event(), fileId: null }),
    ]) {
      expect(() => parseEvent(bad), bad).toThrow(TypeError);
    }
    expect(() => parseEvent("not json")).toThrow();
  });
});

describe("publishFileEvent", () => {
  it("does nothing without a bus and logs, never throws, when publishing fails", async () => {
    await publishFileEvent({}, event());
    const warn = vi.fn();
    const failing = {
      publish: async () => {
        throw new Error("redis down");
      },
      subscribe: async () => async () => {},
      close: async () => {},
    };
    const deps = { events: failing, logger: { warn } as never };
    await publishFileEvent(deps, event());
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: "f1", kind: "created" }),
      "file event not published",
    );
    const bus = new LocalFileEventBus();
    await publishFileEvents({ events: bus }, { ...event(), kind: "purged" }, [
      { id: "a", folderId: null },
      { id: "b", folderId: "d" },
    ]);
    await publishProcessingStatus({ events: bus }, { ...event(), fileId: "p" });
    expect(bus.published).toEqual([
      event({ fileId: "a", kind: "purged" }),
      event({ fileId: "b", folderId: "d", kind: "purged" }),
      event({ fileId: "p", kind: "processing" }),
    ]);
  });

  it("createFileEventBus picks Redis with a URL and in-process without", async () => {
    expect(createFileEventBus(null)).toBeInstanceOf(LocalFileEventBus);
    expect(createFileEventBus(undefined)).toBeInstanceOf(LocalFileEventBus);
    const redis = createFileEventBus("redis://127.0.0.1:1");
    expect(redis).toBeInstanceOf(RedisFileEventBus);
    await redis.close();
  });
});

/** A pair of fake ioredis clients: `publish` feeds `subscriber`'s `message` for subscribed channels. */
class FakeRedis extends EventEmitter {
  readonly channels = new Set<string>();
  readonly calls: string[] = [];
  failSubscribe = false;
  peer: FakeRedis | null = null;

  async publish(channel: string, raw: string): Promise<number> {
    this.calls.push(`publish ${channel}`);
    const target = this.peer ?? this;
    if (target.channels.has(channel)) target.emit("message", channel, raw);
    return 1;
  }
  async subscribe(channel: string): Promise<void> {
    this.calls.push(`subscribe ${channel}`);
    if (this.failSubscribe) throw new Error("subscribe failed");
    this.channels.add(channel);
  }
  async unsubscribe(channel: string): Promise<void> {
    this.calls.push(`unsubscribe ${channel}`);
    this.channels.delete(channel);
  }
  async quit(): Promise<void> {
    this.calls.push("quit");
  }
  disconnect(): void {
    this.calls.push("disconnect");
  }
}

describe("RedisFileEventBus (fake clients)", () => {
  function makeBus(options: { prefix?: string } = {}) {
    const publisher = new FakeRedis();
    const subscriber = new FakeRedis();
    publisher.peer = subscriber;
    const errors: unknown[] = [];
    const bus = new RedisFileEventBus("redis://unused", {
      prefix: options.prefix,
      onError: (error, channel) => errors.push({ error, channel }),
      clients: { publisher: publisher as never, subscriber: subscriber as never },
    });
    return { bus, publisher, subscriber, errors };
  }

  it("subscribes a tenant's channel once, delivers its events, and unsubscribes with the last listener", async () => {
    const { bus, publisher, subscriber } = makeBus();
    const got: string[] = [];
    const offA = await bus.subscribe("t1", (e) => got.push(`a:${e.fileId}`));
    const offB = await bus.subscribe("t1", (e) => got.push(`b:${e.fileId}`));
    expect(subscriber.calls).toEqual(["subscribe vola:files:t1"]);
    expect(bus.channel("t1")).toBe(fileEventsChannel("t1"));
    await bus.publish(event());
    await bus.publish(event({ tenantId: "t2", fileId: "other" })); // no listener: dropped by Redis
    expect(publisher.calls).toEqual(["publish vola:files:t1", "publish vola:files:t2"]);
    expect(got).toEqual(["a:f1", "b:f1"]);
    await offA();
    expect(subscriber.calls).toHaveLength(1);
    await offB();
    expect(subscriber.calls).toEqual(["subscribe vola:files:t1", "unsubscribe vola:files:t1"]);
    expect(bus.subscribed()).toEqual([]);
    await bus.close();
    expect(publisher.calls.at(-1)).toBe("quit");
    expect(subscriber.calls.at(-1)).toBe("quit");
  });

  it("drops a message that is not an event, one on a foreign channel, and one whose tenant does not match its channel", async () => {
    const { bus, subscriber, errors } = makeBus({ prefix: "custom" });
    const got: FileEvent[] = [];
    await bus.subscribe("t1", (e) => got.push(e));
    expect(subscriber.channels).toEqual(new Set(["custom:t1"]));
    subscriber.emit("message", "custom:t1", "garbage");
    subscriber.emit("message", "elsewhere:t1", JSON.stringify(event()));
    subscriber.emit("message", "custom:t1", JSON.stringify(event({ tenantId: "t2" })));
    subscriber.emit("message", "custom:t1", JSON.stringify(event()));
    expect(got).toEqual([event()]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { channel: string }).channel).toBe("custom:t1");
    // A throwing listener is reported, not fatal.
    await bus.subscribe("t1", () => {
      throw new Error("listener");
    });
    subscriber.emit("message", "custom:t1", JSON.stringify(event()));
    expect(errors).toHaveLength(2);
    expect(got).toHaveLength(2);
    // Connection errors reach onError too (and do not crash the process).
    subscriber.emit("error", new Error("socket"));
    expect(errors).toHaveLength(3);
    await bus.close();
  });

  it("re-throws a failed channel subscription and forgets the listener", async () => {
    const { bus, subscriber } = makeBus();
    subscriber.failSubscribe = true;
    await expect(bus.subscribe("t1", () => {})).rejects.toThrow("subscribe failed");
    expect(bus.subscribed()).toEqual([]);
    subscriber.failSubscribe = false;
    await bus.subscribe("t1", () => {});
    expect(bus.subscribed()).toEqual(["t1"]);
    await bus.close();
  });

  it("falls back to disconnect() when quit() fails", async () => {
    const { bus, publisher, subscriber } = makeBus();
    publisher.quit = async () => {
      throw new Error("no");
    };
    await bus.close();
    expect(publisher.calls).toContain("disconnect");
    expect(subscriber.calls).toContain("quit");
  });
});

describe("RedisFileEventBus (real Redis)", () => {
  const url = config.redisUrl;
  const buses: RedisFileEventBus[] = [];
  beforeAll(() => {
    expect(url, "VOLA_REDIS_URL is needed for this test").toBeTruthy();
  });
  afterAll(async () => {
    await Promise.all(buses.map((b) => b.close()));
  });

  it("carries an event from one bus to another", async () => {
    const a = new RedisFileEventBus(url as string, { prefix: `vola-test:${process.pid}` });
    const b = new RedisFileEventBus(url as string, { prefix: `vola-test:${process.pid}` });
    buses.push(a, b);
    const got = new Promise<FileEvent>((resolve) => {
      void b.subscribe("t1", resolve);
    });
    // Subscribe completes before publishing (b's listener registers synchronously above).
    await new Promise((resolve) => setTimeout(resolve, 50));
    await a.publish(event({ fileId: "across" }));
    expect(await got).toEqual(event({ fileId: "across" }));
  });
});
