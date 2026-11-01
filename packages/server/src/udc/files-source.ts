import {
  type Capabilities,
  type Condition,
  evaluateFilter,
  type FilterNode,
  isCondition,
  type ListResponse,
  MAX_PAGE_LIMIT,
  type Row,
  type SchemaDoc,
  type SortKey,
  SUPPORTED_OPS,
  UdcError,
} from "@jsudc/core";
import type { SourceListRequest } from "@jsudc/server";
import { LOOKUP_SECTIONS, type ProcessingStatus } from "@vola/core";
import { and, count, eq, gt, isNull, lt, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { type BoundTenantContext, requireTenant, runWithTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { type FileRow, fileMetadata, files, folders } from "../db/schema.js";
import type { FileEvent, FileEventBus } from "../events/bus.js";
import { extensionOf } from "../files/filename.js";
import { kindForMime } from "../files/mime.js";
import type { EncryptionService } from "../services/encryption.js";
import { processingStatusByFile } from "../services/processing.js";
import { decodePageCursor, encodePageCursor, type PageCursor } from "./cursor.js";
import {
  coerce,
  pinnedValue,
  type SqlField,
  SqlFilterCompiler,
  schemaOf,
  withoutTopLevel,
} from "./sql-filter.js";
import type { RowSink, SubscribableSource, Subscription } from "./subscribable.js";

/** The name of the collection under `/udc`. */
export const FILES_COLLECTION = "files";
/**
 * What an encrypted file is called in a row when its name cannot be decrypted here: a
 * `keyring` file without an unlock (phase 6.2), a `tenant` file without the key file. With
 * the key (`tenant` mode) the real name, type, extension and kind are put back (`toRows`).
 */
export const ENCRYPTED_FILENAME = "<encrypted>";
/** The filter every `list` needs (a top-level `eq`); without it the list is empty. */
export const INSTANCE_TYPE_FILTER = "instance_type";
/** The optional filter narrowing a list to one instance. */
export const INSTANCE_ID_FILTER = "instance_id";
/** `eq true`: soft-deleted files are listed too. */
export const INCLUDE_DELETED_FILTER = "include_deleted";
/**
 * Row: whether OCR text was extracted. Filter: `contains <words>` (or `eq <words>`) is a
 * full-text search over the text, `plainto_tsquery('simple', …)` against the GIN-indexed
 * `ocr_tsv`; `eq true|false`, `is_not_null` / `is_null` select files with / without text.
 */
export const OCR_FILTER = "ocr";
export const FILES_DEFAULT_PAGE_SIZE = 50;
export const FILES_DEFAULT_SORT: SortKey = { field: "created_at", dir: "desc" };

/** One record of the query: the file, the path of its folder (`null` at the root), its OCR flag. */
export interface FileRecord {
  file: FileRow;
  folderPath: string | null;
  /** `vola_file_metadata.ocr_text` is there and not empty. */
  hasOcr: boolean;
  /** The aggregate of the file's processing jobs, attached by `toRows` (one query per page). */
  processingStatus?: ProcessingStatus | null | undefined;
}

/**
 * The phase-6 hook: called for every row after the built-in masking, with the stored row and
 * the tenant of the request. An unlock session replaces `<encrypted>` with the real name here.
 */
export type DecorateRow = (
  row: Row,
  file: FileRow,
  tenant: BoundTenantContext,
) => Row | Promise<Row>;

export interface FilesSourceOptions {
  db: Database;
  /** Mount prefix of the vola routes (`/vola`), for `download_url` and `thumb_url`. */
  prefix: string;
  /** Runs AFTER the built-in decryption of `tenant` rows (a host's own hook, unlock sessions). */
  decorateRow?: DecorateRow | undefined;
  /** Decrypts the metadata of `tenant`-encrypted rows (name, type); absent: they stay masked. */
  crypto?: EncryptionService | undefined;
  /**
   * The bus file changes arrive on; with it the collection is subscribable
   * (`capabilities.subscribe`), without it `subscribe` is `unsupported_op`.
   */
  events?: FileEventBus | undefined;
  logger?: FastifyBaseLogger | undefined;
}

export const FILES_SOURCE_CAPABILITIES: Capabilities = {
  mutate: false,
  subscribe: true,
  total_count: true,
  schema_edit: false,
  config_edit: false,
  reindex: false,
  tree_reparent: false,
  source_yaml: false,
  paging: ["cursor"],
  supported_filter_ops: [...SUPPORTED_OPS],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A field of the collection: its UDC definition, its SQL and its value in a record. */
export interface FileField extends SqlField {
  value: (record: FileRecord) => unknown;
}

const encrypted = (file: FileRow) => file.encryption !== "none";

// Filters and sorts see the SAME masked values the rows carry: the name, MIME type and
// extension of an encrypted file never reach SQL comparisons or a cursor.
const maskedName = sql<string>`case when ${files.encryption} = 'none' then ${files.filename} else ${ENCRYPTED_FILENAME} end`;
const maskedMime = sql<
  string | null
>`case when ${files.encryption} = 'none' then ${files.mimeType} end`;
const maskedExtension = sql<
  string | null
>`case when ${files.encryption} = 'none' then ${files.extension} end`;
const folderPath = sql<string>`coalesce(${folders.path}, '')`;
const isDeleted = sql<boolean>`${files.deletedAt} is not null`;
const hasOcr = sql<boolean>`coalesce(${fileMetadata.ocrText}, '') <> ''`;

/** `true` / `false` of a filter value, `null` for anything that is not one. */
function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return null;
}

/** `true` when the condition searches the OCR TEXT (not the yes/no flag). */
function isOcrTextSearch(c: Condition): boolean {
  if (c.field !== OCR_FILTER) return false;
  if (c.op === "contains") return true;
  return (c.op === "eq" || c.op === "neq") && booleanValue(c.value) === null;
}

/** `true` when the filter has a condition the rows alone cannot answer (an OCR text search). */
export function needsSqlMatch(node: FilterNode | undefined): boolean {
  if (!node) return false;
  if (isCondition(node)) return isOcrTextSearch(node);
  if ("and" in node) return node.and.some(needsSqlMatch);
  if ("or" in node) return node.or.some(needsSqlMatch);
  return needsSqlMatch(node.not);
}

/** The SQL of a condition on `ocr`: a full-text match, or the yes/no flag. */
function ocrCondition(c: Condition): SQL | undefined {
  if (c.op === "is_null") return sql`not ${hasOcr}`;
  if (c.op === "is_not_null") return hasOcr;
  if (c.op === "contains" || c.op === "eq" || c.op === "neq") {
    const flag = c.op === "contains" ? null : booleanValue(c.value);
    if (flag !== null) return flag === (c.op === "eq") ? hasOcr : sql`not ${hasOcr}`;
    if (c.value === null || c.value === undefined || typeof c.value === "object") {
      throw new UdcError("validation_error", `${OCR_FILTER} needs the words to search for`);
    }
    const words = String(c.value).trim();
    if (words === "") return sql`false`;
    const match = sql`${fileMetadata.ocrTsv} @@ plainto_tsquery('simple', ${words})`;
    return c.op === "neq" ? sql`not coalesce(${match}, false)` : match;
  }
  throw new UdcError(
    "validation_error",
    `"${c.op}" is not an op of ${OCR_FILTER} (contains, eq, neq, is_null, is_not_null)`,
    { field: OCR_FILTER },
  );
}

const text = (
  expr: SQLWrapper | undefined,
  value: FileField["value"],
  def: Omit<FileField["def"], "type">,
  sortable = false,
): FileField => ({ def: { type: "string", ...def }, kind: "text", expr, value, sortable });

const time = (
  expr: SQLWrapper,
  value: FileField["value"],
  def: Omit<FileField["def"], "type">,
  sortable = false,
): FileField => ({ def: { type: "datetime", ...def }, kind: "time", expr, value, sortable });

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** What a sortable field puts into a cursor and how that comes back as a SQL parameter. */
interface SortableField {
  expr: SQLWrapper;
  cursorValue: (record: FileRecord) => string | number;
  param: (value: string | number) => unknown;
}

/** The sort keys the collection accepts (each with `id` as the tiebreak). */
/** One live subscription of the `files` collection. */
interface FilesSubscription {
  tenant: BoundTenantContext;
  instanceType: string;
  /** `null`: every instance of the type (an admin's view). */
  instanceId: string | null;
  includeDeleted: boolean;
  /** The request's filter without `include_deleted`, evaluated against the decorated row. */
  filter: FilterNode | undefined;
  sink: RowSink;
}

/** The subscriptions of one tenant, sharing one bus subscription and one dispatch queue. */
interface TenantGroup {
  subscriptions: Set<FilesSubscription>;
  /** Resolves to the function that ends the bus subscription. */
  feed: Promise<() => Promise<void>>;
  /** Events are dispatched one after another, so every sink sees them in publish order. */
  queue: Promise<void>;
}

/** What one subscription gets for one event, decided before anything is sent. */
type Decision = { sink: RowSink; upsert: Row } | { sink: RowSink; remove: string } | null;

export const FILES_SORTABLE: Record<string, SortableField> = {
  created_at: {
    expr: files.createdAt,
    cursorValue: (r) => r.file.createdAt.getTime(),
    param: (v) => new Date(Number(v)),
  },
  filename: {
    expr: maskedName,
    cursorValue: (r) => (encrypted(r.file) ? ENCRYPTED_FILENAME : r.file.filename),
    param: (v) => String(v),
  },
  size: {
    expr: files.size,
    cursorValue: (r) => Number(r.file.size),
    param: (v) => Number(v),
  },
};

/** The fields of the `files` collection, in the order `describe` lists them. */
export function filesFields(prefix: string): Record<string, FileField> {
  const base = (f: FileRow) => `${prefix}/files/${f.instanceType}/${f.instanceId}/${f.id}`;
  return {
    id: text(files.id, (r) => r.file.id, { required: true, description: "File id (UUID v7)" }),
    instance_type: text(files.instanceType, (r) => r.file.instanceType, {
      required: true,
      index: true,
      description: "The host application's object type the file hangs off (tickets, users, …)",
    }),
    instance_id: text(files.instanceId, (r) => r.file.instanceId, {
      required: true,
      index: true,
      description: "Which instance (UUID)",
    }),
    filename: text(
      maskedName,
      (r) => (encrypted(r.file) ? ENCRYPTED_FILENAME : r.file.filename),
      {
        length: 255,
        required: true,
        index: true,
        description: "Name; <encrypted> for an encrypted file",
      },
      true,
    ),
    kind: {
      def: {
        type: "lookup",
        ref: LOOKUP_SECTIONS.fileKinds,
        required: true,
        description: "What the file is, derived from its MIME type (image, document, …)",
      },
      kind: "text",
      expr: files.kind,
      value: (r) => r.file.kind,
      sortable: false,
    },
    size: {
      def: { type: "integer", min: 0, required: true, description: "Bytes" },
      kind: "number",
      expr: files.size,
      value: (r) => Number(r.file.size),
    },
    extension: text(maskedExtension, (r) => (encrypted(r.file) ? null : r.file.extension), {
      length: 50,
      description: "Lowercase, without the dot; null for an encrypted file",
    }),
    mime_type: text(maskedMime, (r) => (encrypted(r.file) ? null : r.file.mimeType), {
      length: 255,
      description: "MIME type; null for an encrypted file",
    }),
    folder_path: text(folderPath, (r) => r.folderPath ?? "", {
      description:
        'The folder inside the instance ("" at the root); a filter lists that level only',
    }),
    folder_id: text(files.folderId, (r) => r.file.folderId, { description: "null at the root" }),
    slug: text(files.slug, (r) => r.file.slug, {
      length: 100,
      description: "Named file of the instance",
    }),
    hash: text(files.hash, (r) => r.file.hash, {
      length: 64,
      description: "SHA-256 of the stored bytes",
    }),
    is_public: {
      def: { type: "bool", description: "Readable by any authenticated tenant" },
      kind: "bool",
      expr: files.isPublic,
      value: (r) => r.file.isPublic,
      sortable: false,
    },
    is_global_public: {
      def: { type: "bool", description: "Served by GET /public/:fileId without a key" },
      kind: "bool",
      expr: files.isGlobalPublic,
      value: (r) => r.file.isGlobalPublic,
      sortable: false,
    },
    encryption: {
      def: {
        type: "lookup",
        ref: LOOKUP_SECTIONS.encryptionModes,
        required: true,
        description: "none | tenant | keyring | caller",
      },
      kind: "text",
      expr: files.encryption,
      value: (r) => r.file.encryption,
      sortable: false,
    },
    processing_status: {
      def: {
        type: "lookup",
        ref: LOOKUP_SECTIONS.processingStatuses,
        description:
          "Aggregate of the file's processing jobs, worst first (FAILED > RUNNING > PENDING > DONE); null when none was created",
      },
      kind: "text",
      value: (r) => r.processingStatus ?? null,
      sortable: false,
    },
    thumb_url: {
      def: {
        type: "image",
        description:
          "256px WebP thumbnail (GET …/thumb/256: 200 ready, 202 generating, 404 no_thumbnail); null for an encrypted file",
      },
      kind: "text",
      value: (r) => (encrypted(r.file) ? null : `${base(r.file)}/thumb/256`),
      sortable: false,
    },
    download_url: {
      def: { type: "string", description: "GET with the API key streams the bytes" },
      kind: "text",
      value: (r) => base(r.file),
      sortable: false,
    },
    created_by: text(files.createdBy, (r) => r.file.createdBy, {
      length: 255,
      description: "X-User-Id of the upload",
    }),
    created_at: time(
      files.createdAt,
      (r) => iso(r.file.createdAt),
      { required: true, index: true },
      true,
    ),
    updated_at: time(files.updatedAt, (r) => iso(r.file.updatedAt), {}),
    deleted_at: time(files.deletedAt, (r) => iso(r.file.deletedAt), {
      description: "Set by a soft delete; such rows are listed only with include_deleted",
    }),
    include_deleted: {
      def: {
        type: "bool",
        description:
          "Filter: `eq true` lists soft-deleted files too (live ones only otherwise). Row: whether the file is soft-deleted.",
      },
      kind: "bool",
      expr: isDeleted,
      value: (r) => r.file.deletedAt !== null,
      sortable: false,
    },
    [OCR_FILTER]: {
      def: {
        type: "bool",
        description:
          "Row: whether OCR text was extracted (yes/no). Filter: `contains <words>` searches the OCR text (full-text, every language alike); `eq true|false` / `is_not_null` / `is_null` select files with or without text.",
      },
      kind: "bool",
      expr: hasOcr,
      value: (r) => r.hasOcr,
      sortable: false,
      condition: ocrCondition,
    },
  };
}

/**
 * The read-only UDC source over `vola_file` — the file browser of vola-spp, as data. Every
 * query runs inside the tenant of the request (the AsyncLocalStorage context the UDC auth hook
 * set); a `list` without a top-level `instance_type eq` answers an empty page (the browser
 * asks for one type of object, never the whole tenant), `instance_id` narrows it to one
 * instance (an admin may leave it out: every id of the type). Live files unless
 * `include_deleted eq true`. One sort key (`created_at`, `filename` or `size`), keyset
 * cursor paging with `id` as the tiebreak, an exact `total`. The name, MIME type and
 * extension of an encrypted file are masked in rows, filters, sorts and cursors alike;
 * `decorateRow` (phase 6) may put the real ones back under an unlock.
 *
 * `subscribe` follows the same rows live (see `SubscribableSource`): a subscription pins
 * `instance_type` (required) and optionally `instance_id`; every file event of the tenant
 * that lands in that instance is read back from the database and offered to the
 * subscription's full filter — a row that matches is an `upsert`, one that stopped matching
 * (deleted, purged, moved to another folder, renamed out of a `filename` filter) a `remove`.
 * Events of other tenants never reach a subscription: the bus is subscribed per tenant and
 * the row is read under the tenant's id.
 */
export class FilesCollectionSource implements SubscribableSource {
  readonly capabilities: Capabilities;
  readonly kind = "postgres_jsonb" as const;
  private readonly db: Database;
  private readonly fields: Record<string, FileField>;
  private readonly schema: SchemaDoc;
  private readonly compiler: SqlFilterCompiler;
  private readonly decorateRow: DecorateRow | undefined;
  private readonly crypto: EncryptionService | undefined;
  private readonly events: FileEventBus | undefined;
  private readonly logger: FastifyBaseLogger | undefined;
  private readonly groups = new Map<string, TenantGroup>();

  constructor(options: FilesSourceOptions) {
    this.db = options.db;
    this.fields = filesFields(options.prefix.replace(/\/+$/, ""));
    this.schema = schemaOf(this.fields);
    this.compiler = new SqlFilterCompiler(this.fields);
    this.decorateRow = options.decorateRow;
    this.crypto = options.crypto;
    this.events = options.events;
    this.logger = options.logger;
    this.capabilities = { ...FILES_SOURCE_CAPABILITIES, subscribe: this.events !== undefined };
  }

  async describe(): Promise<SchemaDoc> {
    return this.schema;
  }

  async list(req: SourceListRequest): Promise<ListResponse> {
    const tenant = requireTenant();
    if (req.page?.offset) {
      throw new UdcError("validation_error", "this collection pages by cursor, not by offset");
    }
    const limit = Math.max(1, Math.min(req.page?.limit ?? FILES_DEFAULT_PAGE_SIZE, MAX_PAGE_LIMIT));
    if (!pinnedValue(req.filter, INSTANCE_TYPE_FILTER)) {
      return { rows: [], next_cursor: null, total: 0 };
    }
    const sort = this.sortKey(req.sort);
    const sortable = FILES_SORTABLE[sort.field] as SortableField;
    const dir = sort.dir === "desc" ? "desc" : "asc";
    const where = this.where(tenant, req.filter);
    const cursor = req.page?.cursor ? decodePageCursor(req.page.cursor) : null;
    if (cursor && (cursor.field !== sort.field || cursor.dir !== dir)) {
      throw new UdcError("validation_error", "cursor: produced under another sort");
    }
    const [records, totals] = await Promise.all([
      this.select()
        .where(and(where, cursor ? this.after(sortable, cursor) : undefined))
        .orderBy(
          ...this.compiler.orderBy([{ field: sort.field, dir }], (d) => [
            d === "desc" ? sql`${files.id} desc` : sql`${files.id} asc`,
          ]),
        )
        .limit(limit + 1),
      this.db
        .select({ total: count() })
        .from(files)
        .leftJoin(folders, eq(folders.id, files.folderId))
        .leftJoin(fileMetadata, eq(fileMetadata.fileId, files.id))
        .where(where),
    ]);
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: await this.toRows(page, tenant),
      next_cursor:
        records.length > limit && last
          ? encodePageCursor({
              field: sort.field,
              dir,
              value: sortable.cursorValue(last),
              id: last.file.id,
            })
          : null,
      total: Number(totals[0]?.total ?? 0),
    };
  }

  /** One live file of the tenant by id, under the same masking as `list`. */
  async read(id: string): Promise<Row> {
    const tenant = requireTenant();
    const records = UUID_RE.test(id)
      ? await this.select()
          .where(
            and(
              eq(files.tenantId, tenant.tenantId),
              eq(files.id, id.toLowerCase()),
              isNull(files.deletedAt),
            ),
          )
          .limit(1)
      : [];
    const [row] = await this.toRows(records, tenant);
    if (!row) throw new UdcError("not_found", `no file ${id}`);
    return row;
  }

  /**
   * Follows the rows of `filter` live for the current tenant. The filter is checked like a
   * `list`'s (unknown field or op: `validation_error`) and must pin `instance_type`.
   * Resolves once the tenant's events are flowing; `internal` when the feed cannot be
   * subscribed (Redis down).
   */
  async subscribe(filter: FilterNode | undefined, sink: RowSink): Promise<Subscription> {
    const tenant = requireTenant();
    const events = this.events;
    if (!events) {
      throw new UdcError("unsupported_op", "this collection has no event feed to subscribe to");
    }
    const instanceType = pinnedValue(filter, INSTANCE_TYPE_FILTER);
    if (!instanceType) {
      throw new UdcError(
        "validation_error",
        `a subscription needs a top-level "${INSTANCE_TYPE_FILTER}" eq filter`,
        { field: INSTANCE_TYPE_FILTER },
      );
    }
    const includeDeleted = pinnedValue(filter, INCLUDE_DELETED_FILTER);
    const rest = withoutTopLevel(filter, INCLUDE_DELETED_FILTER);
    if (rest) this.compiler.compile(rest); // the same validation a list gets
    const subscription: FilesSubscription = {
      tenant,
      instanceType,
      instanceId: pinnedValue(filter, INSTANCE_ID_FILTER)?.toLowerCase() ?? null,
      includeDeleted:
        includeDeleted !== null && coerce(INCLUDE_DELETED_FILTER, "bool", includeDeleted) === true,
      filter: rest,
      sink,
    };

    let group = this.groups.get(tenant.tenantId);
    if (!group) {
      const created: TenantGroup = {
        subscriptions: new Set(),
        queue: Promise.resolve(),
        feed: events.subscribe(tenant.tenantId, (event) => this.enqueue(created, event)),
      };
      group = created;
      this.groups.set(tenant.tenantId, group);
    }
    const members = group;
    members.subscriptions.add(subscription);
    let unsubscribe: () => Promise<void>;
    try {
      unsubscribe = await members.feed;
    } catch (error) {
      this.forget(tenant.tenantId, members, subscription);
      this.logger?.error({ err: error, tenant: tenant.tenantSlug }, "file event feed unavailable");
      throw new UdcError("internal", "event feed unavailable");
    }
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        if (this.forget(tenant.tenantId, members, subscription)) await unsubscribe();
      },
    };
  }

  /** Subscriptions per tenant id. */
  subscriptions(): Record<string, number> {
    return Object.fromEntries([...this.groups].map(([id, g]) => [id, g.subscriptions.size]));
  }

  /** Resolves when every event received so far has been dispatched. */
  async idle(): Promise<void> {
    await Promise.all([...this.groups.values()].map((g) => g.queue));
  }

  /** Drops `subscription`; `true` when it was the tenant's last one (its feed must end). */
  private forget(tenantId: string, group: TenantGroup, subscription: FilesSubscription): boolean {
    group.subscriptions.delete(subscription);
    if (group.subscriptions.size > 0 || this.groups.get(tenantId) !== group) return false;
    this.groups.delete(tenantId);
    return true;
  }

  private enqueue(group: TenantGroup, event: FileEvent): void {
    group.queue = group.queue
      .then(() => this.dispatch(group, event))
      .catch((error) =>
        this.logger?.error({ err: error, file: event.fileId }, "file event not dispatched"),
      );
  }

  /**
   * One event for every subscription of the tenant it names: the row is read ONCE (soft-
   * deleted too; `null` once purged), decorated per subscription, and the decisions are then
   * emitted in one synchronous pass so a connection's buffer accounting sees them together.
   */
  private async dispatch(group: TenantGroup, event: FileEvent): Promise<void> {
    const targets = [...group.subscriptions].filter(
      (s) =>
        s.instanceType === event.instanceType &&
        (s.instanceId === null || s.instanceId === event.instanceId),
    );
    if (targets.length === 0) return;
    const record = await this.record(event.tenantId, event.fileId);
    const decisions: Decision[] = [];
    for (const target of targets) {
      decisions.push(await this.decide(target, record, event));
    }
    for (const decision of decisions) {
      if (!decision) continue;
      if ("upsert" in decision) decision.sink.upsert(decision.upsert, event.kind);
      else decision.sink.remove(decision.remove, event.kind);
    }
  }

  private async decide(
    target: FilesSubscription,
    record: FileRecord | null,
    event: FileEvent,
  ): Promise<Decision> {
    // A row the subscription cannot have: nothing to upsert, and for a new file nothing to remove.
    const gone = !record || (record.file.deletedAt !== null && !target.includeDeleted);
    if (!gone) {
      // Under the SUBSCRIPTION's context, not the one of whatever request caused the event:
      // a keyring row is revealed by the subscriber's own unlock token (6.2), never the uploader's.
      const [row] = await runWithTenant(target.tenant, () => this.toRows([record], target.tenant));
      const matched = needsSqlMatch(target.filter)
        ? await this.matchesInSql(
            target.tenant,
            record.file.id,
            target.filter,
            target.includeDeleted,
          )
        : row !== undefined && this.matches(target.filter, row);
      if (row && matched) return { sink: target.sink, upsert: row };
    }
    return event.kind === "created" ? null : { sink: target.sink, remove: event.fileId };
  }

  private matches(filter: FilterNode | undefined, row: Row): boolean {
    try {
      return evaluateFilter(filter, row);
    } catch {
      return false; // a value the evaluator rejects (checked at subscribe time; defensive)
    }
  }

  /** The file `fileId` of `tenantId`, soft-deleted or not; `null` when purged. */
  private async record(tenantId: string, fileId: string): Promise<FileRecord | null> {
    if (!UUID_RE.test(fileId)) return null;
    const [record] = await this.select()
      .where(and(eq(files.tenantId, tenantId), eq(files.id, fileId.toLowerCase())))
      .limit(1);
    return record ?? null;
  }

  mutate(): Promise<Row> {
    return this.readOnly();
  }
  addField(): Promise<SchemaDoc> {
    return this.readOnly();
  }
  updateField(): Promise<SchemaDoc> {
    return this.readOnly();
  }
  softDeleteField(): Promise<SchemaDoc> {
    return this.readOnly();
  }

  private readOnly(): Promise<never> {
    return Promise.reject(
      new UdcError("unsupported_op", "files are managed through the REST API (/files, /uploads)"),
    );
  }

  /** The one sort key of a request, checked to be sortable; the default without one. */
  private sortKey(sort: SortKey[] | undefined): SortKey {
    if (!sort || sort.length === 0) return FILES_DEFAULT_SORT;
    if (sort.length > 1) {
      throw new UdcError("validation_error", "this collection sorts by one key at a time");
    }
    const key = sort[0] as SortKey;
    if (!FILES_SORTABLE[key.field]) {
      throw new UdcError(
        "validation_error",
        `field "${key.field}" cannot be sorted (created_at, filename or size)`,
        { field: key.field },
      );
    }
    return key;
  }

  private select() {
    return this.db
      .select({ file: files, folderPath: folders.path, hasOcr })
      .from(files)
      .leftJoin(folders, eq(folders.id, files.folderId))
      .leftJoin(fileMetadata, eq(fileMetadata.fileId, files.id))
      .$dynamic();
  }

  /**
   * Whether the file `fileId` of `tenantId` matches `filter` as a `list` would see it: the
   * check in SQL for a filter the row cannot answer (an OCR text search).
   */
  private async matchesInSql(
    tenant: BoundTenantContext,
    fileId: string,
    filter: FilterNode | undefined,
    includeDeleted: boolean,
  ): Promise<boolean> {
    const where = and(
      eq(files.tenantId, tenant.tenantId),
      eq(files.id, fileId),
      includeDeleted ? undefined : isNull(files.deletedAt),
      filter ? this.compiler.compile(filter) : undefined,
    );
    const [row] = await this.db
      .select({ id: files.id })
      .from(files)
      .leftJoin(folders, eq(folders.id, files.folderId))
      .leftJoin(fileMetadata, eq(fileMetadata.fileId, files.id))
      .where(where)
      .limit(1);
    return row !== undefined;
  }

  /** The tenant, the soft-delete rule and the request's filter (without `include_deleted`). */
  private where(tenant: BoundTenantContext, filter: FilterNode | undefined): SQL {
    const includeDeleted = pinnedValue(filter, INCLUDE_DELETED_FILTER);
    const rest = withoutTopLevel(filter, INCLUDE_DELETED_FILTER);
    const parts: (SQL | undefined)[] = [
      eq(files.tenantId, tenant.tenantId),
      includeDeleted && coerce(INCLUDE_DELETED_FILTER, "bool", includeDeleted) === true
        ? undefined
        : isNull(files.deletedAt),
      rest ? this.compiler.compile(rest) : undefined,
    ];
    return and(...parts) as SQL;
  }

  /** The keyset condition: rows after `cursor` in the sort's direction, `id` breaking ties. */
  private after(sortable: SortableField, cursor: PageCursor): SQL {
    const param = sortable.param(cursor.value);
    const e = sortable.expr as never;
    const cmp = cursor.dir === "desc" ? lt : gt;
    return or(cmp(e, param), and(eq(e, param), cmp(files.id, cursor.id))) as SQL;
  }

  private async toRows(records: FileRecord[], tenant: BoundTenantContext): Promise<Row[]> {
    const rows: Row[] = [];
    // One query for the page: the aggregate `processing_status` of every file in it.
    const statuses = await processingStatusByFile(
      this.db,
      records.map((r) => r.file.id),
    );
    for (const record of records) {
      record.processingStatus = statuses.get(record.file.id) ?? null;
      let row: Row = { __meta: { id: record.file.id, version: 1 } };
      for (const [name, field] of Object.entries(this.fields)) row[name] = field.value(record);
      row = await this.revealEncrypted(row, record.file);
      rows.push(this.decorateRow ? await this.decorateRow(row, record.file, tenant) : row);
    }
    return rows;
  }

  /**
   * The built-in decoration: the real name, MIME type, extension and kind of an encrypted
   * file whose metadata the server can open (`tenant` mode, key file present). Filters,
   * sorts and cursors keep working on the masked values — the real name is never in SQL.
   */
  private async revealEncrypted(row: Row, file: FileRow): Promise<Row> {
    if (!encrypted(file) || !this.crypto) return row;
    const meta = await this.crypto.reveal(file);
    if (!meta) return row;
    return {
      ...row,
      filename: meta.filename,
      mime_type: meta.mime,
      extension: extensionOf(meta.filename),
      kind: kindForMime(meta.mime),
    };
  }
}
