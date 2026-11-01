import type { FilterNode, Row } from "@jsudc/core";
import { patchRowInList, udcKeys } from "@jsudc/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  bearerSubprotocols,
  type FileEventKind,
  SUBSCRIBE_PATH,
  VOLA_SUBPROTOCOL,
} from "@vola/core";
import { useEffect, useRef, useState } from "react";
import { useVolaContext } from "./context.js";

export type LiveStatus = "off" | "connecting" | "live" | "offline";

export interface LiveEvent {
  kind: "upsert" | "remove";
  event: FileEventKind;
  id: string;
  row: Row | null;
}

export interface UseFilesLiveOptions {
  /** The filter of the subscription: must pin `instance_type` (and usually `instance_id`, `folder_path`). */
  filter: FilterNode;
  /** `false`: no socket. Default `true`. */
  enabled?: boolean | undefined;
  /** Called with every row change, after the query cache was updated. */
  onEvent?: ((event: LiveEvent) => void) | undefined;
  /** Reconnect delays: start, cap. Default 500 ms → 15 s. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number } | undefined;
}

/** The WebSocket URL of `/udc/subscribe` for an API base URL. */
export function subscribeUrl(baseUrl: string): string {
  const url = new URL(
    `${baseUrl}${SUBSCRIBE_PATH}`,
    typeof location !== "undefined" ? location.href : "http://localhost",
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Keeps the `files` lists of the TanStack cache current through `GET /udc/subscribe`
 * (`docs/REALTIME.md`): an `udc.row.upsert` of a row a cached page holds is patched in place
 * (a rename, a move, a new `processing_status`), anything else — a new row, a removal — makes
 * the lists refetch. Reconnects with backoff and refetches once on every reconnect (what
 * happened meanwhile is not replayed).
 */
export function useFilesLive(options: UseFilesLiveOptions): LiveStatus {
  const { client, WebSocket: WS } = useVolaContext();
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const [status, setStatus] = useState<LiveStatus>(enabled ? "connecting" : "off");
  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;
  const filterKey = JSON.stringify(options.filter);
  const initialDelay = options.reconnect?.initialDelayMs ?? 500;
  const maxDelay = options.reconnect?.maxDelayMs ?? 15_000;

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    const filter = JSON.parse(filterKey) as FilterNode;
    const Socket = WS ?? globalThis.WebSocket;
    if (!Socket) {
      setStatus("off");
      return;
    }
    let socket: WebSocket | null = null;
    let closed = false;
    let delay = initialDelay;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let everOpen = false;
    const lists = { queryKey: udcKeys.lists("files") };

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      const apiKey = client.options.apiKey;
      socket = new Socket(
        subscribeUrl(client.baseUrl),
        apiKey ? bearerSubprotocols(apiKey) : [VOLA_SUBPROTOCOL],
      );
      socket.onopen = () => {
        delay = initialDelay;
      };
      socket.onmessage = (message: MessageEvent) => {
        let data: { kind?: string; id?: string; payload?: Record<string, unknown> };
        try {
          data = JSON.parse(String(message.data)) as typeof data;
        } catch {
          return;
        }
        switch (data.kind) {
          case "udc.welcome":
            socket?.send(
              JSON.stringify({
                kind: "udc.subscribe",
                id: "files",
                payload: { collection: "files", filter },
              }),
            );
            break;
          case "udc.subscribe.ok":
            setStatus("live");
            if (everOpen) void queryClient.invalidateQueries(lists);
            everOpen = true;
            break;
          case "udc.subscribe.err":
            setStatus("offline");
            break;
          case "udc.row.upsert": {
            const row = data.payload?.row as Row | undefined;
            const event = data.payload?.event as FileEventKind;
            if (!row) break;
            let patched = false;
            queryClient.setQueriesData(lists, (cached: unknown) => {
              const next = patchRowInList(
                cached as Parameters<typeof patchRowInList>[0],
                row.__meta.id,
                () => {
                  patched = true;
                  return row;
                },
              );
              return next;
            });
            if (!patched) void queryClient.invalidateQueries(lists);
            onEvent.current?.({ kind: "upsert", event, id: row.__meta.id, row });
            break;
          }
          case "udc.row.remove": {
            const id = String(data.payload?.id ?? "");
            const event = data.payload?.event as FileEventKind;
            void queryClient.invalidateQueries(lists);
            onEvent.current?.({ kind: "remove", event, id, row: null });
            break;
          }
          default:
            break;
        }
      };
      socket.onclose = () => {
        socket = null;
        if (closed) return;
        setStatus("offline");
        timer = setTimeout(connect, delay);
        delay = Math.min(maxDelay, delay * 2);
      };
      socket.onerror = () => {
        // `onclose` follows and reconnects.
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (socket) {
        try {
          socket.send(JSON.stringify({ kind: "udc.unsubscribe", id: "files" }));
        } catch {
          // closing anyway
        }
        socket.close();
      }
    };
  }, [enabled, filterKey, client, WS, queryClient, initialDelay, maxDelay]);

  return status;
}
