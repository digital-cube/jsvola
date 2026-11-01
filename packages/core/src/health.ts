import { z } from "zod";

/** `GET {prefix}/health/live` — the process answers. */
export const LiveResponseSchema = z.object({ status: z.literal("ok") });

export const CheckStatusSchema = z.enum(["ok", "fail"]);

/**
 * `GET {prefix}/health/ready` — 200 when every dependency answers, 503 otherwise.
 * `checks.redis` is present only when a Redis connection is configured.
 */
export const ReadyResponseSchema = z.object({
  status: CheckStatusSchema,
  checks: z.object({
    database: CheckStatusSchema,
    redis: CheckStatusSchema.optional(),
  }),
});

export type LiveResponse = z.infer<typeof LiveResponseSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
