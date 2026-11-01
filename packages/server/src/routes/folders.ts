import {
  type FolderDeleteResult,
  type FolderInfo,
  type FolderListing,
  FolderPatchSchema,
  RECURSIVE_QUERY,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import { parseInstance } from "../services/files.js";
import {
  deleteFolder,
  ensureFolder,
  type FoldersDeps,
  listFolder,
  parsePath,
  relocateFolder,
  serializeFolder,
} from "../services/folders.js";
import { flag } from "./send-file.js";

export interface FolderRoutesDeps {
  db: Database;
  logger?: FastifyBaseLogger | undefined;
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
 * - `DELETE …/*path[?recursive=1]` — `folders:write`: soft delete; a non-empty folder
 *   without `recursive` is `409 folder_not_empty`.
 */
export const folderRoutes: FastifyPluginAsync<FolderRoutesDeps> = async (app, deps) => {
  const service: FoldersDeps = { db: deps.db, logger: deps.logger ?? app.log, now: deps.now };

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
      return relocateFolder(service, scopeOf(request), folderPathOf(request), {
        name: parsed.data.name,
        parentPath: parsed.data.parent_path,
        userId: requireTenant().userId,
      });
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
