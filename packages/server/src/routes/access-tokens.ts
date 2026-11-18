import { AccessTokenCreateSchema } from "@vol-a/core";
import type { FastifyPluginAsync } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import {
  type AccessTokensDeps,
  issueAccessToken,
  revokeAccessToken,
} from "../services/access-tokens.js";

export interface AccessTokenRoutesDeps {
  db: Database;
  /** `VOLA_ACCESS_TOKEN_MAX_TTL_S` (default 3600). */
  maxTtlS?: number | undefined;
  now?: (() => Date) | undefined;
}

const GRANT = { scope: "access:grant" } as const;

/**
 * Access tokens (1.2), for the HOST's backend (scope `access:grant`; an access token itself
 * is `401` here, like on every route but the four reads):
 *
 * - `POST /access-tokens` `{file_ids: [uuid…] | instance: {instance_type, instance_id},
 *   principal, expires_in?}` → `201 {id, token, expires_at}` — the token in plain text, this
 *   once; `404 file_not_found` when any `file_id` is not a live row of the tenant; `422` for
 *   `expires_in` above `VOLA_ACCESS_TOKEN_MAX_TTL_S`;
 * - `DELETE /access-tokens/:id` → `204`: revoke before expiry; idempotent; another tenant's
 *   token is `404 access_token_not_found`.
 *
 * Neither is an audit event (they are too frequent); the downloads are, with
 * `VOLA_AUDIT_DOWNLOADS`.
 */
export const accessTokenRoutes: FastifyPluginAsync<AccessTokenRoutesDeps> = async (app, deps) => {
  const service: AccessTokensDeps = { db: deps.db, maxTtlS: deps.maxTtlS, now: deps.now };

  app.post<{ Body: unknown }>("/access-tokens", { config: GRANT }, async (request, reply) => {
    const tenant = requireTenant();
    const parsed = AccessTokenCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new VolaError(
        "validation_error",
        422,
        `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      );
    }
    const created = await issueAccessToken(service, {
      tenantId: tenant.tenantId,
      apiKeyId: tenant.apiKeyId,
      body: parsed.data,
    });
    // Never the token: its id, scope and lifetime only.
    request.log.info(
      {
        access_token: created.id,
        files: parsed.data.file_ids?.length,
        instance: parsed.data.instance
          ? `${parsed.data.instance.instance_type}/${parsed.data.instance.instance_id}`
          : undefined,
        expires_at: created.expires_at,
      },
      "access token issued",
    );
    return reply.status(201).send(created);
  });

  app.delete<{ Params: { id: string } }>(
    "/access-tokens/:id",
    { config: GRANT },
    async (request, reply) => {
      await revokeAccessToken(service, requireTenant().tenantId, request.params.id);
      request.log.info({ access_token: request.params.id }, "access token revoked");
      return reply.status(204).send();
    },
  );
};
