import { connect } from "node:net";
import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance } from "fastify";

/** Where a path goes: `/vola/…` to vola, `/memento/…` to memento. */
export type Upstreams = Record<string, string>;

/**
 * The browser sees one origin: memento sends no CORS headers, and this way neither service needs
 * a port of its own. HTTP goes through @fastify/http-proxy; a WebSocket is replayed byte for byte,
 * because both services read the API key from the subprotocol list the browser offered.
 */
export async function proxyServices(app: FastifyInstance, upstreams: Upstreams) {
  for (const [prefix, upstream] of Object.entries(upstreams)) {
    await app.register(httpProxy, { upstream, prefix, rewritePrefix: prefix });
  }

  app.server.on("upgrade", (request, socket, head) => {
    const prefix = Object.keys(upstreams).find((p) => request.url?.startsWith(`${p}/`));
    if (!prefix) return socket.destroy();
    const { hostname, port } = new URL(String(upstreams[prefix]));
    const upstream = connect(Number(port), hostname, () => {
      const headers = request.rawHeaders
        .flatMap((value, i, all) => (i % 2 ? [] : [`${value}: ${all[i + 1]}`]))
        .join("\r\n");
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
}
