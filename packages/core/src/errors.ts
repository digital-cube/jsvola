import { z } from "zod";

/**
 * The error envelope every vola route answers with: `{ error: { code, message, …details } }`.
 * Codes are snake_case and stable (`not_found`, `unauthorized`, `forbidden`, …). A `forbidden`
 * for a missing scope carries `required`: the scopes the key lacks.
 */
export const ErrorBodySchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  message: z.string(),
  required: z.array(z.string()).optional(),
});

export const ErrorResponseSchema = z.object({ error: ErrorBodySchema });

export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Builds the error envelope; `details` are merged into `error` (`required`, …). */
export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return { error: { code, message, ...details } };
}

/** Header a caller may set to correlate requests; the server echoes it (or its own UUID). */
export const REQUEST_ID_HEADER = "x-request-id";
