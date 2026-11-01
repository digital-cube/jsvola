import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { Database } from "../db/index.js";
import type { LastUsedThrottle } from "../services/apikeys.js";
import { type FilesDeps, findGlobalPublicFile } from "../services/files.js";
import type { StorageBackend } from "../storage/index.js";
import { type DownloadQuery, sendFile } from "./send-file.js";

export interface PublicRoutesDeps {
  db: Database;
  storage: StorageBackend;
  accessThrottle?: LastUsedThrottle | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

/** How long a public response may be cached by anyone (`Cache-Control: public, max-age`). */
export const PUBLIC_MAX_AGE_SECONDS = 300;

interface PublicParams {
  fileId: string;
}

/**
 * `GET|HEAD /public/:fileId` — anonymous download (no API key, no tenant) of a file whose
 * owner set `is_global_public`; everything else, a file that is merely `is_public` included,
 * is `404 file_not_found`. The same download as the authenticated routes (`Range`, `ETag`,
 * `Content-Disposition`, `nosniff`), with `Cache-Control: public, max-age=300`.
 */
export const publicRoutes: FastifyPluginAsync<PublicRoutesDeps> = async (app, deps) => {
  const service: FilesDeps = {
    db: deps.db,
    storage: deps.storage,
    accessThrottle: deps.accessThrottle,
    logger: deps.logger ?? app.log,
    now: deps.now,
  };

  app.route<{ Params: PublicParams; Querystring: DownloadQuery }>({
    method: ["GET", "HEAD"],
    url: "/public/:fileId",
    config: { auth: "none" },
    handler: async (request, reply) => {
      const row = await findGlobalPublicFile(service, request.params.fileId);
      return sendFile(service, request, reply, row, {
        cacheControl: `public, max-age=${PUBLIC_MAX_AGE_SECONDS}`,
        userId: null,
      });
    },
  });
};
