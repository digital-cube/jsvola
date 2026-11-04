import {
  type KeyringCreated,
  KeyringCreatedSchema,
  type KeyringDeletePreview,
  KeyringDeletePreviewSchema,
  type KeyringResetResult,
  KeyringResetResultSchema,
  type KeyringStatus,
  KeyringStatusSchema,
  RESET_CONFIRMATION,
  type Recovered,
  RecoveredSchema,
  type Unlocked,
  UnlockedSchema,
} from "@vol-a/core";
import type { CallOptions, VolaClient } from "./client.js";

export interface UnlockOptions extends CallOptions {
  /** Keep the token in the instance (every later call sends it). Default `true`. */
  remember?: boolean | undefined;
}

/**
 * The keyring of the instance's `userId` (`/keyrings/me`, scope `keyrings:write`): a PIN
 * that locks the keys of that principal's `keyring`-encrypted files. An unlock is a token
 * the instance keeps in memory and sends as `X-Vola-Unlock` until `lock()`, `changePin()`,
 * `recover()` or `reset()` — or the server's sliding TTL — ends it. The PIN, the recovery
 * key and the token go in request bodies and headers, never in a URL.
 */
export class KeyringsApi {
  constructor(private readonly client: VolaClient) {}

  /** `GET /keyrings/me/status`: has a PIN, locked, the token's remaining seconds, a lock-out. Does not extend the token. */
  status(options: CallOptions = {}): Promise<KeyringStatus> {
    return this.client.json("/keyrings/me/status", KeyringStatusSchema, options);
  }

  /** `POST /keyrings/me {pin}` → `201 {keyring_id, recovery_key}`: the recovery key is shown this once — store it with the user. */
  setup(pin: string, options: CallOptions = {}): Promise<KeyringCreated> {
    return this.client.json("/keyrings/me", KeyringCreatedSchema, {
      method: "POST",
      json: { pin },
      ...options,
    });
  }

  /** `PUT /keyrings/me/pin {current_pin, new_pin}`: every token of the principal dies, this instance's too. */
  async changePin(currentPin: string, newPin: string, options: CallOptions = {}): Promise<void> {
    const response = await this.client.request("/keyrings/me/pin", {
      method: "PUT",
      json: { current_pin: currentPin, new_pin: newPin },
      ...options,
    });
    await response.body?.cancel().catch(() => undefined);
    this.client.setUnlock(null);
  }

  /** `POST /keyrings/me/recover {recovery_key, new_pin}` → a NEW recovery key (the old one is retired). */
  async recover(
    recoveryKey: string,
    newPin: string,
    options: CallOptions = {},
  ): Promise<Recovered> {
    const recovered = await this.client.json("/keyrings/me/recover", RecoveredSchema, {
      method: "POST",
      json: { recovery_key: recoveryKey, new_pin: newPin },
      ...options,
    });
    this.client.setUnlock(null);
    return recovered;
  }

  /**
   * `POST /keyrings/me/unlock {pin}` → `{token, expires_in}`; the instance keeps the token
   * (`remember: false` leaves that to the caller). `403 pin_wrong` (with `attempts` in
   * `details`), `429 too_many_attempts` with `retryAfter` while locked out — even for the right PIN.
   */
  async unlock(pin: string, options: UnlockOptions = {}): Promise<Unlocked> {
    const { remember, ...call } = options;
    const unlocked = await this.client.json("/keyrings/me/unlock", UnlockedSchema, {
      method: "POST",
      json: { pin },
      ...call,
    });
    if (remember ?? true) this.client.setUnlock(unlocked.token);
    return unlocked;
  }

  /** `DELETE /keyrings/me/unlock`: ends the token the instance holds (or `options.unlock`) and forgets it. Idempotent; nothing held → nothing sent. */
  async lock(options: CallOptions = {}): Promise<void> {
    if (!options.unlock && !this.client.unlocked) return;
    try {
      const response = await this.client.request("/keyrings/me/unlock", {
        method: "DELETE",
        ...options,
      });
      await response.body?.cancel().catch(() => undefined);
    } finally {
      if (!options.unlock) this.client.setUnlock(null);
    }
  }

  /** `POST /keyrings/me/unlock/close {token}`: the beacon alias — ends `token` without an API key (what `lockOnUnload` sends). */
  async close(token: string, options: Pick<CallOptions, "signal"> = {}): Promise<void> {
    const response = await this.client.request("/keyrings/me/unlock/close", {
      method: "POST",
      anonymous: true,
      json: { token },
      signal: options.signal,
    });
    await response.body?.cancel().catch(() => undefined);
  }

  /** `POST /keyrings/me/reset {confirm: "RESET"}`: the crypto-shred of every file under the keyring and of the keyring. Re-authenticate the person first. */
  async reset(options: CallOptions = {}): Promise<KeyringResetResult> {
    const result = await this.client.json("/keyrings/me/reset", KeyringResetResultSchema, {
      method: "POST",
      json: { confirm: RESET_CONFIRMATION },
      ...options,
    });
    this.client.setUnlock(null);
    return result;
  }

  /** `GET /keyrings/me/delete-preview`: what a reset would remove. */
  deletePreview(options: CallOptions = {}): Promise<KeyringDeletePreview> {
    return this.client.json("/keyrings/me/delete-preview", KeyringDeletePreviewSchema, options);
  }

  /** Admin: `GET /keyrings/by-principal/:principal/status`. */
  statusOf(principal: string, options: CallOptions = {}): Promise<KeyringStatus> {
    return this.client.json(
      `/keyrings/by-principal/${encodeURIComponent(principal)}/status`,
      KeyringStatusSchema,
      options,
    );
  }

  /** Admin: `POST /keyrings/by-principal/:principal/reset`. */
  resetOf(principal: string, options: CallOptions = {}): Promise<KeyringResetResult> {
    return this.client.json(
      `/keyrings/by-principal/${encodeURIComponent(principal)}/reset`,
      KeyringResetResultSchema,
      { method: "POST", json: { confirm: RESET_CONFIRMATION }, ...options },
    );
  }
}
