import { z } from "zod";

/**
 * The real-time face of the UDC collections: `GET <prefix>/udc/subscribe` upgraded to a
 * WebSocket. A client subscribes to a collection with a UDC filter and receives, as rows
 * change, the row to put in place (`udc.row.upsert`) or the id to take out
 * (`udc.row.remove`) — the same rows `list` would answer, so a data view applies them
 * without reloading. Everything on the wire is a JSON text frame in the UDC envelope
 * shape `{kind, id, payload}`.
 */
export const SUBSCRIBE_PATH = "/udc/subscribe";
export const SUBSCRIBE_PROTOCOL_VERSION = "1";

/** What changed, as the publisher saw it (`src/events/bus.ts` of `@vola/server`). */
export const FILE_EVENT_KINDS = [
  "created",
  "updated",
  "deleted",
  "restored",
  "purged",
  "processing",
] as const;
export type FileEventKind = (typeof FILE_EVENT_KINDS)[number];
export const FileEventKindSchema = z.enum(FILE_EVENT_KINDS);

/** Close codes the server uses; a client reconnects (with backoff) after any of them. */
export const SUBSCRIBE_CLOSE_CODES = {
  /** The server is shutting down. */
  going_away: 1001,
  /** The server could not subscribe to the event feed (Redis down). */
  feed_unavailable: 1011,
  /** The client read too slowly: its outbound buffer filled up. */
  slow_consumer: 4008,
} as const;

/** Subscriptions one connection may hold at once; the next `udc.subscribe` is refused. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;

// --- client → server ---------------------------------------------------------------------

export const CLIENT_MESSAGE_KINDS = ["udc.subscribe", "udc.unsubscribe", "udc.ping"] as const;
export type ClientMessageKind = (typeof CLIENT_MESSAGE_KINDS)[number];

/** `udc.subscribe` payload: the collection and the filter `list` would be called with. */
export const SubscribePayloadSchema = z.object({
  collection: z.string().min(1),
  /** A UDC `FilterNode`; validated by the collection's source. */
  filter: z.unknown().optional(),
});
export type SubscribePayload = z.infer<typeof SubscribePayloadSchema>;

/** The envelope every client message must fit; `id` names the subscription it concerns. */
export const ClientMessageSchema = z.object({
  kind: z.enum(CLIENT_MESSAGE_KINDS),
  id: z.string().min(1).max(128),
  payload: z.unknown().optional(),
});
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// --- server → client ---------------------------------------------------------------------

const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** The first message of a connection: from now on `udc.subscribe` is answered. */
export const WelcomeMessageSchema = z.object({
  kind: z.literal("udc.welcome"),
  id: z.literal(""),
  payload: z.object({
    protocol_version: z.string(),
    tenant: z.string(),
    heartbeat_interval_ms: z.number().int().positive(),
    max_buffered_messages: z.number().int().positive(),
    max_subscriptions: z.number().int().positive(),
  }),
});

export const SubscribeOkMessageSchema = z.object({
  kind: z.literal("udc.subscribe.ok"),
  id: z.string(),
  payload: z.object({ collection: z.string(), filter: z.unknown().optional() }),
});

export const SubscribeErrMessageSchema = z.object({
  kind: z.literal("udc.subscribe.err"),
  id: z.string(),
  payload: ErrorPayloadSchema,
});

export const UnsubscribeOkMessageSchema = z.object({
  kind: z.literal("udc.unsubscribe.ok"),
  id: z.string(),
  payload: z.object({}),
});

/** A row that now matches the subscription (new or changed): put it in place by `__meta.id`. */
export const RowUpsertMessageSchema = z.object({
  kind: z.literal("udc.row.upsert"),
  /** The subscription's id. */
  id: z.string(),
  payload: z.object({
    collection: z.string(),
    row: z.object({ __meta: z.object({ id: z.string(), version: z.number() }) }).loose(),
    event: FileEventKindSchema,
  }),
});

/** A row that no longer matches (deleted, purged, moved out of the filter): take it out. */
export const RowRemoveMessageSchema = z.object({
  kind: z.literal("udc.row.remove"),
  id: z.string(),
  payload: z.object({ collection: z.string(), id: z.string(), event: FileEventKindSchema }),
});

export const PongMessageSchema = z.object({
  kind: z.literal("udc.pong"),
  id: z.string(),
  payload: z.object({}),
});

/** A client message the server could not act on; the connection stays open. */
export const ErrorMessageSchema = z.object({
  kind: z.literal("udc.error"),
  id: z.string(),
  payload: ErrorPayloadSchema,
});

export const ServerMessageSchema = z.discriminatedUnion("kind", [
  WelcomeMessageSchema,
  SubscribeOkMessageSchema,
  SubscribeErrMessageSchema,
  UnsubscribeOkMessageSchema,
  RowUpsertMessageSchema,
  RowRemoveMessageSchema,
  PongMessageSchema,
  ErrorMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type RowUpsertMessage = z.infer<typeof RowUpsertMessageSchema>;
export type RowRemoveMessage = z.infer<typeof RowRemoveMessageSchema>;
