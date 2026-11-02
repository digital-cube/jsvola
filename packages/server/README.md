# @vola/server

The JSVola server: self-hosted, multi-tenant, content-addressable file storage as a **Fastify 5
plugin** and as a **standalone server**, with its worker process, the Drizzle/PostgreSQL schema
and migrations, the content-addressable store on disk, encryption at rest, UDC collections and
the real-time `subscribe` WebSocket.

The usual way to run it is the Docker image, `ghcr.io/digital-cube/jsvola`
([docs/DEPLOYMENT.md](https://github.com/digital-cube/jsvola/blob/main/docs/DEPLOYMENT.md)).
This package is for running it from Node directly or embedding it in your own Fastify
application.

```sh
pnpm add @vola/server @vola/core
```

```ts
// standalone, from Node (the same as `node node_modules/@vola/server/dist/server.js`)
import { buildApp, connect, loadConfig, runMigrations } from "@vola/server";

const config = loadConfig();                       // every VOLA_* variable, validated
const db = connect(config.databaseUrl);
await runMigrations(db.db);
const app = await buildApp({ config, db: db.db });  // the plugin under config.prefix, pino, VOLA_UI_DIR
await app.listen({ host: config.host, port: config.port });
```

```ts
// embedded in a host application
import Fastify from "fastify";
import { volaPlugin, loadConfig, connect } from "@vola/server";

const app = Fastify({ logger: true });
const config = loadConfig();
await app.register(volaPlugin, {
  prefix: "/vola",
  config,
  db: connect(config.databaseUrl).db,
  // redis, storage, events, audit, encryption, decorateRow, extend: (app) => { … }
});
```

The worker is `node node_modules/@vola/server/dist/worker.js` with the same environment
(`VOLA_REDIS_URL`, the same `VOLA_STORAGE_PATH`, the key file for encrypted derivatives). It
needs `pdftoppm` (poppler-utils) and `tesseract` on the machine for PDF thumbnails and OCR.

- Routes, bodies, answers and error codes: [docs/API.md](https://github.com/digital-cube/jsvola/blob/main/docs/API.md)
- Packages, the upload flow, the CAS layout, the worker, the event bus: [docs/ARCHITECTURE.md](https://github.com/digital-cube/jsvola/blob/main/docs/ARCHITECTURE.md)
- Encryption at rest: [docs/CRYPTO.md](https://github.com/digital-cube/jsvola/blob/main/docs/CRYPTO.md)
- Every `VOLA_*` variable: [docs/DEPLOYMENT.md](https://github.com/digital-cube/jsvola/blob/main/docs/DEPLOYMENT.md#environment-variables)

MIT.
