import { z } from "zod";

/**
 * The error envelope every vola route answers with: `{ error: { code, message } }`.
 * Codes are snake_case and stable (`not_found`, `unauthorized`, `vola_locked`, …).
 */
export const ErrorBodySchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  message: z.string(),
});

export const ErrorResponseSchema = z.object({ error: ErrorBodySchema });

export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Builds the error envelope. */
export function errorResponse(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

/** Header a caller may set to correlate requests; the server echoes it (or its own UUID). */
export const REQUEST_ID_HEADER = "x-request-id";
