import { z } from "zod";
import { TimestampSchema, UserIdSchema } from "./apikey.js";
import { InstanceTypeSchema } from "./files.js";

/**
 * Access tokens (1.2): a short-lived, read-only credential the HOST application issues to its
 * own user for named ROWS of `vola_file` (`file_ids`) or for one instance — never for content
 * as such. A token reads only `GET|HEAD /files/:type/:id/:fileId` and `…/thumb/:size`; another
 * row, even one sharing the blob, is `404`. Sent as `Authorization: Bearer vola_at_…`.
 */

/** The prefix of every access token: never mistaken for an API key (`vola_live_…`). */
export const ACCESS_TOKEN_PREFIX = "vola_at_";
/** Length of the random, base62 part of a token. */
export const ACCESS_TOKEN_SECRET_LENGTH = 40;
/** `expires_in` when the request names none: five minutes. */
export const DEFAULT_ACCESS_TOKEN_TTL_S = 300;
/** `VOLA_ACCESS_TOKEN_MAX_TTL_S` when unset: one hour. */
export const DEFAULT_ACCESS_TOKEN_MAX_TTL_S = 3600;
/** The most rows one token may name. */
export const ACCESS_TOKEN_MAX_FILES = 100;
/**
 * The code of a `keyring`, `caller` or `client` file read with an access token (`409`): the
 * token carries no unlock and no content key, and this version serves only `none` and
 * `tenant` files through it.
 */
export const ACCESS_TOKEN_ENCRYPTION_UNSUPPORTED_CODE = "access_token_encryption_unsupported";
/** The encryption modes a token may read. */
export const ACCESS_TOKEN_READABLE_ENCRYPTIONS = ["none", "tenant"] as const;

const ACCESS_TOKEN_RE = /^vola_at_[A-Za-z0-9]{40}$/;

/** `true` for a well-formed access token (`vola_at_<40 base62>`). */
export function isAccessToken(value: string): boolean {
  return ACCESS_TOKEN_RE.test(value);
}

/** The instance a token covers: every live row of it at the time of each request. */
export const AccessTokenInstanceSchema = z.strictObject({
  instance_type: InstanceTypeSchema,
  instance_id: z.uuid(),
});
export type AccessTokenInstance = z.infer<typeof AccessTokenInstanceSchema>;

/**
 * `POST /access-tokens`: exactly one of `file_ids` (1–100 rows of the caller's tenant) or
 * `instance`; `principal` (the host's user, the rules of `X-User-Id`); `expires_in` seconds
 * (default 300; above `VOLA_ACCESS_TOKEN_MAX_TTL_S` the server answers `422`).
 */
export const AccessTokenCreateSchema = z
  .strictObject({
    file_ids: z.array(z.uuid()).min(1).max(ACCESS_TOKEN_MAX_FILES).optional(),
    instance: AccessTokenInstanceSchema.optional(),
    principal: UserIdSchema,
    expires_in: z.number().int().positive().optional(),
  })
  .refine((body) => (body.file_ids === undefined) !== (body.instance === undefined), {
    message: "exactly one of file_ids or instance is required",
  });
export type AccessTokenCreate = z.infer<typeof AccessTokenCreateSchema>;

/** The `201` of `POST /access-tokens`: the token in plain text, this once. */
export const AccessTokenCreatedSchema = z.object({
  id: z.uuid(),
  token: z.string().regex(ACCESS_TOKEN_RE),
  expires_at: TimestampSchema,
});
export type AccessTokenCreated = z.infer<typeof AccessTokenCreatedSchema>;
