import { Redis } from "ioredis";

/** What the plugin needs from a Redis client; `ioredis`'s `Redis` satisfies it. */
export interface RedisLike {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

/** Opens an ioredis connection that keeps retrying in the background; `quit()` on shutdown. */
export function connectRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}
