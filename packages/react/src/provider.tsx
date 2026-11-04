import {
  createUdcQueryClient,
  type Messages,
  mergeMessages,
  type RendererRegistry,
  UdcI18nProvider,
  UdcProvider,
} from "@jsudc/react";
import { Toaster, TooltipProvider } from "@jsudc/react/ui";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VolaClient, type VolaClientOptions } from "@vol-a/client";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BlobCache } from "./blobs.js";
import {
  useVolaContext,
  VolaContext,
  type VolaContextValue,
  type WebSocketConstructor,
} from "./context.js";
import { VOLA_MESSAGES } from "./i18n.js";
import { KeyringStore } from "./keyring.js";
import { ACTIVITY_EVENTS, DEFAULT_LOCK_POLICY, decideLock } from "./lockPolicy.js";
import { VOLA_RENDERERS } from "./VolaFilesTable.js";

/** Bytes from which an upload is resumable (tus) rather than one multipart `POST`: 8 MiB. */
export const VOLA_RESUMABLE_THRESHOLD = 8 * 1024 * 1024;

export interface VolaProviderProps extends Partial<VolaClientOptions> {
  /** The client every component uses. Alternatively `baseUrl` (+ `apiKey`, `userId`, …) builds one. */
  client?: VolaClient | undefined;
  /** `en` or `sr`. Leave it out and `@jsudc/react` keeps the locale (localStorage `udc-locale`). */
  locale?: string | undefined;
  /** Strings layered over the package's: `{ VOLA: { UPLOAD: { en, sr } } }`, or your own sections. */
  messages?: Messages | undefined;
  /** Auto-lock after this much inactivity, plus a 10 s countdown. Default 120 s; `0` turns the auto-lock off. */
  lockAfterMs?: number | undefined;
  /** The countdown before the auto-lock. Default 10 s. */
  lockCountdownMs?: number | undefined;
  /** Lock when the tab was hidden (or the window unfocused) this long. Default 30 s; `null`: never for that reason. */
  awayMs?: number | null | undefined;
  /** Bytes from which `useVolaUpload` goes resumable. Default `VOLA_RESUMABLE_THRESHOLD`. */
  resumableThreshold?: number | undefined;
  /** The `@jsudc/react` renderers the file browser's data view draws with. Default: the package's table. */
  renderers?: RendererRegistry | undefined;
  /** A TanStack `QueryClient` of your own (one app, one client). Default: `createUdcQueryClient()`. */
  queryClient?: QueryClient | undefined;
  /** The WebSocket class of the live subscription (tests, polyfills). Default: the global one. */
  WebSocket?: WebSocketConstructor | undefined;
  children?: ReactNode;
}

/**
 * The root of every `@vol-a/react` component: the `VolaClient`, i18n (`en`, `sr`), the UDC
 * provider the file browser draws with, the keyring store and its auto-lock, and the
 * in-memory cache of decrypted `blob:` URLs.
 */
export function VolaProvider(props: VolaProviderProps) {
  const {
    client: given,
    baseUrl,
    apiKey,
    fetch: fetchImpl,
    userId,
    tenantSlug,
    validate,
    headers,
    locale,
    messages,
    lockAfterMs = DEFAULT_LOCK_POLICY.idleMs,
    lockCountdownMs = DEFAULT_LOCK_POLICY.countdownMs,
    awayMs = 30_000,
    resumableThreshold = VOLA_RESUMABLE_THRESHOLD,
    renderers = VOLA_RENDERERS,
    queryClient: givenQueryClient,
    WebSocket: ws,
    children,
  } = props;

  const client = useMemo(() => {
    if (given) return given;
    if (!baseUrl) throw new Error("<VolaProvider> needs a client or a baseUrl");
    return new VolaClient({
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(userId ? { userId } : {}),
      ...(tenantSlug ? { tenantSlug } : {}),
      ...(validate !== undefined ? { validate } : {}),
      ...(headers ? { headers } : {}),
    });
  }, [given, baseUrl, apiKey, fetchImpl, userId, tenantSlug, validate, headers]);

  const [queryClient] = useState(() => givenQueryClient ?? createUdcQueryClient());
  const blobs = useMemo(() => new BlobCache(), []);
  // One store per client: a new client is a new principal, so a new keyring.
  const keyring = useMemo(() => new KeyringStore(client, blobs), [client, blobs]);
  const allMessages = useMemo(() => mergeMessages(VOLA_MESSAGES, messages), [messages]);

  const value = useMemo<VolaContextValue>(
    () => ({ client, locale, keyring, blobs, resumableThreshold, WebSocket: ws }),
    [client, locale, keyring, blobs, resumableThreshold, ws],
  );

  return (
    <VolaContext.Provider value={value}>
      <UdcProvider client={client.udc} renderers={renderers}>
        <QueryClientProvider client={givenQueryClient ?? queryClient}>
          <UdcI18nProvider {...(locale ? { locale } : {})} messages={allMessages}>
            <TooltipProvider delayDuration={400}>
              <Toaster>
                <AutoLock idleMs={lockAfterMs} countdownMs={lockCountdownMs} awayMs={awayMs} />
                {children}
              </Toaster>
            </TooltipProvider>
          </UdcI18nProvider>
        </QueryClientProvider>
      </UdcProvider>
    </VolaContext.Provider>
  );
}

/**
 * The auto-lock (`docs/notes-crypto-for-vola.md` § 3): `idleMs` without activity → a
 * `countdownMs` countdown → `lock()`; activity during the countdown goes back to live; a tab
 * that slept past the countdown locks at once; a tab hidden for `awayMs` locks when it comes
 * back; `pagehide` sends the beacon that ends the token and forgets every `blob:` URL.
 */
function AutoLock({
  idleMs,
  countdownMs,
  awayMs,
}: {
  idleMs: number;
  countdownMs: number;
  awayMs: number | null;
}) {
  const { client, keyring } = useVolaContext();
  const unlocked = useSyncExternalStore(
    keyring.subscribe,
    () => keyring.getSnapshot().unlocked,
    () => keyring.getSnapshot().unlocked,
  );

  useEffect(() => {
    if (!unlocked) return;
    const offBeacon = client.lockOnUnload();
    const onPageHide = () => keyring.markLocked();
    window.addEventListener("pagehide", onPageHide);
    if (idleMs <= 0) {
      return () => {
        offBeacon();
        window.removeEventListener("pagehide", onPageHide);
      };
    }
    const policy = { idleMs, countdownMs };
    keyring.touch();
    const activity = () => keyring.touch();
    for (const event of ACTIVITY_EVENTS)
      window.addEventListener(event, activity, { passive: true });
    const tick = () => {
      const decision = decideLock(Date.now() - keyring.lastActivityAt, policy);
      if (decision.phase === "locked") void keyring.lock();
      else keyring.setLockPhase(decision.phase, decision.remainingMs);
    };
    const interval = setInterval(tick, 1000);
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && awayMs !== null && Date.now() - hiddenAt >= awayMs) {
        void keyring.lock();
      } else {
        keyring.touch();
      }
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      offBeacon();
    };
  }, [unlocked, idleMs, countdownMs, awayMs, client, keyring]);

  return null;
}
