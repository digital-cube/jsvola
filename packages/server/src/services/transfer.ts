/**
 * `POST /admin/transfer` — move instances' files to another tenant (plan 5.2; the
 * specification is the docstring of vola-spp `src/vola/api/transfer.py`, taken over here).
 *
 * A host application that moves an entity between tenants (thilo moves a project, with its
 * tickets, from one workspace to another) wants the entity's files to follow it. Files and
 * folders are addressed by `(tenant, instance_type, instance_id)` and the only other move
 * (`PATCH …` with `folder_path`) changes the folder inside one instance, so the move is done
 * here. Blobs are content-addressed and shared across tenants on disk, so nothing on disk
 * moves — only rows:
 *
 * - `vola_file` — every row of the instance: every version of the `parent_id` chain and the
 *   soft-deleted rows too (the bin follows the instance);
 * - `vola_folder` — a folder whose path already exists for the same instance on the
 *   destination is MERGED into that folder (its files, sub-folders, share links and uploads
 *   are re-pointed, the source row is deleted), never duplicated: the path is unique per
 *   `(tenant, instance_type, instance_id)`. A live source folder revives a deleted
 *   destination one, so its files do not vanish into the bin;
 * - `vola_share_link` of the moved files and folders — tokens are unchanged, so a public
 *   link keeps working;
 * - `vola_processing_job` and `vola_file_metadata` of the moved files;
 * - `vola_upload` of the instance — finished or expired ones follow; an upload still IN
 *   PROGRESS refuses the whole transfer with `409 uploads_in_progress` (see below);
 * - `vola_tenant_stats` — recomputed for both tenants afterwards, the per-instance rows of
 *   the source dropped and recomputed on the destination.
 *
 * User ids belong to the source tenant's user directory, so `user_map` rewrites
 * `created_by`, `deleted_by` and `last_accessed_by` (files), `created_by` and `deleted_by`
 * (folders) and `created_by` (share links). A user with no mapping is left as is.
 *
 * What is NOT moved is decided by the caller: only the listed instances move. In thilo a
 * user's board background is a `user_background` file of the USER's instance with slug
 * `board-<uuid>` — it belongs to that user, not to the board, so it is not one of a board's
 * instances and stays where it is unless the caller lists it.
 *
 * Only an admin key (scope `admin`, which only a cross-tenant key holds) may call it, and
 * without `X-Tenant-Slug`: both tenants are in the body. The whole request is ONE transaction
 * — every instance moves or none does — and it is idempotent: a repeated call finds nothing
 * left on the source tenant and reports zeros. `dry_run` runs the same statements and rolls
 * them back, so it answers exactly the counts a real run would, and writes nothing.
 *
 * Decisions this port makes where vola-spp was silent or different:
 * - the destination tenant must EXIST (`404 tenant_not_found`); vola-spp created it on the
 *   fly. A tenant is created on purpose (`vola create-tenant`), not as a side effect;
 * - an upload in progress is refused (`409 uploads_in_progress`, with the count) instead of
 *   moved: the client resuming it authenticates with a SOURCE tenant key, which would answer
 *   `404` the moment the row moved, and its part file would complete into the wrong tenant.
 *   The caller waits for it to finish, deletes it, or lets it expire (`VOLA_UPLOAD_TTL_HOURS`);
 * - an encrypted file's wrapped key is bound to its tenant through the wrap AAD, so a row
 *   cannot simply change tenant. For `encryption = tenant` the key is RE-WRAPPED here, inside
 *   the transaction: opened under the source tenant's KEK, wrapped under the destination's
 *   (`EncryptionService.rewrapForTenant`; `503 encryption_unavailable` without the key file,
 *   `409 vola_integrity` for a key that does not open — either refuses the whole transfer
 *   before anything is written). `keyring` and `caller` files are still refused with
 *   `409 encrypted_transfer_unsupported` until phases 6.2 / 6.3 define their move.
 */
import type { TransferInstance, TransferRequest, TransferResult } from "@vola/core";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  type SQL,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLog } from "../audit/log.js";
import type { AuditActorType } from "../audit/memento.js";
import type { Database } from "../db/index.js";
import {
  type FolderRow,
  fileMetadata,
  files,
  folders,
  processingJobs,
  shareLinks,
  type TenantRow,
  tenantStats,
  uploads,
} from "../db/schema.js";
import { VolaError } from "../errors.js";
import { type FileEventBus, publishFileEvents } from "../events/bus.js";
import { type EncryptionService, encryptionUnavailable } from "./encryption.js";
import { computeStats } from "./stats.js";
import { findTenantBySlug } from "./tenants.js";

