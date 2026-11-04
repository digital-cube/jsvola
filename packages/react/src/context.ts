import type { VolaClient } from "@vol-a/client";
import { createContext, useContext } from "react";
import type { BlobCache } from "./blobs.js";
import type { KeyringStore } from "./keyring.js";

/** A `WebSocket` constructor (the global one, or a fake in tests). */
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

/** What every `@vol-a/react` component finds in the nearest `VolaProvider`. */
export interface VolaContextValue {
  client: VolaClient;
  /** The locale the provider was given (`en`, `sr`), or `undefined` when `@jsudc/react` keeps it. */
  locale: string | undefined;
  keyring: KeyringStore;
  blobs: BlobCache;
  /** Bytes from which `useVolaUpload` goes resumable. */
  resumableThreshold: number;
  /** The WebSocket class the live subscription opens; `undefined`: the global one. */
  WebSocket: WebSocketConstructor | undefined;
}

export const VolaContext = createContext<VolaContextValue | null>(null);

/** The nearest `VolaProvider`'s client, keyring store, blob cache and settings. Throws outside one. */
export function useVolaContext(): VolaContextValue {
  const value = useContext(VolaContext);
  if (!value) throw new Error("vola components must be rendered inside <VolaProvider>");
  return value;
}

/** The `VolaClient` of the nearest `VolaProvider`. Throws outside one. */
export function useVola(): VolaClient {
  return useVolaContext().client;
}
