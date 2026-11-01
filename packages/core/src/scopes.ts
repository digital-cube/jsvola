import { z } from "zod";

/** Every scope an API key can hold. `admin` satisfies all of them (admin keys only). */
export const SCOPES = [
  "files:read",
  "files:write",
  "folders:read",
  "folders:write",
  "shares:write",
  "keys:write",
  "keyrings:write",
  "admin",
] as const;

export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

/** The scopes a tenant key may hold: everything but `admin`. */
export const TENANT_SCOPES = SCOPES.filter((scope) => scope !== "admin") as Exclude<
  Scope,
  "admin"
>[];
export const TenantScopeSchema = z.enum(TENANT_SCOPES as [Scope, ...Scope[]]);

/** Whether `granted` satisfies the single `required` scope (`admin` satisfies everything). */
export function hasScope(granted: readonly string[], required: string): boolean {
  return granted.includes("admin") || granted.includes(required);
}

/** The scopes of `required` that `granted` does not satisfy (empty: all satisfied). */
export function missingScopes(
  granted: readonly string[],
  required: string | readonly string[],
): string[] {
  const list = typeof required === "string" ? [required] : required;
  return list.filter((scope) => !hasScope(granted, scope));
}

/** Parses `a,b,c` or a list into distinct, known scopes; throws on an unknown one. */
export function parseScopes(input: string | readonly string[]): Scope[] {
  const parts = typeof input === "string" ? input.split(",") : input;
  const scopes = new Set<Scope>();
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const parsed = ScopeSchema.safeParse(trimmed);
    if (!parsed.success) {
      throw new Error(`unknown scope "${trimmed}" (known: ${SCOPES.join(", ")})`);
    }
    scopes.add(parsed.data);
  }
  if (scopes.size === 0) throw new Error("at least one scope is required");
  return [...scopes];
}
