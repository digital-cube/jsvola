import { AsyncLocalStorage } from "node:async_hooks";
import type { Scope } from "@vola/core";
import { VolaError } from "./errors.js";

/**
 * Who is calling: the key that authenticated and the tenant the request works in.
 * A tenant key always has its tenant; an admin key has the one `X-Tenant-Slug` selected,
 * or none (`tenantId: null`) — then only routes with `config.tenant = "optional"` answer.
 */
export interface TenantContext {
  tenantId: string | null;
  tenantSlug: string | null;
  apiKeyId: string;
  /** How the key is shown to a person (`vola_live…k3Qz`): the audit actor of a request without `X-User-Id`. */
  apiKeyLabel: string;
  scopes: readonly Scope[];
  isAdmin: boolean;
  /** The `X-User-Id` of the request (the host application's principal), if any. */
  userId: string | null;
  /**
   * The `X-Vola-Unlock` of the request (plan 6.2): an unlock token of the principal's
   * keyring, or `null`. Resolved only when a `keyring` file is touched; never logged.
   */
  unlockToken: string | null;
}

/** A context with a tenant selected: what `requireTenant()` returns. */
export type BoundTenantContext = TenantContext & { tenantId: string; tenantSlug: string };

const storage = new AsyncLocalStorage<TenantContext>();

/** Runs `fn` with `context` as the current one (the Node equivalent of a ContextVar). */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or `undefined` outside an authenticated request. */
export function currentContext(): TenantContext | undefined {
  return storage.getStore();
}

/** `true` when `context` has a tenant selected. */
export function hasTenant(context: TenantContext): context is BoundTenantContext {
  return context.tenantId !== null && context.tenantSlug !== null;
}

/** The `tenant_required` error: an admin key called a tenant route without `X-Tenant-Slug`. */
export function tenantRequired(): VolaError {
  return new VolaError(
    "tenant_required",
    400,
    "this request works in a tenant: an admin key selects one with X-Tenant-Slug",
  );
}

/**
 * The current tenant; throws `unauthorized` outside an authenticated request and
 * `tenant_required` when an admin key did not select a tenant. Services read the tenant
 * from here, never from request input.
 */
export function requireTenant(): BoundTenantContext {
  const context = storage.getStore();
  if (!context) throw new VolaError("unauthorized", 401, "no tenant context");
  if (!hasTenant(context)) throw tenantRequired();
  return context;
}
