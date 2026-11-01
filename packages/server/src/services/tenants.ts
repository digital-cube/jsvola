import { SlugSchema, type Tenant } from "@vola/core";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { type TenantRow, tenants } from "../db/schema.js";
import { VolaError } from "../errors.js";

export function serializeTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    is_active: row.isActive,
    default_encryption: row.defaultEncryption as Tenant["default_encryption"],
    created_at: row.createdAt.toISOString(),
  };
}

export interface CreateTenantInput {
  slug: string;
  /** Display name; default: the slug in title case (`acme-inc` → `Acme Inc`). */
  name?: string | undefined;
}

/** `Acme Inc` from `acme-inc`. */
export function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => (word[0] as string).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Creates a tenant; `validation_error` for a bad slug, `conflict` for a taken one. */
export async function createTenant(db: Database, input: CreateTenantInput): Promise<Tenant> {
  const slug = SlugSchema.safeParse(input.slug);
  if (!slug.success) {
    throw new VolaError("validation_error", 422, `slug: ${slug.error.issues[0]?.message}`);
  }
  const name = (input.name ?? titleCase(slug.data)).trim();
  if (!name || name.length > 200) {
    throw new VolaError("validation_error", 422, "name: 1–200 characters");
  }
  const [row] = await db
    .insert(tenants)
    .values({ slug: slug.data, name })
    .onConflictDoNothing({ target: tenants.slug })
    .returning();
  if (!row) throw new VolaError("conflict", 409, `tenant "${slug.data}" already exists`);
  return serializeTenant(row);
}

/** The tenant row with `slug`, or `null`. */
export async function findTenantBySlug(db: Database, slug: string): Promise<TenantRow | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return row ?? null;
}

/** The tenant with `slug`; throws `tenant_not_found`. */
export async function getTenantBySlug(db: Database, slug: string): Promise<TenantRow> {
  const row = await findTenantBySlug(db, slug);
  if (!row) throw new VolaError("tenant_not_found", 404, `tenant "${slug}" not found`);
  return row;
}

/** Every tenant, oldest first. */
export async function listTenants(db: Database): Promise<Tenant[]> {
  const rows = await db.select().from(tenants).orderBy(tenants.createdAt, tenants.id);
  return rows.map(serializeTenant);
}

/** Activates or deactivates a tenant; an inactive tenant's keys fail authentication. */
export async function setTenantActive(
  db: Database,
  slug: string,
  isActive: boolean,
): Promise<Tenant> {
  const [row] = await db
    .update(tenants)
    .set({ isActive })
    .where(eq(tenants.slug, slug))
    .returning();
  if (!row) throw new VolaError("tenant_not_found", 404, `tenant "${slug}" not found`);
  return serializeTenant(row);
}

/** The default encryption modes a tenant may be set to (`client` needs a key per upload: never a default). */
export const TENANT_DEFAULT_ENCRYPTIONS = ["none", "tenant", "keyring", "caller"] as const;
export type TenantDefaultEncryption = (typeof TENANT_DEFAULT_ENCRYPTIONS)[number];

/**
 * Sets how an upload of the tenant that names no `encryption` is stored (`vola tenant-set
 * --default-encryption`). `validation_error` for anything but `TENANT_DEFAULT_ENCRYPTIONS`.
 */
export async function setTenantDefaultEncryption(
  db: Database,
  slug: string,
  mode: string,
): Promise<Tenant> {
  if (!(TENANT_DEFAULT_ENCRYPTIONS as readonly string[]).includes(mode)) {
    throw new VolaError(
      "validation_error",
      422,
      `default_encryption: one of ${TENANT_DEFAULT_ENCRYPTIONS.join(", ")}`,
    );
  }
  const [row] = await db
    .update(tenants)
    .set({ defaultEncryption: mode })
    .where(eq(tenants.slug, slug))
    .returning();
  if (!row) throw new VolaError("tenant_not_found", 404, `tenant "${slug}" not found`);
  return serializeTenant(row);
}
