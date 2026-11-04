import {
  type FolderDeleteResult,
  type FolderInfo,
  type FolderListing,
  FolderPatchSchema,
  RECURSIVE_QUERY,
} from "@vol-a/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AuditLog } from "../audit/log.js";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import type { FileEventBus } from "../events/bus.js";
import { parseInstance } from "../services/files.js";
import {
  deleteFolder,
  ensureFolder,
  type FoldersDeps,
  listFolder,
  parsePath,
  relocateFolder,
  serializeFolder,
  setFolderKeyring,
} from "../services/folders.js";
import { findKeyring, keyringNotFound, requirePrincipal } from "../services/keyrings.js";
import { flag } from "./send-file.js";

export interface FolderRoutesDeps {
  db: Database;
  /** The audit trail (files a folder delete removes). */
  audit?: AuditLog | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** Where a change of the files in a folder is announced after its commit. */
  events?: FileEventBus | undefined;
  now?: (() => Date) | undefined;
}

const READ = { scope: "folders:read" } as const;
const WRITE = { scope: "folders:write" } as const;

interface InstanceParams {
  type: string;
  id: string;
}
interface PathParams extends InstanceParams {
  "*": string;
}
interface DeleteQuery {
  [RECURSIVE_QUERY]?: string;
}

/**
 * Virtual folders of an instance (`/folders/:type/:id/*path`). The path is the wildcard of
 * the URL, decoded by the router and normalised here (`a/b/c`; `..`, `\`, control
 * characters and an empty segment are `422 validation_error`). Tenant-scoped: another
 * tenant's folder is `404 folder_not_found`.
 *
 * - `POST …/*path` — `folders:write`: the folder and every missing parent; `201` when the
 *   leaf is new, `200` when it existed;
 * - `GET …/*path` (or `GET …` for the root) — `folders:read`: one level, `{folder,
 *   subfolders, files}`;
 * - `PATCH …/*path` — `folders:write`: `{name}` renames (descendants follow),
 *   `{parent_path}` moves (`""`: the root); `409 folder_exists` on a collision;
 *   `{default_keyring: "me" | null}` sets or clears the folder's encryption policy (6.2:
 *   `"me"` is the keyring of the request's `X-User-Id` — `400` without one, `404
 *   keyring_not_found` without a keyring);
 * - `DELETE …/*path[?recursive=1]` — `folders:write`: soft delete; a non-empty folder
 *   without `recursive` is `409 folder_not_empty`.
 */
export const folderRoutes: FastifyPluginAsync<FolderRoutesDeps> = async (app, deps) => {
  const service: FoldersDeps = {
    db: deps.db,
    logger: deps.logger ?? app.log,
    events: deps.events,
    audit: deps.audit,
    now: deps.now,
  };

  const scopeOf = (request: FastifyRequest<{ Params: InstanceParams }>) =>
    parseInstance(requireTenant().tenantId, request.params.type, request.params.id);
  const pathOf = (request: FastifyRequest<{ Params: PathParams }>) =>
    parsePath(request.params["*"]);
  /** A route that works on a folder, never on the root. */
  const folderPathOf = (request: FastifyRequest<{ Params: PathParams }>) => {
    const path = pathOf(request);
    if (path === "") throw new VolaError("validation_error", 422, "path: the root is not a folder");
    return path;
  };

  app.post<{ Params: PathParams }>(
    "/folders/:type/:id/*",
    { config: WRITE },
    async (request, reply): Promise<FolderInfo> => {
      const { folder, created } = await ensureFolder(
        service,
        scopeOf(request),
        folderPathOf(request),
        requireTenant().userId,
      );
      reply.status(created ? 201 : 200);
      return serializeFolder(folder);
    },
  );

  const list = async (
    request: FastifyRequest<{ Params: InstanceParams & { "*"?: string } }>,
  ): Promise<FolderListing> =>
    listFolder(service, scopeOf(request), parsePath(request.params["*"] ?? ""));
  app.get<{ Params: InstanceParams }>("/folders/:type/:id", { config: READ }, list);
  app.get<{ Params: PathParams }>("/folders/:type/:id/*", { config: READ }, list);

  app.patch<{ Params: PathParams; Body: unknown }>(
    "/folders/:type/:id/*",
    { config: WRITE },
    async (request): Promise<FolderInfo> => {
      const parsed = FolderPatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new VolaError(
          "validation_error",
          422,
          `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
        );
      }
      const tenant = requireTenant();
      const scope = scopeOf(request);
      const path = folderPathOf(request);
      const patch = parsed.data;
      let info: FolderInfo | undefined;
      if (patch.default_keyring !== undefined) {
        let keyringId: string | null = null;
        if (patch.default_keyring === "me") {
          const principal = requirePrincipal(tenant);
          const keyring = await findKeyring(
            { db: deps.db },
            { tenantId: tenant.tenantId, principal },
          );
          if (!keyring) throw keyringNotFound();
          keyringId = keyring.id;
        }
        info = await setFolderKeyring(service, scope, path, keyringId);
      }
      if (patch.name !== undefined || patch.parent_path !== undefined) {
        info = await relocateFolder(service, scope, path, {
          name: patch.name,
          parentPath: patch.parent_path,
          userId: tenant.userId,
        });
      }
      return info as FolderInfo;
    },
  );

  app.delete<{ Params: PathParams; Querystring: DeleteQuery }>(
    "/folders/:type/:id/*",
    { config: WRITE },
    async (request): Promise<FolderDeleteResult> =>
      deleteFolder(service, scopeOf(request), folderPathOf(request), {
        recursive: flag(request.query[RECURSIVE_QUERY]),
        userId: requireTenant().userId,
      }),
  );
};
