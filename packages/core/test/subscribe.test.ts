import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  FILE_EVENT_KINDS,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  ServerMessageSchema,
  SUBSCRIBE_CLOSE_CODES,
  SUBSCRIBE_PATH,
  SubscribePayloadSchema,
} from "../src/index.js";

describe("subscribe protocol", () => {
  it("names the route, the close codes and the event kinds", () => {
    expect(SUBSCRIBE_PATH).toBe("/udc/subscribe");
    expect(SUBSCRIBE_CLOSE_CODES).toEqual({
      going_away: 1001,
      feed_unavailable: 1011,
      slow_consumer: 4008,
    });
    expect(FILE_EVENT_KINDS).toContain("processing");
    expect(MAX_SUBSCRIPTIONS_PER_CONNECTION).toBe(32);
  });

  it("validates client messages", () => {
    expect(ClientMessageSchema.safeParse({ kind: "udc.ping", id: "p" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ kind: "udc.list", id: "p" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ kind: "udc.subscribe", id: "" }).success).toBe(false);
    expect(SubscribePayloadSchema.safeParse({ collection: "files" }).success).toBe(true);
    expect(SubscribePayloadSchema.safeParse({}).success).toBe(false);
  });

  it("validates server messages", () => {
    const row = { __meta: { id: "f", version: 1 }, filename: "a.txt" };
    for (const message of [
      {
        kind: "udc.welcome",
        id: "",
        payload: {
          protocol_version: "1",
          tenant: "acme",
          heartbeat_interval_ms: 30000,
          max_buffered_messages: 1000,
          max_subscriptions: 32,
        },
      },
      { kind: "udc.subscribe.ok", id: "s", payload: { collection: "files" } },
      { kind: "udc.subscribe.err", id: "s", payload: { code: "not_found", message: "x" } },
      { kind: "udc.unsubscribe.ok", id: "s", payload: {} },
      { kind: "udc.row.upsert", id: "s", payload: { collection: "files", row, event: "created" } },
      {
        kind: "udc.row.remove",
        id: "s",
        payload: { collection: "files", id: "f", event: "deleted" },
      },
      { kind: "udc.pong", id: "p", payload: {} },
      { kind: "udc.error", id: "", payload: { code: "validation_error", message: "x" } },
    ]) {
      expect(ServerMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
    expect(
      ServerMessageSchema.safeParse({
        kind: "udc.row.upsert",
        id: "s",
        payload: { collection: "files", row: {}, event: "created" },
      }).success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        kind: "udc.row.remove",
        id: "s",
        payload: { collection: "files", id: "f", event: "nope" },
      }).success,
    ).toBe(false);
  });
});
