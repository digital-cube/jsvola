import { connect, loadConfig, runMigrations, volaPlugin } from "@vol-a/server";
import Fastify from "fastify";

// vola inside the Fastify application you already have, under /vola. Every VOLA_* variable is read
// by loadConfig(); VOLA_DATABASE_URL picks the database: postgresql://… or a SQLite file:<path>.
// The worker is a separate process, `node node_modules/@vol-a/server/dist/worker.js`.
const app = Fastify({ logger: true });
const config = loadConfig();
const database = connect(config.databaseUrl);
await runMigrations(database.db); // on SQLite this creates the file on the first start

app.get("/", async () => ({ service: "my-app" }));
await app.register(volaPlugin, { prefix: "/vola", config, db: database.db });
app.addHook("onClose", async () => database.close());

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
await app.listen({ host: "0.0.0.0", port: 3000 });
