/**
 * A sliding-window counter per key (a visitor's IP) kept in this process: the demo routes'
 * brake against a script that uploads in a loop. One server serves the examples site, so
 * memory is the right place; the window and the limit come from the configuration.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** Hits one key may make inside `windowMs`. */
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /**
   * Records a hit of `key` and says whether it was within the limit; when it was not, how
   * many seconds until the oldest hit of the window ages out (`Retry-After`).
   */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterS: number } {
    const now = this.now();
    const since = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      const oldest = list[0] ?? now;
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((oldest - since) / 1000)) };
    }
    list.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.prune(since);
    this.hits.set(key, list);
    return { allowed: true };
  }

  /** How many hits `key` has in the current window. */
  count(key: string): number {
    const since = this.now() - this.windowMs;
    return (this.hits.get(key) ?? []).filter((at) => at > since).length;
  }

  private prune(since: number): void {
    for (const [key, list] of this.hits) {
      if (!list.some((at) => at > since)) this.hits.delete(key);
    }
  }
}
