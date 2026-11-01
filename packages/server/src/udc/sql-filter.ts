import {
  type Condition,
  type FieldDef,
  type FilterNode,
  isCondition,
  type SchemaDoc,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import {
  and,
  between,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";

/** How a field's filter values are coerced before they reach SQL. */
export type FieldKind = "text" | "time" | "number" | "bool" | "json";

/** A field filters and sorts can name: its UDC definition and the SQL expression they compare. */
export interface SqlField {
  def: FieldDef;
  kind: FieldKind;
  /** What filters and sorts compare; absent for a field that is neither. */
  expr?: SQLWrapper | undefined;
  /** Default true; `false` for a field that may be filtered but not sorted. */
  sortable?: boolean | undefined;
  /**
   * A field that compiles its own conditions (a full-text search): called first for every
   * condition on it; `undefined` falls back to the generic handling of `expr` and `kind`.
   */
  condition?: ((c: Condition) => SQL | undefined) | undefined;
}

/** `%`, `_` and `\` of a LIKE pattern literal, escaped (PostgreSQL's default escape is `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The UDC schema of a field map: every field, in declaration order. */
export function schemaOf(fields: Record<string, SqlField>): SchemaDoc {
  const defs = Object.fromEntries(Object.entries(fields).map(([n, f]) => [n, f.def]));
  return { version: "v1", core_fields: [], fields: defs, field_order: Object.keys(defs) };
}

/** The conditions ANDed at the top of a filter tree (none inside an `or` / `not`). */
export function topLevel(node: FilterNode | undefined): Condition[] {
  if (!node) return [];
  if (isCondition(node)) return [node];
  if ("and" in node) return node.and.flatMap(topLevel);
  return [];
}

/** The value a top-level `eq` on `field` pins, as text; `null` when there is none. */
export function pinnedValue(node: FilterNode | undefined, field: string): string | null {
  for (const c of topLevel(node)) {
    if (c.field !== field || c.op !== "eq") continue;
    if (c.value === null || c.value === undefined || c.value === "") continue;
    if (typeof c.value === "object") continue;
    return String(c.value);
  }
  return null;
}

/** The filter tree without the top-level conditions on `field`; `undefined` when nothing is left. */
export function withoutTopLevel(
  node: FilterNode | undefined,
  field: string,
): FilterNode | undefined {
  if (!node) return undefined;
  if (isCondition(node)) return node.field === field ? undefined : node;
  if ("and" in node) {
    const rest = node.and
      .map((n) => withoutTopLevel(n, field))
      .filter((n): n is FilterNode => n !== undefined);
    if (rest.length === 0) return undefined;
    return rest.length === 1 ? (rest[0] as FilterNode) : { and: rest };
  }
  return node;
}

/**
 * Turns the UDC filter DSL and sort keys into Drizzle SQL over a map of fields, each with the
 * expression it compares (a column, or a `CASE` that masks it).
 */
export class SqlFilterCompiler {
  constructor(private readonly fields: Record<string, SqlField>) {}

  field(name: string): SqlField & { expr: SQLWrapper } {
    const field = this.fields[name];
    if (!field?.expr) {
      throw new UdcError("validation_error", `field "${name}" cannot be filtered or sorted`, {
        field: name,
      });
    }
    return field as SqlField & { expr: SQLWrapper };
  }

  /** The field of a sort key, checked to be sortable. */
  sortField(key: SortKey): SqlField & { expr: SQLWrapper } {
    const field = this.field(key.field);
    if (field.sortable === false) {
      throw new UdcError("validation_error", `field "${key.field}" cannot be sorted`, {
        field: key.field,
      });
    }
    return field;
  }

  /** ORDER BY for `sort`, then `tiebreak` (given the last key's direction). */
  orderBy(sort: SortKey[], tiebreak: (dir: "asc" | "desc") => SQL[]): SQL[] {
    const keys = sort.map((key) => {
      const { expr } = this.sortField(key);
      return key.dir === "desc" ? sql`${expr} desc` : sql`${expr} asc`;
    });
    return [...keys, ...tiebreak(sort.at(-1)?.dir === "desc" ? "desc" : "asc")];
  }

  /** Compiles a UDC filter tree into a WHERE clause over this collection's fields. */
  compile(node: FilterNode): SQL {
    if (!isCondition(node)) {
      if ("and" in node) return and(...node.and.map((n) => this.compile(n))) ?? sql`true`;
      if ("or" in node) return or(...node.or.map((n) => this.compile(n))) ?? sql`false`;
      return not(this.compile(node.not));
    }
    return this.condition(node);
  }

  private condition(c: Condition): SQL {
    const { expr, kind, condition } = this.field(c.field);
    const own = condition?.(c);
    if (own) return own;
    if (kind === "json" && c.op !== "is_null" && c.op !== "is_not_null") {
      throw new UdcError("validation_error", `${c.field} allows only is_null / is_not_null`);
    }
    const one = () => coerce(c.field, kind, c.value);
    const many = (): unknown[] => {
      if (!Array.isArray(c.value)) {
        throw new UdcError("validation_error", `"${c.op}" on ${c.field} needs an array`);
      }
      return c.value.map((v) => coerce(c.field, kind, v));
    };
    const text = (pattern: (v: string) => string): SQL => {
      if (kind !== "text") {
        throw new UdcError("validation_error", `"${c.op}" needs a text field, not ${c.field}`);
      }
      const value = pattern(escapeLike(String(c.value ?? "")));
      return c.case_insensitive ? ilike(expr as never, value) : like(expr as never, value);
    };
    // drizzle's operators take any SQL expression; the casts only quiet the column typing.
    const e = expr as never;
    switch (c.op) {
      case "eq":
        return eq(e, one());
      case "neq":
        return ne(e, one());
      case "gt":
        return gt(e, one());
      case "gte":
        return gte(e, one());
      case "lt":
        return lt(e, one());
      case "lte":
        return lte(e, one());
      case "in": {
        const values = many();
        return values.length ? inArray(e, values) : sql`false`;
      }
      case "not_in": {
        const values = many();
        return values.length ? notInArray(e, values) : sql`true`;
      }
      case "between": {
        const values = many();
        if (values.length !== 2) {
          throw new UdcError("validation_error", `"between" on ${c.field} needs [low, high]`);
        }
        return between(e, values[0], values[1]);
      }
      case "contains":
        return text((v) => `%${v}%`);
      case "starts_with":
        return text((v) => `${v}%`);
      case "ends_with":
        return text((v) => `%${v}`);
      case "is_null":
        return isNull(e);
      case "is_not_null":
        return isNotNull(e);
    }
  }
}

/** A filter value as the field's kind needs it; `validation_error` when it cannot be. */
export function coerce(field: string, kind: FieldKind, value: unknown): unknown {
  if (kind === "time") {
    const date =
      typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) {
      throw new UdcError("validation_error", `${field} needs a timestamp, got ${String(value)}`);
    }
    return date;
  }
  if (kind === "number") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
      throw new UdcError("validation_error", `${field} needs a number, got ${String(value)}`);
    }
    return number;
  }
  if (kind === "bool") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1" || value === 1) return true;
    if (value === "false" || value === "0" || value === 0) return false;
    throw new UdcError("validation_error", `${field} needs true or false, got ${String(value)}`);
  }
  if (value === null || value === undefined || typeof value === "object") {
    throw new UdcError("validation_error", `${field} needs a value, got ${String(value)}`);
  }
  return String(value);
}
