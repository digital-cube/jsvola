import { type CollectionRegistry, createDispatcher, udcPlugin } from "@jsudc/server";
import Fastify, { type FastifyServerOptions } from "fastify";
import { ticketRoutes } from "./tickets.ts";

export interface AppOptions {
  registry: CollectionRegistry;
  logger?: FastifyServerOptions["logger"];
}

/** The whole backend, with everything it talks to passed in: that is what the tests replace. */
export async function buildApp({ registry, logger = false }: AppOptions) {
  const app = Fastify({ logger });

  app.get("/health", async () => ({ ok: true }));

  // POST /udc/*: the protocol the board reads the `tickets` collection through.
  await app.register(udcPlugin, {
    dispatcher: createDispatcher(registry, { log: app.log }),
    swagger: false,
  });
  await app.register(ticketRoutes, { tickets: registry.get("tickets").source });

  return app;
}
