import {
  type AccessTokenCreate,
  type AccessTokenCreated,
  AccessTokenCreatedSchema,
} from "@vol-a/core";
import type { CallOptions, VolaClient } from "./client.js";

/**
 * Access tokens (scope `access:grant`) — for the HOST's backend, with its API key: issue a
 * short-lived, read-only token for the rows (or the instance) its user may read, hand it to
 * the browser, revoke it early when needed. The browser builds a `VolaClient` with
 * `accessToken` (and `getAccessToken` to refresh it).
 */
export class AccessTokensApi {
  constructor(private readonly client: VolaClient) {}

  /**
   * `POST /access-tokens {file_ids | instance, principal, expires_in?}` → `201`: `{id, token,
   * expires_at}`, the token in plain text this once. `404 file_not_found` when any file is
   * not a live row of the tenant; `422` for `expires_in` above the server's maximum.
   */
  create(body: AccessTokenCreate, options: CallOptions = {}): Promise<AccessTokenCreated> {
    return this.client.json("/access-tokens", AccessTokenCreatedSchema, {
      method: "POST",
      json: body,
      ...options,
    });
  }

  /** `DELETE /access-tokens/:id` → `204`: the token is `401` from now on. Idempotent. */
  async revoke(id: string, options: CallOptions = {}): Promise<void> {
    const response = await this.client.request(`/access-tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...options,
    });
    await response.body?.cancel().catch(() => undefined);
  }
}
