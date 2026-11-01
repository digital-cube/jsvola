import { TransferRequestSchema, type TransferResult } from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { AuditLog } from "../audit/log.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import type { FileEventBus } from "../events/bus.js";
import type { EncryptionService } from "../services/encryption.js";
import { type TransferDeps, transferInstances } from "../services/transfer.js";

export interface AdminRoutesDeps {
  db: Database;
  events?: FileEventBus | undefined;
  audit?: AuditLog | undefined;
  /** Re-wraps the keys of `tenant`-encrypted files a transfer moves. */
  crypto?: EncryptionService | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

/** Only an admin key holds `admin`; the route works across tenants, so none is selected. */
const ADMIN = { scope: "admin", tenant: "optional" } as const;

/**
 * Cross-tenant administration (scope `admin`, which only a `vola_admin_…` key holds; a
 * tenant key is `403 forbidden`):
 *
 * - `POST /admin/transfer` `{from_tenant, to_tenant, instances: [{instance_type,
 *   instance_id}], user_map?, dry_run?}` → the counts (`files`, `folders`, `merged_folders`,
 *   `shares`, `jobs`, `metadata`, `uploads`, `instances`, `dry_run`). `X-Tenant-Slug` is
 *   ignored: both tenants are in the body. See `services/transfer.ts` for the rules and the
 *   refusals (`404 tenant_not_found`, `409 encrypted_transfer_unsupported` for keyring /
 *   caller files, `409 uploads_in_progress`; a `tenant`-encrypted file's key is re-wrapped,
 *   `503 encryption_unavailable` without the key file).
 */
export const adminRoutes: FastifyPluginAsync<AdminRoutesDeps> = async (app, deps) => {
  const service: TransferDeps = {
    db: deps.db,
    logger: deps.logger ?? app.log,
    events: deps.events,
    audit: deps.audit,
    crypto: deps.crypto,
    now: deps.now,
  };

  app.post<{ Body: unknown }>(
    "/admin/transfer",
    { config: ADMIN },
    async (request): Promise<TransferResult> => {
      const parsed = TransferRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new VolaError(
          "validation_error",
          422,
          `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
        );
      }
      return transferInstances({ ...service, logger: request.log }, parsed.data);
    },
  );
};
