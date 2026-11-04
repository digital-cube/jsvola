import { VolaError } from "@vol-a/client";
import type { ThumbnailCrop, ThumbnailSize } from "@vol-a/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useVolaContext } from "./context.js";
import { useVolaT } from "./i18n.js";

/** What `VolaThumb` needs of a file: a `FileInfo`, or a `files` UDC row. */
export interface ThumbFile {
  id: string;
  instance_type: string;
  instance_id: string;
  filename?: string | null | undefined;
  encryption?: string | null | undefined;
  kind?: string | null | undefined;
  /** When it changes (the live row says `DONE`), the thumbnail is asked for again. */
  processing_status?: string | null | undefined;
}

export type ThumbState =
  | "loading"
  | "ready"
  | "generating"
  | "failed"
  | "none"
  | "locked"
  | "error";

export interface VolaThumbProps {
  file: ThumbFile;
  /** The edge in pixels: 64, 128 (default), 256 or 512. */
  size?: ThumbnailSize | undefined;
  crop?: ThumbnailCrop | undefined;
  alt?: string | undefined;
  className?: string | undefined;
  /** Retries while the worker renders (`202`): 1, 2, 4, … seconds, at most this many. Default 6. */
  maxRetries?: number | undefined;
  /** The first retry delay, in ms. Default 1000. */
  retryBaseMs?: number | undefined;
  /** Called with every state change (tests, a parent that counts). */
  onState?: ((state: ThumbState) => void) | undefined;
}

/** The delay before retry `attempt` (0-based): `base · 2^attempt`, at most 30 s. */
export function thumbRetryDelay(attempt: number, base = 1000): number {
  return Math.min(30_000, base * 2 ** attempt);
}

const thumbKey = (file: ThumbFile, size: number, crop: ThumbnailCrop | undefined) =>
  `${file.instance_type}/${file.instance_id}/${file.id}/${size}/${crop ?? "cover"}`;

/**
 * A file's thumbnail, fetched with the client's credentials (the API key is a header, so a
 * bare `<img src>` could not carry it) into a `blob:` URL held in the provider's in-memory
 * cache. A `202` is NOT the image: it is a placeholder while the worker renders, never
 * cached, retried with backoff. An encrypted file's thumbnail is decrypted per request under
 * the unlock; a lock revokes the URL and the generation counter drops an answer that arrives
 * after it. `404 no_thumbnail` (a type without a preview) and `failed` show a placeholder.
 */
export function VolaThumb({
  file,
  size = 128,
  crop,
  alt,
  className,
  maxRetries = 6,
  retryBaseMs = 1000,
  onState,
}: VolaThumbProps) {
  const { client, blobs, keyring } = useVolaContext();
  const { t } = useVolaT();
  const key = thumbKey(file, size, crop);
  // Re-render on every cache change: a lock empties it, so a ready image goes back to a placeholder.
  const gen = useSyncExternalStore(
    blobs.subscribe,
    () => blobs.gen,
    () => blobs.gen,
  );
  // … and on an unlock, so a "locked" placeholder asks again with the token.
  const unlocked = useSyncExternalStore(
    keyring.subscribe,
    () => keyring.getSnapshot().unlocked,
    () => keyring.getSnapshot().unlocked,
  );
  const cached = blobs.get(key);
  const [state, setState] = useState<ThumbState>(cached ? "ready" : "loading");
  const [url, setUrl] = useState<string | null>(cached ?? null);

  const processing = file.processing_status ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `processing`, `gen` and `unlocked` are re-fetch triggers (the worker finished; a lock emptied the cache; an unlock brought the token).
  useEffect(() => {
    const hit = blobs.get(key);
    if (hit) {
      setUrl(hit);
      setState("ready");
      onState?.("ready");
      return;
    }
    setUrl(null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const report = (next: ThumbState) => {
      if (cancelled) return;
      setState(next);
      onState?.(next);
    };
    const attempt = async (n: number) => {
      const startedIn = blobs.gen;
      try {
        const result = await client.files.thumb(
          file.instance_type,
          file.instance_id,
          file.id,
          size,
          {
            crop,
            signal: controller.signal,
          },
        );
        if (cancelled || startedIn !== blobs.gen) return; // a lock happened meanwhile: drop it
        if (result.status === "ready") {
          const made = blobs.put(key, result.blob, startedIn);
          if (made === null) return;
          setUrl(made);
          report("ready");
          return;
        }
        if (result.status === "generating") {
          report("generating");
          if (n < maxRetries)
            timer = setTimeout(() => void attempt(n + 1), thumbRetryDelay(n, retryBaseMs));
          return;
        }
        if (result.status === "failed") {
          report("failed");
          return;
        }
        report("error");
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (keyring.handleError(error)) {
          report("locked");
          return;
        }
        if (error instanceof VolaError && error.status === 404) {
          report("none");
          return;
        }
        report("error");
      }
    };
    report("loading");
    void attempt(0);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, processing, gen, unlocked, client, blobs, keyring, maxRetries, retryBaseMs, size, crop]);

  const label =
    state === "ready"
      ? (alt ?? file.filename ?? "")
      : state === "generating"
        ? t("THUMB_GENERATING")
        : state === "failed"
          ? t("THUMB_FAILED")
          : state === "none"
            ? t("THUMB_NONE")
            : state === "locked"
              ? t("THUMB_LOCKED")
              : state === "error"
                ? t("THUMB_ERROR")
                : t("LOADING");

  const classes = `vola-thumb${className ? ` ${className}` : ""}`;
  const box = { width: size, height: size };
  if (state === "ready" && url) {
    return (
      <span className={classes} data-state={state} data-kind={file.kind ?? undefined} style={box}>
        <img className="vola-thumb__img" src={url} alt={label} width={size} height={size} />
      </span>
    );
  }
  return (
    <span
      className={classes}
      data-state={state}
      data-kind={file.kind ?? undefined}
      style={box}
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="vola-thumb__placeholder" aria-hidden="true">
        {state === "locked" ? "🔒" : state === "generating" || state === "loading" ? "…" : "▫"}
      </span>
    </span>
  );
}
