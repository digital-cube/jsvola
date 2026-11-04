import {
  INCLUDE_REVOKED_QUERY,
  type ShareCreated,
  ShareCreateSchema,
  type ShareInfo,
  type ShareList,
} from "@vol-a/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AuditLog } from "../audit/log.js";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import type { EncryptionService } from "../services/encryption.js";
import {
  createShare,
  findShare,
  listShares,
  revokeShare,
  type SharesDeps,
  serializeShare,
} from "../services/shares.js";
import { flag } from "./send-file.js";

export interface ShareRoutesDeps {
  db: Database;
  /**
   * The origin the public share URL is built on (`https://files.example.com`, no trailing
   * slash); `null`: the protocol and `Host` of the creating request.
   */
  publicUrl?: string | null | undefined;
  audit?: AuditLog | undefined;
  /** Encryption (plan 6.3): the share grant of an encrypted file; absent → `409` for encrypted files. */
  crypto?: EncryptionService | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

const WRITE = { scope: "shares:write" } as const;

interface ListQuery {
  file_id?: string;
  folder_id?: string;
  [INCLUDE_REVOKED_QUERY]?: string;
}

/**
 * `<origin><prefix>/s/<token>`: the URL a share is reached at — with `#<secret>` for the grant
 * of an encrypted file: the fragment never reaches a server, the client sends it as
 * `X-Share-Secret`.
 */
export function shareUrl(
  origin: string,
  prefix: string,
  token: string,
  secret: string | null = null,
): string {
  const base = `${origin.replace(/\/+$/, "")}${prefix}/s/${token}`;
  return secret ? `${base}#${secret}` : base;
}

/** The origin of the request as the client sent it (`request.protocol` honours `trustProxy`). */
export function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

/**
 * The owner's side of share links (scope `shares:write`; every route tenant-scoped, another
 * tenant's share is `404 share_not_found`):
 *
 * - `POST /shares` `{file_id | folder: {instance_type, instance_id, path}, password?,
 *   expires_at?, max_downloads?, scope?}` → `201` with the info, the `token` (this once) and
 *   the public `url`; `501 not_implemented` for a scope other than `PUBLIC_LINK`. An
 *   encrypted file (`tenant`, or `keyring` with the owner's `X-Vola-Unlock`) gets a share
 *   GRANT and a `url` ending in `#<secret>`; a `caller` file only with the caller's own
 *   `fk_share_ct`, a `client` file never (`409 encrypted_share_requires_grant`);
 * - `GET /shares[?file_id=|folder_id=][&include_revoked=1]` — newest first, never the token;
 * - `GET /shares/:id`;
 * - `DELETE /shares/:id` — revoke (idempotent); the link answers `410 share_gone` from then on.
 */
export const shareRoutes: FastifyPluginAsync<ShareRoutesDeps> = async (app, deps) => {
  const service: SharesDeps = {
    db: deps.db,
    logger: deps.logger ?? app.log,
    audit: deps.audit,
    crypto: deps.crypto,
    now: deps.now,
  };

  app.post<{ Body: unknown }>("/shares", { config: WRITE }, async (request, reply) => {
    const tenant = requireTenant();
    const parsed = ShareCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new VolaError(
        "validation_error",
        422,
        `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      );
    }
    const { share, token, secret } = await createShare(service, {
      tenantId: tenant.tenantId,
      body: parsed.data,
      userId: tenant.userId,
    });
    const response: ShareCreated = {
      ...share,
      token,
      url: shareUrl(deps.publicUrl ?? requestOrigin(request), app.prefix, token, secret),
    };
    return reply.status(201).send(response);
  });

  app.get<{ Querystring: ListQuery }>(
    "/shares",
    { config: WRITE },
    async (request): Promise<ShareList> => ({
      shares: await listShares(service, requireTenant().tenantId, {
        fileId: request.query.file_id,
        folderId: request.query.folder_id,
        includeRevoked: flag(request.query[INCLUDE_REVOKED_QUERY]),
      }),
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/shares/:id",
    { config: WRITE },
    async (request): Promise<ShareInfo> =>
      serializeShare(await findShare(service, requireTenant().tenantId, request.params.id)),
  );

  app.delete<{ Params: { id: string } }>(
    "/shares/:id",
    { config: WRITE },
    async (request): Promise<ShareInfo> =>
      revokeShare(service, requireTenant().tenantId, request.params.id),
  );
};
