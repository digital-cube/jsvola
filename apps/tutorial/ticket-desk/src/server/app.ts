import { type CollectionRegistry, createDispatcher, udcPlugin } from "@jsudc/server";
import Fastify, { type FastifyServerOptions } from "fastify";
import { emitOnDrag } from "./drag.ts";
import type { Emit } from "./memento.ts";
import { type FileLookup, ticketRoutes } from "./tickets.ts";

export interface AppOptions {
  registry: CollectionRegistry;
  /** Sends one event to memento. */
  emit: Emit;
  /** Asks vola about one file. */
  lookupFile: FileLookup;
  logger?: FastifyServerOptions["logger"];
}

/** The whole backend, with everything it talks to passed in: that is what the tests replace. */
export async function buildApp({ registry, emit, lookupFile, logger = false }: AppOptions) {
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

  return app;
}