export interface TransferDeps {
  db: Database;
  logger?: FastifyBaseLogger | undefined;
  /** Where the move is announced after the commit: `purged` on the source, `created` on the destination. */
  events?: FileEventBus | undefined;
  /** The audit trail (`VOLA_INSTANCES_TRANSFERRED`). */
  audit?: AuditLog | undefined;
  /** Who does it, for the audit event; default: the request's actor (the CLI passes its own). */
  actor?: { type: AuditActorType; id: string } | null | undefined;
  /** Re-wraps the keys of `tenant`-encrypted files; without it such an instance is `503`. */
  crypto?: EncryptionService | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

/** What the DML runs on: the transaction. */
type Tx = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

/** The transfer as the transaction sees it. */
interface Plan {
  src: TenantRow;
  dst: TenantRow;
  instances: TransferInstance[];
  userMap: Record<string, string>;
  now: Date;
  crypto: EncryptionService | undefined;
}

/** A moved file row, as the events after the commit need it. */
interface MovedFile {
  instanceType: string;
  instanceId: string;
  id: string;
  folderId: string | null;
}

interface Counts {
  files: number;
  folders: number;
  mergedFolders: number;
  shares: number;
  jobs: number;
  metadata: number;
  uploads: number;
  /** `tenant`-encrypted files whose key was re-wrapped for the destination. */
  rewrapped: number;
}

const zeroCounts = (): Counts => ({
  files: 0,
  folders: 0,
  mergedFolders: 0,
  shares: 0,
  jobs: 0,
  metadata: 0,
  uploads: 0,
  rewrapped: 0,
});

/** The instances of a request, each once, in the order given. */
export function distinctInstances(instances: readonly TransferInstance[]): TransferInstance[] {
  const seen = new Set<string>();
  const out: TransferInstance[] = [];
  for (const instance of instances) {
    const key = `${instance.instance_type}/${instance.instance_id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      instance_type: instance.instance_type,
      instance_id: instance.instance_id.toLowerCase(),
    });
  }
  return out;
}

/**
 * `CASE column WHEN old THEN new … ELSE column END` for the entries of `userMap` that change
 * something; the column itself when none does. One expression rewrites a whole table.
 */
export function mapUsers(column: AnyPgColumn, userMap: Record<string, string>): SQL {
  const entries = Object.entries(userMap).filter(([from, to]) => from !== to);
  if (entries.length === 0) return sql`${column}`;
  const whens = entries.map(([from, to]) => sql`when ${column} = ${from} then ${to}`);
  return sql`case ${sql.join(whens, sql` `)} else ${column} end`;
}

/**
 * Moves the listed instances of `request.from_tenant` to `request.to_tenant`. Throws
 * `404 tenant_not_found`, `409 encrypted_transfer_unsupported`, `409 uploads_in_progress`
 * before anything is written. After the commit: statistics of both tenants, file events on
 * both sides, the audit event.
 */
export async function transferInstances(
  deps: TransferDeps,
  request: TransferRequest,
): Promise<TransferResult> {
  const src = await findTenantBySlug(deps.db, request.from_tenant);
  if (!src) throw tenantNotFound(request.from_tenant);
  const dst = await findTenantBySlug(deps.db, request.to_tenant);
  if (!dst?.isActive) throw tenantNotFound(request.to_tenant);
  const plan: Plan = {
    src,
    dst,
    instances: distinctInstances(request.instances),
    userMap: request.user_map,
    now: (deps.now ?? (() => new Date()))(),
    crypto: deps.crypto,
  };

  let counts = zeroCounts();
  let moved: MovedFile[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      for (const instance of plan.instances) await refuseUnmovable(tx, plan, instance);
      for (const instance of plan.instances) {
        const outcome = await moveInstance(tx, plan, instance);
        counts = addCounts(counts, outcome.counts);
        moved = moved.concat(outcome.moved);
      }
      if (request.dry_run) tx.rollback();
    });
  } catch (error) {
    if (!(request.dry_run && error instanceof TransactionRollbackError)) throw error;
  }

  const result: TransferResult = {
    from_tenant: src.slug,
    to_tenant: dst.slug,
    instances: plan.instances.length,
    files: counts.files,
    folders: counts.folders,
    merged_folders: counts.mergedFolders,
    shares: counts.shares,
    jobs: counts.jobs,
    metadata: counts.metadata,
    uploads: counts.uploads,
    dry_run: request.dry_run,
  };
  if (request.dry_run) return result;

  await refreshStats(deps, plan).catch((error: unknown) =>
    deps.logger?.error({ err: error }, "statistics not recomputed after transfer"),
  );
  await announce(deps, plan, moved);
  deps.audit?.emit({
    event_type: "VOLA_INSTANCES_TRANSFERRED",
    instance_type: "vola_tenant",
    instance_id: dst.slug,
    actor: deps.actor,
    payload: {
      tenant: dst.slug,
      from_tenant: src.slug,
      to_tenant: dst.slug,
      instances: plan.instances,
      files: result.files,
      folders: result.folders,
      merged_folders: result.merged_folders,
      shares: result.shares,
      jobs: result.jobs,
      uploads: result.uploads,
      user_map_entries: Object.keys(plan.userMap).length,
    },
  });
  // Counts and tenants only — never a file name, a user id or an instance id.
  deps.logger?.info(
    {
      from_tenant: src.slug,
      to_tenant: dst.slug,
      instances: result.instances,
      files: result.files,
      folders: result.folders,
      merged_folders: result.merged_folders,
      shares: result.shares,
      jobs: result.jobs,
      uploads: result.uploads,
      rewrapped: counts.rewrapped,
    },
    "instances transferred",
  );
  return result;
}

function tenantNotFound(slug: string): VolaError {
  return new VolaError("tenant_not_found", 404, `tenant "${slug}" not found`);
}

const addCounts = (a: Counts, b: Counts): Counts => ({
  files: a.files + b.files,
  folders: a.folders + b.folders,
  mergedFolders: a.mergedFolders + b.mergedFolders,
  shares: a.shares + b.shares,
  jobs: a.jobs + b.jobs,
  metadata: a.metadata + b.metadata,
  uploads: a.uploads + b.uploads,
  rewrapped: a.rewrapped + b.rewrapped,
});

function instanceOf(
  table: typeof files | typeof folders | typeof uploads,
  tenantId: string,
  i: TransferInstance,
) {
  return and(
    eq(table.tenantId, tenantId),
    eq(table.instanceType, i.instance_type),
    eq(table.instanceId, i.instance_id),
  );
}

/** The refusals, checked for every instance before a single row moves. */
async function refuseUnmovable(tx: Tx, plan: Plan, instance: TransferInstance): Promise<void> {
  const [encrypted] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(files)
    .where(
      and(
        instanceOf(files, plan.src.id, instance),
        ne(files.encryption, "none"),
        ne(files.encryption, "tenant"),
      ),
    );
  const encryptedFiles = Number(encrypted?.n ?? 0);
  if (encryptedFiles > 0) {
    throw new VolaError(
      "encrypted_transfer_unsupported",
      409,
      `instance ${instance.instance_type}/${instance.instance_id} holds ${encryptedFiles} keyring- or caller-encrypted file(s); only tenant-encrypted files can be transferred yet`,
      {
        instance_type: instance.instance_type,
        instance_id: instance.instance_id,
        files: encryptedFiles,
      },
    );
  }
  const [tenantEncrypted] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(files)
    .where(and(instanceOf(files, plan.src.id, instance), eq(files.encryption, "tenant")));
  if (Number(tenantEncrypted?.n ?? 0) > 0) {
    if (!plan.crypto) throw encryptionUnavailable("tenant");
    await plan.crypto.assertAvailable("tenant");
  }
  const [inProgress] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(uploads)
    .where(
      and(
        instanceOf(uploads, plan.src.id, instance),
        isNull(uploads.completedFileId),
        gt(uploads.expiresAt, plan.now),
      ),
    );
  const pending = Number(inProgress?.n ?? 0);
  if (pending > 0) {
    throw new VolaError(
      "uploads_in_progress",
      409,
      `instance ${instance.instance_type}/${instance.instance_id} has ${pending} resumable upload(s) in progress; finish or delete them first`,
      {
        instance_type: instance.instance_type,
        instance_id: instance.instance_id,
        uploads: pending,
      },
    );
  }
}

/** Folders first (so the files' `folder_id` already points where it should), then the files and what hangs off them. */
async function moveInstance(
  tx: Tx,
  plan: Plan,
  instance: TransferInstance,
): Promise<{ counts: Counts; moved: MovedFile[] }> {
  const counts = zeroCounts();
  await moveFolders(tx, plan, instance, counts);
  const moved = await moveFiles(tx, plan, instance, counts);
  return { counts, moved };
}

/**
 * The destination folder a source path merges into: the LIVE one of that path when there is
 * one, else the newest soft-deleted one (several deleted rows may share a path).
 */
function mergeTargets(dstFolders: FolderRow[]): Map<string, FolderRow> {
  const byPath = new Map<string, FolderRow>();
  for (const folder of dstFolders) {
    const current = byPath.get(folder.path);
    if (
      !current ||
      (current.deletedAt !== null &&
        (folder.deletedAt === null || folder.createdAt > current.createdAt))
    ) {
      byPath.set(folder.path, folder);
    }
  }
  return byPath;
}

async function moveFolders(
  tx: Tx,
  plan: Plan,
  instance: TransferInstance,
  counts: Counts,
): Promise<void> {
  const srcFolders = await tx
    .select()
    .from(folders)
    .where(instanceOf(folders, plan.src.id, instance))
    .orderBy(folders.path, folders.createdAt);
  if (srcFolders.length === 0) return;
  const dstFolders = await tx
    .select()
    .from(folders)
    .where(instanceOf(folders, plan.dst.id, instance));
  const targets = mergeTargets(dstFolders);
  const merged = new Map<string, FolderRow>(); // source id → destination folder
  const moving: FolderRow[] = [];
  for (const folder of srcFolders) {
    const target = targets.get(folder.path);
    if (target) merged.set(folder.id, target);
    else moving.push(folder);
  }
  counts.folders += srcFolders.length;
  counts.mergedFolders += merged.size;

  // Re-point everything that hangs off a merged source folder BEFORE deleting it:
  // `folders.parent_id` and `share_links.folder_id` cascade, `files.folder_id` and
  // `uploads.folder_id` would go NULL (the root).
  for (const [sourceId, target] of merged) {
    await tx.update(files).set({ folderId: target.id }).where(eq(files.folderId, sourceId));
    await tx.update(folders).set({ parentId: target.id }).where(eq(folders.parentId, sourceId));
    await tx
      .update(shareLinks)
      .set({ folderId: target.id })
      .where(eq(shareLinks.folderId, sourceId));
    await tx.update(uploads).set({ folderId: target.id }).where(eq(uploads.folderId, sourceId));
  }
  // A live source folder revives the deleted destination folder it merged into.
  const revive = [...merged.entries()]
    .filter(([sourceId, target]) => {
      const source = srcFolders.find((f) => f.id === sourceId);
      return source?.deletedAt === null && target.deletedAt !== null;
    })
    .map(([, target]) => target.id);
  if (revive.length > 0) {
    await tx
      .update(folders)
      .set({ deletedAt: null, deletedBy: null, updatedAt: plan.now })
      .where(inArray(folders.id, [...new Set(revive)]));
  }
  if (merged.size > 0) {
    await tx.delete(folders).where(inArray(folders.id, [...merged.keys()]));
  }

  if (moving.length > 0) {
    await tx
      .update(folders)
      .set({
        tenantId: plan.dst.id,
        createdBy: mapUsers(folders.createdBy, plan.userMap),
        deletedBy: mapUsers(folders.deletedBy, plan.userMap),
      })
      .where(
        inArray(
          folders.id,
          moving.map((f) => f.id),
        ),
      );
  }
  // Share links of the moved folders and of the folders merged into: they are the source
  // tenant's rows still, now pointing at destination folders.
  const folderIds = [
    ...new Set([...moving.map((f) => f.id), ...[...merged.values()].map((f) => f.id)]),
  ];
  if (folderIds.length > 0) {
    const shares = await tx
      .update(shareLinks)
      .set({ tenantId: plan.dst.id, createdBy: mapUsers(shareLinks.createdBy, plan.userMap) })
      .where(and(eq(shareLinks.tenantId, plan.src.id), inArray(shareLinks.folderId, folderIds)))
      .returning({ id: shareLinks.id });
    counts.shares += shares.length;
  }
}

/**
 * Every file row of the instance — live, soft-deleted, every version — changes tenant in one
 * UPDATE; then the rows that hang off them (share links, processing jobs, OCR metadata) and
 * the instance's finished uploads follow, found through the files now on the destination.
 */
async function moveFiles(
  tx: Tx,
  plan: Plan,
  instance: TransferInstance,
  counts: Counts,
): Promise<MovedFile[]> {
  // The keys of `tenant`-encrypted files (every version, the soft-deleted too) are re-wrapped
  // for the destination BEFORE the rows change tenant; the metadata record is bound to the
  // file id only and needs nothing.
  const sealed = await tx
    .select({
      id: files.id,
      tenantId: files.tenantId,
      encryption: files.encryption,
      fkCt: files.fkCt,
      keyringId: files.keyringId,
    })
    .from(files)
    .where(and(instanceOf(files, plan.src.id, instance), eq(files.encryption, "tenant")));
  for (const row of sealed) {
    if (!plan.crypto) throw encryptionUnavailable("tenant");
    const fkCt = await plan.crypto.rewrapForTenant(row, plan.dst.id);
    await tx.update(files).set({ fkCt }).where(eq(files.id, row.id));
    counts.rewrapped++;
  }
  const movedRows = await tx
    .update(files)
    .set({
      tenantId: plan.dst.id,
      createdBy: mapUsers(files.createdBy, plan.userMap),
      deletedBy: mapUsers(files.deletedBy, plan.userMap),
      lastAccessedBy: mapUsers(files.lastAccessedBy, plan.userMap),
    })
    .where(instanceOf(files, plan.src.id, instance))
    .returning({ id: files.id, folderId: files.folderId });
  counts.files += movedRows.length;
  const moved: MovedFile[] = movedRows.map((row) => ({
    instanceType: instance.instance_type,
    instanceId: instance.instance_id,
    id: row.id,
    folderId: row.folderId,
  }));

  const dstFiles = tx
    .select({ id: files.id })
    .from(files)
    .where(instanceOf(files, plan.dst.id, instance));
  const shares = await tx
    .update(shareLinks)
    .set({ tenantId: plan.dst.id, createdBy: mapUsers(shareLinks.createdBy, plan.userMap) })
    .where(and(eq(shareLinks.tenantId, plan.src.id), inArray(shareLinks.fileId, dstFiles)))
    .returning({ id: shareLinks.id });
  counts.shares += shares.length;
  const jobs = await tx
    .update(processingJobs)
    .set({ tenantId: plan.dst.id })
    .where(and(eq(processingJobs.tenantId, plan.src.id), inArray(processingJobs.fileId, dstFiles)))
    .returning({ id: processingJobs.id });
  counts.jobs += jobs.length;
  const metadata = await tx
    .update(fileMetadata)
    .set({ tenantId: plan.dst.id })
    .where(and(eq(fileMetadata.tenantId, plan.src.id), inArray(fileMetadata.fileId, dstFiles)))
    .returning({ id: fileMetadata.fileId });
  counts.metadata += metadata.length;
  // Finished or expired uploads of the instance (`refuseUnmovable` left no other kind).
  const finished = await tx
    .update(uploads)
    .set({ tenantId: plan.dst.id, createdBy: mapUsers(uploads.createdBy, plan.userMap) })
    .where(instanceOf(uploads, plan.src.id, instance))
    .returning({ id: uploads.id });
  counts.uploads += finished.length;
  return moved;
}

/** Statistics after the commit: the source's instance snapshots go, the destination's are computed, both tenant snapshots too. */
async function refreshStats(deps: TransferDeps, plan: Plan): Promise<void> {
  const stats = { db: deps.db, logger: deps.logger, now: deps.now };
  for (const instance of plan.instances) {
    await deps.db
      .delete(tenantStats)
      .where(
        and(
          eq(tenantStats.tenantId, plan.src.id),
          eq(tenantStats.scope, "instance"),
          eq(tenantStats.instanceType, instance.instance_type),
          eq(tenantStats.instanceId, instance.instance_id),
        ),
      );
    await computeStats(stats, {
      tenantId: plan.dst.id,
      scope: "instance",
      instanceType: instance.instance_type,
      instanceId: instance.instance_id,
    });
  }
  await computeStats(stats, { tenantId: plan.src.id, scope: "tenant" });
  await computeStats(stats, { tenantId: plan.dst.id, scope: "tenant" });
}

/**
 * Tells both sides: on the source tenant's channel every moved file is `purged` (a
 * subscriber there no longer finds the row and removes it), on the destination's it is
 * `created` (a subscriber reads the row and upserts it).
 */
async function announce(deps: TransferDeps, plan: Plan, moved: MovedFile[]): Promise<void> {
  if (!deps.events || moved.length === 0) return;
  const publisher = { events: deps.events, logger: deps.logger };
  for (const instance of plan.instances) {
    const rows = moved.filter(
      (f) => f.instanceType === instance.instance_type && f.instanceId === instance.instance_id,
    );
    const scope = { instanceType: instance.instance_type, instanceId: instance.instance_id };
    await publishFileEvents(publisher, { ...scope, tenantId: plan.src.id, kind: "purged" }, rows);
    await publishFileEvents(publisher, { ...scope, tenantId: plan.dst.id, kind: "created" }, rows);
  }
}
