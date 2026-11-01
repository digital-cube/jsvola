import {
  type ErrorResponse,
  ErrorResponseSchema,
  type LiveResponse,
  LiveResponseSchema,
  type ReadyResponse,
  ReadyResponseSchema,
} from "@vola/core";

export interface VolaClientOptions {
  /** API base URL including the mount prefix, e.g. `http://localhost:8300/vola`. */
  baseUrl: string;
  /** API key sent as `Authorization: Bearer …` (none needed for the health routes). */
  apiKey?: string;
  /** `fetch` to use; default: the global one. */
  fetch?: typeof fetch;
}

/** A non-2xx answer of the server, carrying its `{ error: { code, message } }` body. */
export class VolaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VolaApiError";
  }
}

/**
 * The SDK. Only the health routes exist for now; the file, folder, share and upload
 * methods arrive with the client ticket (plan 7.1).
 */
export class VolaClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VolaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** `GET /health/live`. */
  async live(): Promise<LiveResponse> {
    return LiveResponseSchema.parse(await this.json("/health/live"));
  }

  /** `GET /health/ready`; a 503 resolves too (status `fail`) — it is a valid answer. */
  async ready(): Promise<ReadyResponse> {
    const response = await this.request("/health/ready");
    const body: unknown = await response.json();
    if (response.ok || response.status === 503) return ReadyResponseSchema.parse(body);
    throw toApiError(response.status, body);
  }

  private async request(path: string): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return this.fetchImpl(`${this.baseUrl}${path}`, { headers });
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.request(path);
    const body: unknown = await response.json();
    if (!response.ok) throw toApiError(response.status, body);
    return body;
  }
}

function toApiError(status: number, body: unknown): VolaApiError {
  const parsed = ErrorResponseSchema.safeParse(body);
  const error: ErrorResponse["error"] = parsed.success
    ? parsed.data.error
    : { code: "unknown_error", message: `HTTP ${status}` };
  return new VolaApiError(status, error.code, error.message);
}
