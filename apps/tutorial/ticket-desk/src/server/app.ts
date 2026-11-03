import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { type CollectionRegistry, createDispatcher, udcPlugin } from "@jsudc/server";
import Fastify, { type FastifyServerOptions } from "fastify";
import { USERS } from "../shared/desk.ts";
import { emitOnDrag } from "./drag.ts";
import type { Emit } from "./memento.ts";
import { proxyServices, type Upstreams } from "./proxy.ts";
import { type FileLookup, ticketRoutes } from "./tickets.ts";

export interface AppOptions {
  registry: CollectionRegistry;
  /** Sends one event to memento. */
  emit: Emit;
  /** Asks vola about one file. */
  lookupFile: FileLookup;
  /** The keys the browser works with. There is no login: anybody who opens the page gets them. */
  browserKeys: { memento: string; vola: string };
  /** vola and memento, for the browser. */
  upstreams?: Upstreams;
  /** The built frontend, served when it is there. */
  webRoot?: string;
  logger?: FastifyServerOptions["logger"];
}

/** The whole backend, with everything it talks to passed in: that is what the tests replace. */
export async function buildApp(options: AppOptions) {
  const { registry, emit, lookupFile, browserKeys, upstreams, webRoot, logger = false } = options;
  const app = Fastify({ logger });
  const tickets = registry.get("tickets").source;

  app.get("/health", async () => ({ ok: true }));

  // Before the plugin below: its routes inherit these hooks.
  emitOnDrag(app, tickets, emit);

  // POST /udc/*: the protocol the board reads the `tickets` collection through.
  await app.register(udcPlugin, {
    dispatcher: createDispatcher(registry, { log: app.log }),
    swagger: false,
  });
  await app.register(ticketRoutes, { tickets, emit, lookupFile });

  // What the page needs to know to start.
  app.get("/config", async (_request, reply) => {
    if (!browserKeys.memento || !browserKeys.vola) {
      return reply.code(503).send({ error: "no keys yet: run `make setup`" });
    }
    return { users: USERS, memento_key: browserKeys.memento, vola_key: browserKeys.vola };
  });

  if (upstreams) await proxyServices(app, upstreams);

  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    // A page of the frontend (/t/<id>) is index.html: the router in the browser takes it from there.
    app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
  }

  return app;
}
