import { type ApiKeyCreated, ApiKeyCreateSchema, type ApiKeyList, missingScopes } from "@vola/core";
import type { FastifyPluginAsync } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apikeys.js";

export interface KeyRoutesDeps {
  db: Database;
}

const KEYS_WRITE = { scope: "keys:write" } as const;

/**
 * API keys of the current tenant (scope `keys:write`): create one with a subset of the
 * caller's scopes, list them (never the hash), revoke one. A key of another tenant is
 * `404 not_found`. An admin key works here with `X-Tenant-Slug`.
 */
export const keyRoutes: FastifyPluginAsync<KeyRoutesDeps> = async (app, { db }) => {
  /** `{name, scopes, env, expires_at?}` → 201: the key with its plaintext, this once. */
  app.post("/keys", { config: KEYS_WRITE }, async (request, reply) => {
    const tenant = requireTenant();
    const parsed = ApiKeyCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new VolaError(
        "validation_error",
        422,
        `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      );
    }
    const body = parsed.data;
    const beyond = missingScopes(tenant.scopes, body.scopes);
    if (beyond.length > 0) {
      throw new VolaError(
        "forbidden",
        403,
        `a key may only grant scopes its creator holds; not held: ${beyond.join(", ")}`,
        { required: beyond },
      );
    }
    const { apiKey, key } = await createApiKey(db, {
      tenantId: tenant.tenantId,
      name: body.name,
      env: body.env,
      scopes: body.scopes,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      createdBy: tenant.userId,
    });
    // Never the plaintext: only the key's id reaches the log.
    request.log.info({ created_key: apiKey.id }, "API key created");
    const response: ApiKeyCreated = { ...apiKey, key };
    return reply.status(201).send(response);
  });

  /** The tenant's keys, newest first, without the hash. */
  app.get("/keys", { config: KEYS_WRITE }, async (): Promise<ApiKeyList> => {
    const tenant = requireTenant();
    return { keys: await listApiKeys(db, { tenantId: tenant.tenantId }) };
  });

  /** Soft revoke; idempotent; another tenant's key (or an unknown id) is 404. */
  app.delete<{ Params: { id: string } }>("/keys/:id", { config: KEYS_WRITE }, async (request) => {
    const tenant = requireTenant();
    const revoked = await revokeApiKey(db, request.params.id, { tenantId: tenant.tenantId });
    request.log.info({ revoked_key: revoked.id }, "API key revoked");
    return revoked;
  });
};
