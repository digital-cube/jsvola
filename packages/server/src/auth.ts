import {
  CONTENT_KEY_HEADER,
  displayApiKey,
  extractApiKey,
  extractSubprotocolKey,
  missingScopes,
  type Scope,
  TENANT_SLUG_HEADER,
  UNLOCK_HEADER,
  USER_ID_HEADER,
  UserIdSchema,
} from "@vol-a/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasTenant, runWithTenant, type TenantContext, tenantRequired } from "./context.js";
import { parseContentKey } from "./crypto/caller.js";
import type { Database } from "./db/index.js";
import { VolaError } from "./errors.js";
import { authenticateApiKey, LastUsedThrottle, touchLastUsed } from "./services/apikeys.js";
import { findTenantBySlug } from "./services/tenants.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every authenticated request. */
    vola?: TenantContext;
  }
  interface FastifyContextConfig {
    /** `"none"`: no API key needed (health, public downloads). Default: a valid key. */
    auth?: "none";
    /** Scope(s) the key must hold (all of them); `admin` satisfies any. Default: any valid key. */
    scope?: Scope | Scope[];
    /**
     * `"optional"`: the route answers an admin key that selected no tenant (`X-Tenant-Slug`
     * absent). Default: a tenant is required (`400 tenant_required` without one).
     */
    tenant?: "optional";
  }
}

export interface InstallAuthOptions {
  /** Shared `last_used_at` throttle; default: a new one per `installAuth`. */
  lastUsed?: LastUsedThrottle | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

/** The one answer every authentication failure gets, so a caller cannot probe which part was wrong. */
export function unauthorized(): VolaError {
  return new VolaError("unauthorized", 401, "a valid API key is required");
}

/** The key of a WebSocket upgrade offered as subprotocol `bearer.<key>` (browsers). */
export function websocketKey(request: FastifyRequest): string | null {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") return null;
  return extractSubprotocolKey(request.headers["sec-websocket-protocol"]);
}

/** The credential of a request: `Authorization: Bearer`, `X-Api-Key`, or the WS subprotocol. */
export function requestApiKey(request: FastifyRequest): string | null {
  return extractApiKey(request.headers) ?? websocketKey(request);
}

/** `X-User-Id`, validated (≤ 255 characters, no control characters); `null` when absent. */
export function requestUserId(request: FastifyRequest): string | null {
  const raw = request.headers[USER_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return null;
  const parsed = UserIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new VolaError("bad_request", 400, `X-User-Id: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

/** The first value of a header, trimmed; `null` when absent or empty. */
function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : null;
}

/**
 * `X-Vola-Content-Key`, decoded (32 bytes); `null` when absent. `400 bad_request` for a value
 * that is not a key. Nothing of it is logged, not even its length.
 */
export function requestContentKey(request: FastifyRequest): Buffer | null {
  try {
    return parseContentKey(headerValue(request, CONTENT_KEY_HEADER));
  } catch (error) {
    if (error instanceof RangeError) throw new VolaError("bad_request", 400, error.message);
    throw error;
  }
}

/**
 * Authenticates `request` and builds its `TenantContext`. Throws `unauthorized` for a
 * missing or unusable key, `tenant_not_found` for an admin's unknown or inactive
 * `X-Tenant-Slug`, `bad_request` for an invalid `X-User-Id` or `X-Vola-Content-Key`. The
 * `X-Vola-Unlock` header is carried along unchecked (the keyring provider resolves it when a
 * keyring file is touched), the content key likewise (the `caller` provider checks the scope
 * and the `Origin` rule when a `caller` file is touched, `EncryptionService.callerKey`).
 */
export async function authenticateRequest(
  request: FastifyRequest,
  db: Database,
  now: Date = new Date(),
): Promise<TenantContext> {
  const plaintext = requestApiKey(request);
  if (!plaintext) throw unauthorized();
  const found = await authenticateApiKey(db, plaintext, now);
  if (!found) throw unauthorized();

  let tenant = found.tenant;
  if (found.key.isAdmin) {
    // A tenant key ignores X-Tenant-Slug; an admin key selects its tenant with it.
    const slug = headerValue(request, TENANT_SLUG_HEADER);
    tenant = null;
    if (slug) {
      const selected = await findTenantBySlug(db, slug);
      if (!selected?.isActive) {
        throw new VolaError("tenant_not_found", 404, `tenant "${slug}" not found`);
      }
      tenant = selected;
    }
  }
  return {
    tenantId: tenant?.id ?? null,
    tenantSlug: tenant?.slug ?? null,
    apiKeyId: found.key.id,
    apiKeyLabel: displayApiKey(found.key.prefix, found.key.last4),
    scopes: found.key.scopes as Scope[],
    isAdmin: found.key.isAdmin,
    userId: requestUserId(request),
    unlockToken: headerValue(request, UNLOCK_HEADER),
    contentKey: requestContentKey(request),
    browserOrigin: headerValue(request, "origin"),
  };
}

/**
 * Installs API-key auth on `app` (and every route registered in it afterwards):
 * 1. `onRequest` — unless the route has `config.auth = "none"`, the request needs a valid key
 *    (`Authorization: Bearer`, `X-Api-Key`, or the `bearer.<key>` subprotocol of a WebSocket
 *    upgrade); `config.scope` must be satisfied (`403 forbidden` with `required` otherwise);
 *    a tenant must be selected unless `config.tenant = "optional"`. The context lands on
 *    `request.vola` and `last_used_at` is touched at most once a minute per key;
 * 2. `preHandler` — the rest of the request runs inside that context's AsyncLocalStorage, so
 *    services read the tenant from `requireTenant()`, never from input.
 */
export function installAuth(
  app: FastifyInstance,
  db: Database,
  options: InstallAuthOptions = {},
): void {
  const lastUsed = options.lastUsed ?? new LastUsedThrottle();
  const clock = options.now ?? (() => new Date());
  app.decorateRequest("vola", undefined);

  app.addHook("onRequest", async (request) => {
    if (request.is404) return;
    const config = request.routeOptions.config;
    if (config?.auth === "none") return;

    const now = clock();
    const context = await authenticateRequest(request, db, now);
    const required = config?.scope;
    if (required) {
      const missing = missingScopes(context.scopes, required);
      if (missing.length > 0) {
        throw new VolaError(
          "forbidden",
          403,
          `this API key lacks the scope ${missing.map((s) => `"${s}"`).join(", ")}`,
          { required: typeof required === "string" ? [required] : [...required] },
        );
      }
    }
    if (config?.tenant !== "optional" && !hasTenant(context)) throw tenantRequired();

    request.vola = context;
    request.log = request.log.child({
      tenant: context.tenantSlug,
      api_key: context.apiKeyId,
      ...(context.userId ? { user: context.userId } : {}),
    });
    if (lastUsed.shouldWrite(context.apiKeyId, now.getTime())) {
      // Bookkeeping only: it must neither delay nor fail the request.
      void touchLastUsed(db, context.apiKeyId, now);
    }
  });

  app.addHook("preHandler", (request, _reply, done) => {
    if (request.vola) runWithTenant(request.vola, done);
    else done();
  });

  // The caller's content key lives for one request: gone from memory as far as Node allows.
  app.addHook("onResponse", async (request) => {
    request.vola?.contentKey?.fill(0);
  });
  app.addHook("onError", async (request) => {
    request.vola?.contentKey?.fill(0);
  });
}
