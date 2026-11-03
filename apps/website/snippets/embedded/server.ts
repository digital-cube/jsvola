import { connect, loadConfig, runMigrations, volaPlugin } from "@vola/server";
import Fastify from "fastify";

// vola inside the Fastify application you already have, under /vola. Every VOLA_* variable is read
// by loadConfig(); the worker is a separate process, `node node_modules/@vola/server/dist/worker.js`.
const app = Fastify({ logger: true });
const config = loadConfig();
const { db } = connect(config.databaseUrl);
await runMigrations(db);

app.get("/", async () => ({ service: "my-app" }));
await app.register(volaPlugin, { prefix: "/vola", config, db });

await app.listen({ host: "0.0.0.0", port: 3000 });
