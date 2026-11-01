import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import { installErrorHandling, requestId, type VolaPluginOptions, volaPlugin } from "./plugin.js";

export interface BuildAppOptions extends VolaPluginOptions {
  /** pino options, `false` to silence, `true` for defaults. Default: `config.logLevel`. */
  logger?: FastifyServerOptions["logger"];
}

/**
 * Standalone server: a Fastify instance with the vola plugin mounted under `config.prefix`.
 * `X-Request-ID` is accepted from the caller or generated, echoed on every response (also
 * outside the prefix) and logged as `request_id`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { logger, ...plugin } = options;
  const app = Fastify({
    logger: logger ?? { level: options.config.logLevel },
    requestIdHeader: false,
    genReqId: (request) => requestId(request.headers["x-request-id"]),
    logController: new LogController({ requestIdLogLabel: "request_id" }),
  });
  installErrorHandling(app);
  await app.register(volaPlugin, { ...plugin, prefix: options.config.prefix });
  return app;
}
