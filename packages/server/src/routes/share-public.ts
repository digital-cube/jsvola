import {
  SHARE_PASSWORD_HEADER,
  SHARE_PASSWORD_QUERY,
  SHARE_SECRET_HEADER,
  type SharedFolderListing,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/index.js";
import type { FileRow, ShareLinkRow } from "../db/schema.js";
import { VolaError } from "../errors.js";
import type { LastUsedThrottle } from "../services/apikeys.js";
import type { EncryptionService, OpenedFile } from "../services/encryption.js";
import type { FilesDeps } from "../services/files.js";
import type { SharePasswordLimiter } from "../services/share-password.js";
import {
  consumeDownload,
  listSharedFolder,
  openSharedEncryptedFile,
  resolveShare,
  resolveSharedPath,
  type SharesDeps,
  sharedFile,
  sharedFolder,
  startsDownload,
} from "../services/shares.js";
import type { StorageBackend } from "../storage/index.js";
import { type DownloadQuery, sendFile } from "./send-file.js";

export interface SharePublicRoutesDeps {
  db: Database;
  storage: StorageBackend;
  /** Wrong-password counter; default: in memory, per process. */
  limiter?: SharePasswordLimiter | undefined;
  accessThrottle?: LastUsedThrottle | undefined;
  /** Encryption (plan 6.3): decrypts the download of a share grant; absent → such a share is `503`. */
  crypto?: EncryptionService | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

/** Share answers must not be cached by anyone in between, nor indexed. */
export const SHARE_CACHE_CONTROL = "private, no-store";
export const SHARE_ROBOTS_TAG = "noindex, nofollow";

interface TokenParams {
  token: string;
}
interface PathParams extends TokenParams {
  "*": string;
}
interface ShareQuery extends DownloadQuery {
  [SHARE_PASSWORD_QUERY]?: string;
}

/** The share secret of the request (`X-Share-Secret`); `undefined` when it carried none. Never a query parameter. */
export function requestShareSecret(request: FastifyRequest): string | undefined {
  const raw = request.headers[SHARE_SECRET_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === "" ? undefined : value.trim();
}

/** The password of the request: the `X-Share-Password` header first, `?password=` otherwise. */
export function requestSharePassword(
  request: FastifyRequest<{ Querystring: ShareQuery }>,
): string | undefined {
  const raw = request.headers[SHARE_PASSWORD_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header !== undefined && header !== "") return header;
  const query = request.query[SHARE_PASSWORD_QUERY];
  return query === undefined || query === "" ? undefined : query;
}

/**
 * The anonymous side of share links — no API key, no tenant:
 *
 * - `GET|HEAD /s/:token` — a file share downloads the file (the same `Range` / `ETag` /
 *   `Content-Disposition` as the authenticated routes); a folder share answers a JSON
 *   listing of one level (`kind: "folder"`, `subfolders`, `files` with paths relative to it);
 * - `GET|HEAD /s/:token/path/*` — a file inside a shared folder, by its path relative to it
 *   (or the listing of a subfolder); `404` on a file share.
 *
 * A protected share takes its password in `X-Share-Password` or `?password=`; missing or
 * wrong → `401 share_password_required`, ten wrong ones in fifteen minutes → `429`. Unknown
 * token → `404`; revoked or expired → `410 share_gone`. Only a request that STARTS a download
 * counts against `max_downloads`: `GET` without `Range` or from byte 0; `HEAD` and a `Range`
 * continuation never do — and once the limit is reached, starting another download is
 * `410 share_gone` while `HEAD` and continuations still answer, so the last granted download
 * can be resumed. Answers carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`.
 *
 * The share GRANT of an encrypted file (plan 6.3, `docs/CRYPTO.md` § 12): the link's fragment
 * (`#<secret>`) never reaches the server — the client sends it as `X-Share-Secret`. Missing →
 * `401 share_secret_required`; wrong → `409 vola_integrity`; right → the file decrypted
 * segment by segment (`Range` in plaintext coordinates, `no-store`), after the password, the
 * expiry and `max_downloads` had their say, and before the download is counted.
 */
export const sharePublicRoutes: FastifyPluginAsync<SharePublicRoutesDeps> = async (app, deps) => {
  const logger = deps.logger ?? app.log;
  const shares: SharesDeps = { db: deps.db, logger, limiter: deps.limiter, now: deps.now };
  const filesService: FilesDeps = {
    db: deps.db,
    storage: deps.storage,
    accessThrottle: deps.accessThrottle,
    logger,
    crypto: deps.crypto,
    now: deps.now,
  };
  const PUBLIC = { auth: "none" } as const;

  const mark = (reply: FastifyReply) =>
    reply.header("x-robots-tag", SHARE_ROBOTS_TAG).header("cache-control", SHARE_CACHE_CONTROL);

  const resolve = (request: FastifyRequest<{ Params: TokenParams; Querystring: ShareQuery }>) =>
    resolveShare(shares, request.params.token, { password: requestSharePassword(request) });

  /** Counts the download when the request starts one, then streams the file. */
  async function serve(
    request: FastifyRequest<{ Querystring: ShareQuery }>,
    reply: FastifyReply,
    share: ShareLinkRow,
    file: FileRow,
  ): Promise<FastifyReply> {
    // An encrypted file: the grant has to open under the request's secret BEFORE the
    // download is counted — a wrong secret is not a download.
    let opened: OpenedFile | undefined;
    if (file.encryption !== "none") {
      opened = openSharedEncryptedFile(share, file, requestShareSecret(request));
    }
    try {
      if (startsDownload(request.method, request.headers.range)) {
        const count = await consumeDownload(shares, share);
        request.log.info(
          {
            share: share.id,
            file: file.id,
            download_count: count,
            max_downloads: share.maxDownloads,
          },
          "share download",
        );
      }
      return await sendFile(filesService, request, reply, file, {
        cacheControl: SHARE_CACHE_CONTROL,
        userId: null,
        opened,
      });
    } finally {
      opened?.fk.fill(0);
    }
  }

  app.route<{ Params: TokenParams; Querystring: ShareQuery }>({
    method: ["GET", "HEAD"],
    url: "/s/:token",
    config: PUBLIC,
    handler: async (request, reply) => {
      mark(reply);
      const share = await resolve(request);
      if (share.fileId) return serve(request, reply, share, await sharedFile(shares, share));
      const root = await sharedFolder(shares, share);
      const listing: SharedFolderListing = await listSharedFolder(shares, share, root, root);
      return reply.send(listing);
    },
  });

  app.route<{ Params: PathParams; Querystring: ShareQuery }>({
    method: ["GET", "HEAD"],
    url: "/s/:token/path/*",
    config: PUBLIC,
    handler: async (request, reply) => {
      mark(reply);
      const share = await resolve(request);
      if (!share.folderId) {
        throw new VolaError(
          "not_found",
          404,
          "this share link is a single file; download it at /s/:token",
        );
      }
      const root = await sharedFolder(shares, share);
      const target = await resolveSharedPath(shares, root, request.params["*"]);
      if (target.kind === "file") return serve(request, reply, share, target.file);
      const listing: SharedFolderListing = await listSharedFolder(
        shares,
        share,
        root,
        target.folder,
      );
      return reply.send(listing);
    },
  });
};
