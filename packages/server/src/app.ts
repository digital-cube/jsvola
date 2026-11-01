import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import { installErrorHandling, requestId, type VolaPluginOptions, volaPlugin } from "./plugin.js";

export interface BuildAppOptions extends VolaPluginOptions {
  /** pino options, `false` to silence, `true` for defaults. Default: `config.logLevel` with `LOG_REDACT`. */
  logger?: FastifyServerOptions["logger"];
}

/** The request headers a log line must never carry whole. */
const SECRET_HEADERS = [
  "authorization",
  "x-api-key",
  "x-vola-unlock",
  "x-vola-content-key",
  "x-share-secret",
  "x-share-password",
] as const;

/**
 * Header paths pino REDACTS wherever a request's headers land in a log line: the API key,
 * the unlock token (6.2), the caller's content key and the share secret (6.3). The default
 * request serializer logs no header, but a library does at `trace` level
 * (`@fastify/multipart` logs its busboy options, headers included), so the paths cover a
 * headers object at the top of the line, one level down (`req`, `busboyOptions`, …) and two
 * levels down. A host that embeds the plugin under its own logger should add the same list
 * (`test/encryption3.test.ts` reads every line of a trace-level logger for the key).
 */
export const LOG_REDACT: readonly string[] = SECRET_HEADERS.flatMap((name) => [
  `headers["${name}"]`,
  `*.headers["${name}"]`,
  `*.*.headers["${name}"]`,
]);

/**
 * Standalone server: a Fastify instance with the vola plugin mounted under `config.prefix`.
 * `X-Request-ID` is accepted from the caller or generated, echoed on every response (also
 * outside the prefix) and logged as `request_id`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { logger, ...plugin } = options;
  // A logger given as options gets the redaction too; one given as an instance is the host's.
  const loggerOptions =
    logger === undefined
      ? { level: options.config.logLevel, redact: [...LOG_REDACT] }
      : typeof logger === "object" && logger !== null && !("child" in logger)
        ? { redact: [...LOG_REDACT], ...logger }
        : logger;
  const app = Fastify({
    logger: loggerOptions,
    requestIdHeader: false,
    genReqId: (request) => requestId(request.headers["x-request-id"]),
    logController: new LogController({ requestIdLogLabel: "request_id" }),
  });
  installErrorHandling(app);
  await app.register(volaPlugin, { ...plugin, prefix: options.config.prefix });
  return app;
}
