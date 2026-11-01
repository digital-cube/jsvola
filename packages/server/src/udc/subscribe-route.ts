import { BEARER_SUBPROTOCOL_PREFIX, SUBSCRIBE_PATH, VOLA_SUBPROTOCOL } from "@vola/core";
import type { FastifyPluginAsync } from "fastify";
import type { BoundTenantContext } from "../context.js";
import { VolaError } from "../errors.js";
import type { SubscriptionHub } from "./hub.js";

/**
 * The subprotocol the server answers with: `vola.v1` when offered, so the `bearer.<key>`
 * next to it is never echoed back; a lone `bearer.<key>` otherwise (a client that offered
 * nothing gets no header).
 */
export function selectSubprotocol(protocols: Set<string>): string | false {
  if (protocols.has(VOLA_SUBPROTOCOL)) return VOLA_SUBPROTOCOL;
  for (const protocol of protocols) {
    if (protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX)) return protocol;
  }
  return false;
}

/**
 * `GET /udc/subscribe` — the real-time face of the UDC collections (WebSocket). The key is
 * checked by the plugin's auth BEFORE the upgrade (`Authorization`, `X-Api-Key`, or the
 * `bearer.<key>` subprotocol; never a query parameter), so a bad key is a plain `401`, a
 * key without `files:read` a `403`, an admin key without `X-Tenant-Slug` a `400`. A plain
 * `GET` without `Upgrade` is a `400`.
 */
export const subscribeRoutes: FastifyPluginAsync<{ hub: SubscriptionHub }> = async (
  app,
  { hub },
) => {
  app.route({
    method: "GET",
    url: SUBSCRIBE_PATH,
    config: { scope: "files:read" },
    handler: async () => {
      throw new VolaError(
        "bad_request",
        400,
        `${SUBSCRIBE_PATH} is a WebSocket endpoint: send an Upgrade request`,
      );
    },
    wsHandler: (socket, request) => {
      const tenant = request.vola;
      /* v8 ignore next 4 -- the route's auth always sets a tenant context */
      if (!tenant || tenant.tenantId === null) {
        socket.close(1011, "not authenticated");
        return;
      }
      hub.add(socket, tenant as BoundTenantContext);
    },
  });
};
