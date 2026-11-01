import { z } from "zod";
import { SlugSchema, UserIdSchema } from "./apikey.js";
import { InstanceTypeSchema } from "./files.js";

/** One instance of the host application to move: `(instance_type, instance_id)`. */
export const TransferInstanceSchema = z
  .object({
    instance_type: InstanceTypeSchema,
    instance_id: z.uuid(),
  })
  .strict();
export type TransferInstance = z.infer<typeof TransferInstanceSchema>;

/** Most instances one `POST /admin/transfer` may name. */
export const TRANSFER_MAX_INSTANCES = 1000;

/**
 * `POST /admin/transfer` (an admin key, scope `admin`): move every file of the listed
 * instances from one tenant to another. Rows move, blobs stay on disk. `user_map` rewrites
 * the user ids recorded on the rows (`created_by`, `deleted_by`, `last_accessed_by` of files
 * and folders, `created_by` of share links) from the source tenant's directory to the
 * destination's; a user with no mapping is left as is. `dry_run` answers the same counts and
 * writes nothing.
 */
export const TransferRequestSchema = z
  .object({
    from_tenant: SlugSchema,
    to_tenant: SlugSchema,
    instances: z.array(TransferInstanceSchema).min(1).max(TRANSFER_MAX_INSTANCES),
    user_map: z.record(UserIdSchema, UserIdSchema).default({}),
    dry_run: z.boolean().default(false),
  })
  .strict()
  .refine((body) => body.from_tenant !== body.to_tenant, {
    message: "from_tenant and to_tenant are the same",
    path: ["to_tenant"],
  });
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

/**
 * What a transfer moved (or, with `dry_run`, would move). `folders` counts every source
 * folder, `merged_folders` those among them whose path already existed on the destination
 * and were merged into that folder instead of moved; `shares` counts the share links of the
 * moved files and folders (their tokens are unchanged); `uploads` the finished or expired
 * resumable uploads that followed their instance.
 */
export const TransferResultSchema = z.object({
  from_tenant: SlugSchema,
  to_tenant: SlugSchema,
  instances: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  merged_folders: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  metadata: z.number().int().nonnegative(),
  uploads: z.number().int().nonnegative(),
  dry_run: z.boolean(),
});
export type TransferResult = z.infer<typeof TransferResultSchema>;
