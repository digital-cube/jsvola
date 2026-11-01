import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { errorResponse } from "@vola/core";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface UiOptions {
  /** A built single-page app (`vite build` output): a directory with `index.html`. */
  root: string;
  /**
   * Paths the app's `index.html` answers under, besides `/`. Default `["/en"]`. Assets are
   * served from `/` (Vite's default `base`), so each mount only needs the page itself.
   */
  mounts?: string[] | undefined;
  /** The API prefix (`/vola`): unknown paths under it stay JSON 404s, never the page. */
  apiPrefix: string;
}

/** `index.html` is revalidated on every load; hashed `assets/*` are cached for a year. */
function cacheHeaders(reply: FastifyReply, path: string): void {
  reply.header(
    "cache-control",
    /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

/**
 * Serves a built React app (the examples site, `apps/examples`) at `/` and every mount
 * (default `/en/`), with an `index.html` fallback for client-side routes: a `GET` that
 * accepts `text/html` and is not under `apiPrefix` gets the page; everything else a JSON
 * `404 not_found`. Installed on the ROOT instance of the standalone server (`buildApp`),
 * next to the vola plugin — it owns the root's not-found handler, so `installErrorHandling`
 * must leave that one out.
 */
export async function installUi(app: FastifyInstance, options: UiOptions): Promise<void> {
  if (!existsSync(join(options.root, "index.html"))) {
    throw new Error(`VOLA_UI_DIR ${options.root} has no index.html`);
  }
  const apiPrefix = options.apiPrefix.replace(/\/+$/, "");
  const mounts = (options.mounts ?? ["/en"]).map((mount) => `/${mount.replace(/^\/+|\/+$/g, "")}`);

  await app.register(fastifyStatic, {
    root: options.root,
    prefix: "/",
    wildcard: false,
    index: ["index.html"],
    setHeaders: cacheHeaders,
  });

  const page = (reply: FastifyReply) => reply.sendFile("index.html");

  for (const mount of mounts) {
    app.get(mount, (_request, reply) => reply.redirect(`${mount}/`, 301));
    app.get(`${mount}/*`, (_request, reply) => page(reply));
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const underApi = path === apiPrefix || path.startsWith(`${apiPrefix}/`);
    const wantsPage = (request.headers.accept ?? "").includes("text/html");
    if ((request.method === "GET" || request.method === "HEAD") && wantsPage && !underApi) {
      return page(reply);
    }
    return reply
      .status(404)
      .send(errorResponse("not_found", `route ${request.method} ${path} not found`));
  });
}
