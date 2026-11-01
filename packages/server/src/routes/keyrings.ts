import {
  type KeyringCreated,
  KeyringCreateSchema,
  type KeyringDeletePreview,
  type KeyringResetResult,
  KeyringResetSchema,
  type KeyringStatus,
  PinChangeSchema,
  type Recovered,
  RecoverSchema,
  UNLOCK_HEADER,
  UnlockCloseSchema,
  type Unlocked,
  UnlockSchema,
  UserIdSchema,
} from "@vola/core";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { z } from "zod";
import { requireTenant } from "../context.js";
import { VolaError } from "../errors.js";
import {
  changePin,
  createKeyring,
  type KeyringsDeps,
  keyringDeletePreview,
  keyringStatus,
  lockKeyring,
  recoverKeyring,
  requirePrincipal,
  resetKeyring,
  unlockKeyring,
} from "../services/keyrings.js";
import type { UnlockPrincipal } from "../services/unlock.js";

const WRITE = { scope: "keyrings:write" } as const;
const ADMIN = { scope: "admin" } as const;
/** The beacon alias: no API key — holding the token is the whole authority, and all it can do is end it. */
const BEACON = { auth: "none", tenant: "optional" } as const;

interface PrincipalParams {
  principal: string;
}

/**
 * Keyrings (plan 6.2, `docs/CRYPTO.md` § keyring), scope `keyrings:write`; the principal is
 * the request's `X-User-Id` (`400 user_required` without it):
 *
 * - `GET /keyrings/me/status` — `{has_pin, locked, unlock_expires_in, locked_until, …}`;
 *   does NOT extend the token;
 * - `POST /keyrings/me {pin}` — `201 {keyring_id, recovery_key}` (the key once; `409` when
 *   one exists; `422 pin_invalid` with `reason`);
 * - `PUT /keyrings/me/pin {current_pin, new_pin}` — `204`; every token of the principal dies;
 * - `POST /keyrings/me/recover {recovery_key, new_pin}` — `{recovery_key}` (a new one);
 * - `POST /keyrings/me/unlock {pin}` — `{token, expires_in}`; `403 pin_wrong`, `429
 *   too_many_attempts` + `Retry-After` while locked out (the right PIN too);
 * - `DELETE /keyrings/me/unlock` (the token from `X-Vola-Unlock`; `204`, idempotent) and
 *   `POST /keyrings/me/unlock/close` with `{token}` (or the bare token as `text/plain`) —
 *   the `navigator.sendBeacon` alias, without an API key;
 * - `POST /keyrings/me/reset {confirm: "RESET"}` — the crypto-shred of every file under the
 *   keyring and of the keyring (re-authenticating the person is the caller's job);
 * - `GET /keyrings/me/delete-preview` — the counts a reset would remove.
 *
 * An admin key may address ANOTHER principal for status and reset only —
 * `GET|POST /keyrings/by-principal/:principal/{status,reset}` — never for an unlock.
 */
export const keyringRoutes: FastifyPluginAsync<{ keyrings: KeyringsDeps }> = async (
  app,
  { keyrings },
) => {
  const me = (): UnlockPrincipal => {
    const tenant = requireTenant();
    return { tenantId: tenant.tenantId, principal: requirePrincipal(tenant) };
  };
  const named = (request: FastifyRequest<{ Params: PrincipalParams }>): UnlockPrincipal => {
    const parsed = UserIdSchema.safeParse(request.params.principal);
    if (!parsed.success) {
      throw new VolaError("validation_error", 422, `principal: ${parsed.error.issues[0]?.message}`);
    }
    return { tenantId: requireTenant().tenantId, principal: parsed.data };
  };
  const tokenOf = (request: FastifyRequest): string | null => {
    const raw = request.headers[UNLOCK_HEADER];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    return value ? value : null;
  };
  const body = <T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> => {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new VolaError(
        "validation_error",
        422,
        `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      );
    }
    return parsed.data;
  };

  app.get(
    "/keyrings/me/status",
    { config: WRITE },
    async (request): Promise<KeyringStatus> => keyringStatus(keyrings, me(), tokenOf(request)),
  );

  app.post<{ Body: unknown }>(
    "/keyrings/me",
    { config: WRITE },
    async (request, reply): Promise<KeyringCreated> => {
      const { pin } = body(KeyringCreateSchema, request.body);
      const created = await createKeyring(keyrings, me(), pin);
      reply.status(201);
      return created;
    },
  );

  app.put<{ Body: unknown }>("/keyrings/me/pin", { config: WRITE }, async (request, reply) => {
    const input = body(PinChangeSchema, request.body);
    await changePin(keyrings, me(), input);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>(
    "/keyrings/me/recover",
    { config: WRITE },
    async (request): Promise<Recovered> =>
      recoverKeyring(keyrings, me(), body(RecoverSchema, request.body)),
  );

  app.post<{ Body: unknown }>(
    "/keyrings/me/unlock",
    { config: WRITE },
    async (request, reply): Promise<Unlocked> => {
      const { pin } = body(UnlockSchema, request.body);
      try {
        return await unlockKeyring(keyrings, me(), pin);
      } catch (error) {
        if (error instanceof VolaError && error.status === 429) {
          reply.header("retry-after", String(error.details?.retry_after ?? 1));
        }
        throw error;
      }
    },
  );

  app.delete("/keyrings/me/unlock", { config: WRITE }, async (request, reply) => {
    me();
    await lockKeyring(keyrings, tokenOf(request));
    return reply.status(204).send();
  });

  // `text/plain` bodies are not parsed by default; the beacon may send the bare token.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, payload, done) =>
    done(null, payload),
  );
  app.post<{ Body: unknown }>(
    "/keyrings/me/unlock/close",
    { config: BEACON },
    async (request, reply) => {
      const raw = request.body;
      const token =
        typeof raw === "string" ? raw.trim() : body(UnlockCloseSchema, raw).token.trim();
      await lockKeyring(keyrings, token || null);
      return reply.status(204).send();
    },
  );

  app.post<{ Body: unknown }>(
    "/keyrings/me/reset",
    { config: WRITE },
    async (request): Promise<KeyringResetResult> => {
      body(KeyringResetSchema, request.body);
      return resetKeyring(keyrings, me());
    },
  );

  app.get(
    "/keyrings/me/delete-preview",
    { config: WRITE },
    async (): Promise<KeyringDeletePreview> => keyringDeletePreview(keyrings, me()),
  );

  app.get<{ Params: PrincipalParams }>(
    "/keyrings/by-principal/:principal/status",
    { config: ADMIN },
    async (request): Promise<KeyringStatus> => keyringStatus(keyrings, named(request), null),
  );

  app.post<{ Params: PrincipalParams; Body: unknown }>(
    "/keyrings/by-principal/:principal/reset",
    { config: ADMIN },
    async (request): Promise<KeyringResetResult> => {
      body(KeyringResetSchema, request.body);
      return resetKeyring(keyrings, named(request));
    },
  );
};
