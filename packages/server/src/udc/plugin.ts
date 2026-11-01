import { errKind } from "@jsudc/core";
import { MESSAGE_ID_HEADER } from "@jsudc/core/client";
import { type CollectionRegistry, createDispatcher, udcPlugin } from "@jsudc/server";
import { missingScopes, type Scope } from "@vola/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticateRequest } from "../auth.js";
import { hasTenant, tenantRequired } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import { LastUsedThrottle, touchLastUsed } from "../services/apikeys.js";

export interface UdcRoutesOptions {
  db: Database;
  registry: CollectionRegistry;
  /** Shared `last_used_at` throttle; default: a new one. */
  lastUsed?: LastUsedThrottle | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

/** Actions that change data or schema need `files:write`; everything else reads. */
const WRITE_ACTIONS = new Set([
  "mutate",
  "reindex",
  "tree.reparent",
  "schema.add_field",
  "schema.update_field",
  "schema.soft_delete_field",
]);

export function scopeForAction(action: string): Scope {
  return WRITE_ACTIONS.has(action) ? "files:write" : "files:read";
}

/** The action of a `…/udc/<action>` URL, `null` for any other URL. */
export function actionOf(url: string): string | null {
  const match = /\/udc\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1] as string) : null;
}

/** The in-protocol code of a vola auth error. */
function udcCode(error: VolaError): "forbidden" | "validation_error" | "not_found" {
  if (error.status === 404) return "not_found";
  if (error.status === 400 || error.status === 422) return "validation_error";
  return "forbidden";
}

function refuse(request: FastifyRequest, reply: FastifyReply, action: string, error: VolaError) {
  const id = request.headers[MESSAGE_ID_HEADER];
  // In-protocol, like every UDC answer: HTTP 200 with an `.err` envelope the client throws.
  return reply.code(200).send({
    kind: errKind(action),
    id: (Array.isArray(id) ? id[0] : id) ?? "",
    payload: { code: udcCode(error), message: error.message },
  });
}

/**
 * The UDC collections (`POST /udc/<action>`, served by `@jsudc/server`) behind vola's API-key
 * auth: `files:read` for `collections`, `describe`, `list`, `read` (and `files:write` for the
 * mutating actions the sources refuse anyway), an admin key with `X-Tenant-Slug`. A refused
 * request is answered in-protocol with a `forbidden` / `validation_error` envelope; an
 * authenticated one sets `request.vola`, which `installAuth`'s `preHandler` turns into the
 * tenant context every collection source reads. jsudc's own routes carry no vola route
 * config, so the plugin-wide key check is switched off for them and done here instead.
 */
export const udcRoutes: FastifyPluginAsync<UdcRoutesOptions> = async (app, options) => {
  const lastUsed = options.lastUsed ?? new LastUsedThrottle();
  const clock = options.now ?? (() => new Date());

  app.addHook("onRoute", (route) => {
    route.config = { ...(route.config ?? {}), auth: "none" };
  });

  // preValidation, not onRequest: the auth answer has to be in-protocol, which needs the action.
  app.addHook("preValidation", async (request, reply) => {
    const action = actionOf(request.url);
    if (action === null) return; // the plugin's GET /healthz stays open
    try {
      const now = clock();
      const context = await authenticateRequest(request, options.db, now);
      const required = scopeForAction(action);
      if (missingScopes(context.scopes, required).length > 0) {
        throw new VolaError("forbidden", 403, `this API key lacks the scope "${required}"`, {
          required: [required],
        });
      }
      if (!hasTenant(context)) throw tenantRequired();
      request.vola = context;
      request.log = request.log.child({ tenant: context.tenantSlug, api_key: context.apiKeyId });
      if (lastUsed.shouldWrite(context.apiKeyId, now.getTime())) {
        void touchLastUsed(options.db, context.apiKeyId, now);
      }
    } catch (error) {
      if (error instanceof VolaError && error.status < 500) {
        return refuse(request, reply, action, error);
      }
      throw error;
    }
  });

  await app.register(udcPlugin, {
    dispatcher: createDispatcher(options.registry, { log: app.log }),
    registry: options.registry,
    swagger: false,
  });
};
