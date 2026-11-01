import {
  type Capabilities,
  type FilterNode,
  type ListResponse,
  MAX_PAGE_LIMIT,
  type Row,
  type SchemaDoc,
  type SortKey,
  SUPPORTED_OPS,
  UdcError,
} from "@jsudc/core";
import type { Source, SourceListRequest } from "@jsudc/server";
import { LOOKUP_SECTIONS } from "@vola/core";
import { and, count, eq, gt, isNull, lt, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { type BoundTenantContext, requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { type FileRow, files, folders } from "../db/schema.js";
import { decodePageCursor, encodePageCursor, type PageCursor } from "./cursor.js";
import {
  coerce,
  pinnedValue,
  type SqlField,
  SqlFilterCompiler,
  schemaOf,
  withoutTopLevel,
} from "./sql-filter.js";

/** The name of the collection under `/udc`. */
export const FILES_COLLECTION = "files";
/** What an encrypted file is called in a row until phase 6 decrypts its name under an unlock. */
export const ENCRYPTED_FILENAME = "<encrypted>";
/** The filter every `list` needs (a top-level `eq`); without it the list is empty. */
export const INSTANCE_TYPE_FILTER = "instance_type";
/** The optional filter narrowing a list to one instance. */
export const INSTANCE_ID_FILTER = "instance_id";
/** `eq true`: soft-deleted files are listed too. */
export const INCLUDE_DELETED_FILTER = "include_deleted";
export const FILES_DEFAULT_PAGE_SIZE = 50;
export const FILES_DEFAULT_SORT: SortKey = { field: "created_at", dir: "desc" };

/** One record of the query: the file and the path of its folder (`null` at the root). */
export interface FileRecord {
  file: FileRow;
  folderPath: string | null;
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
  decorateRow?: DecorateRow | undefined;
}

export const FILES_SOURCE_CAPABILITIES: Capabilities = {
  mutate: false,
  subscribe: false,
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
        description: "Aggregate state of the processing jobs (plan 4.1); null until then",
      },
      kind: "text",
      value: () => null,
      sortable: false,
    },
    thumb_url: {
      def: {
        type: "image",
        description: "256px thumbnail (plan 4.1; 404 until then); null for an encrypted file",
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
 */
export class FilesCollectionSource implements Source {
  readonly capabilities = FILES_SOURCE_CAPABILITIES;
  readonly kind = "postgres_jsonb" as const;
  private readonly db: Database;
  private readonly fields: Record<string, FileField>;
  private readonly schema: SchemaDoc;
  private readonly compiler: SqlFilterCompiler;
  private readonly decorateRow: DecorateRow | undefined;

  constructor(options: FilesSourceOptions) {
    this.db = options.db;
    this.fields = filesFields(options.prefix.replace(/\/+$/, ""));
    this.schema = schemaOf(this.fields);
    this.compiler = new SqlFilterCompiler(this.fields);
    this.decorateRow = options.decorateRow;
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
      .select({ file: files, folderPath: folders.path })
      .from(files)
      .leftJoin(folders, eq(folders.id, files.folderId))
      .$dynamic();
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
    for (const record of records) {
      const row: Row = { __meta: { id: record.file.id, version: 1 } };
      for (const [name, field] of Object.entries(this.fields)) row[name] = field.value(record);
      rows.push(this.decorateRow ? await this.decorateRow(row, record.file, tenant) : row);
    }
    return rows;
  }
}
