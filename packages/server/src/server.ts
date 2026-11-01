import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { connect, runMigrations } from "./db/index.js";
import { connectRedis } from "./redis.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`vola: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const database = connect(config.databaseUrl);
await runMigrations(database.db);
const redis = config.redisUrl ? connectRedis(config.redisUrl) : undefined;

const app = await buildApp({ config, db: database.db, redis });
redis?.on("error", (error) => app.log.warn({ err: error }, "redis error"));
app.log.info(
  { prefix: config.prefix, storage: config.storagePath, redis: Boolean(redis) },
  "vola configured",
);

app.addHook("onClose", async () => {
  await redis?.quit().catch(() => {});
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
