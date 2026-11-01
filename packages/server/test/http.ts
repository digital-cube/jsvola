import { randomUUID } from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { bearer } from "./helpers.js";
import { fileUpload, multipartHeaders } from "./multipart.js";

export interface UploadOptions {
  instanceId?: string;
  key?: string;
  contentType?: string;
  fields?: Record<string, string>;
  fieldsFirst?: boolean;
  headers?: Record<string, string>;
  type?: string;
}

type Headers = Record<string, string>;

/** Thin `app.inject` wrappers bound to a default API key (every call may override it). */
export function httpClient(app: FastifyInstance, defaultKey: string, type = "tickets") {
  const headersOf = (headers: Headers, key?: string): Headers => ({
    ...bearer(key ?? defaultKey),
    ...headers,
  });
  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> =>
    app.inject(options);
  return {
    /** `POST /vola/files/:type/:id` with one `file` part (+ fields). */
    async upload(
      data: Buffer,
      filename: string,
      options: UploadOptions = {},
    ): Promise<{ response: LightMyRequestResponse; instanceId: string }> {
      const instanceId = options.instanceId ?? randomUUID();
      const response = await inject({
        method: "POST",
        url: `/vola/files/${options.type ?? type}/${instanceId}`,
        headers: multipartHeaders(headersOf(options.headers ?? {}, options.key)),
        payload: fileUpload(filename, data, {
          contentType: options.contentType,
          fields: options.fields,
          fieldsFirst: options.fieldsFirst,
        }),
      });
      return { response, instanceId };
    },
    get: (url: string, headers: Headers = {}, key?: string) =>
      inject({ method: "GET", url, headers: headersOf(headers, key) }),
    head: (url: string, headers: Headers = {}, key?: string) =>
      inject({ method: "HEAD", url, headers: headersOf(headers, key) }),
    del: (url: string, headers: Headers = {}, key?: string) =>
      inject({ method: "DELETE", url, headers: headersOf(headers, key) }),
    post: (url: string, headers: Headers = {}, key?: string) =>
      inject({ method: "POST", url, headers: headersOf(headers, key) }),
    patch: (url: string, body: Record<string, unknown>, headers: Headers = {}, key?: string) =>
      inject({ method: "PATCH", url, headers: headersOf(headers, key), payload: body }),
  };
}
