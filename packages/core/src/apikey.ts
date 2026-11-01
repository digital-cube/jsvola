import { z } from "zod";
import { ScopeSchema, TenantScopeSchema } from "./scopes.js";

/** Environments a key is minted for; the prefix of the key is `vola_<env>`. */
export const KEY_ENVS = ["live", "test", "admin"] as const;
export const KeyEnvSchema = z.enum(KEY_ENVS);
export type KeyEnv = z.infer<typeof KeyEnvSchema>;

export const KEY_PREFIXES = ["vola_live", "vola_test", "vola_admin"] as const;
export type KeyPrefix = (typeof KEY_PREFIXES)[number];

/** Length of the random, base62 part of a key. */
export const KEY_SECRET_LENGTH = 32;

const KEY_RE = /^(vola_(live|test|admin))_([A-Za-z0-9]{32})$/;

/** Splits a well-formed key `vola_<env>_<32 base62>` into its parts; `null` for anything else. */
export function parseApiKey(
  key: string,
): { prefix: KeyPrefix; env: KeyEnv; secret: string; last4: string } | null {
  const match = KEY_RE.exec(key);
  if (!match) return null;
  const secret = match[3] as string;
  return {
    prefix: match[1] as KeyPrefix,
    env: match[2] as KeyEnv,
    secret,
    last4: secret.slice(-4),
  };
}

/** How a stored key is shown to a person: `vola_live…k3Qz`. */
export function displayApiKey(prefix: string, last4: string): string {
  return `${prefix}…${last4}`;
}

/** Reads the key from `Authorization: Bearer <key>` or `X-Api-Key: <key>`. */
export function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const authorization = first(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match) return match[1] as string;
  }
  const header = first(headers["x-api-key"])?.trim();
  return header ? header : null;
}

/**
 * Browsers cannot set headers on a WebSocket, so the key travels as a subprotocol:
 * `bearer.<key>`. Offer `vola.v1` next to it and the server selects that one, so the key is
 * never echoed back.
 */
export const BEARER_SUBPROTOCOL_PREFIX = "bearer.";
export const VOLA_SUBPROTOCOL = "vola.v1";

/** The subprotocols a WebSocket client offers: `[VOLA_SUBPROTOCOL, "bearer.<key>"]`. */
export function bearerSubprotocols(apiKey: string): string[] {
  return [VOLA_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${apiKey}`];
}

/** The API key in a `Sec-WebSocket-Protocol` header (`…, bearer.<key>, …`), or `null`. */
export function extractSubprotocolKey(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return null;
  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    if (trimmed.startsWith(BEARER_SUBPROTOCOL_PREFIX)) {
      const key = trimmed.slice(BEARER_SUBPROTOCOL_PREFIX.length);
      if (key) return key;
    }
  }
  return null;
}

/** Headers of the auth contract. */
export const API_KEY_HEADER = "x-api-key";
export const TENANT_SLUG_HEADER = "x-tenant-slug";
export const USER_ID_HEADER = "x-user-id";

/** A tenant slug: lowercase letters, digits and dashes, 2–63 characters, not starting with `-`. */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "2–63 lowercase letters, digits and dashes, e.g. acme");
export type Slug = z.infer<typeof SlugSchema>;

/** `X-User-Id`: an opaque principal of the host application; ≤ 255 characters, none of them control characters. */
export const UserIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/\p{Cc}/u.test(value), { message: "must not contain control characters" });

export const TimestampSchema = z.iso.datetime({ offset: true });

/** Public view of a stored key: never the plaintext, never the hash. */
export const ApiKeySchema = z.object({
  id: z.uuid(),
  /** `null` for an admin key. */
  tenant_id: z.uuid().nullable(),
  name: z.string().min(1).max(200),
  prefix: z.enum(KEY_PREFIXES),
  last4: z.string().length(4),
  scopes: z.array(ScopeSchema),
  is_admin: z.boolean(),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
  expires_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
  created_by: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** `POST /keys`: a tenant key with a subset of the caller's scopes; the plaintext comes back once. */
export const ApiKeyCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(TenantScopeSchema).min(1),
  env: z.enum(["live", "test"]),
  expires_at: TimestampSchema.optional(),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

/** `201` of `POST /keys`: the stored key plus its plaintext, this once. */
export const ApiKeyCreatedSchema = ApiKeySchema.extend({ key: z.string() });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;

/** `GET /keys`. */
export const ApiKeyListSchema = z.object({ keys: z.array(ApiKeySchema) });
export type ApiKeyList = z.infer<typeof ApiKeyListSchema>;

/** Public view of a tenant. */
export const TenantSchema = z.object({
  id: z.uuid(),
  slug: SlugSchema,
  name: z.string().min(1).max(200),
  is_active: z.boolean(),
  /** How an upload without an explicit `encryption` is stored: `none` (default), `tenant`, `keyring` or `caller`. */
  default_encryption: z.enum(["none", "tenant", "keyring", "caller"]),
  created_at: TimestampSchema,
});
export type Tenant = z.infer<typeof TenantSchema>;
