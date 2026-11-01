/**
 * The in-memory cache of `blob:` URLs the components make of decrypted bytes (thumbnails,
 * previews). Memory only — never storage, never the Cache API — so a lock can take every
 * one of them back: `forget()` revokes each URL, empties the cache and bumps `gen`, the
 * generation counter a fetch compares before it trusts an answer that arrived late
 * (`docs/notes-crypto-for-vola.md` § 4, § 6.9).
 */
export class BlobCache {
  private readonly urls = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  /** The current generation: bumped by every `forget()`. */
  get gen(): number {
    return this.generation;
  }

  /** How many URLs the cache holds. */
  get size(): number {
    return this.urls.size;
  }

  /** The URL under `key`, when there is one. */
  get(key: string): string | undefined {
    return this.urls.get(key);
  }

  /**
   * Makes the `blob:` URL of `blob` and keeps it under `key` (an older one under the same key
   * is revoked). `gen` is the generation the caller started its fetch in: an answer from
   * before a `forget()` is refused — the bytes are dropped and `null` returned.
   */
  put(key: string, blob: Blob, gen: number = this.generation): string | null {
    if (gen !== this.generation) return null;
    const previous = this.urls.get(key);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    this.notify();
    return url;
  }

  /** Revokes and forgets one URL. */
  drop(key: string): void {
    const url = this.urls.get(key);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.urls.delete(key);
    this.notify();
  }

  /** Revokes every URL, empties the cache and starts a new generation (what a lock calls). */
  forget(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.generation += 1;
    this.notify();
  }

  /** `useSyncExternalStore` plumbing: called on every change. Bound, so it can be passed as is. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
