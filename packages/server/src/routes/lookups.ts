import { type InstanceTypesResponse, LOCALE_QUERY, type LookupsResponse } from "@vol-a/core";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { files } from "../db/schema.js";
import { type Lookups, lookupsResponse, parseLocale } from "../lookups.js";

export interface LookupRoutesDeps {
  db: Database;
  lookups: Lookups;
}

interface LocaleQuery {
  [LOCALE_QUERY]?: string;
}

/**
 * - `GET /lookups[?locale=en|sr]` — no API key: the vocabulary of `lookups.yaml` with its
 *   terms, wire values and labels in the locale asked for (an unknown locale, or a term
 *   without a label in it, falls back to `en`);
 * - `GET /instance-types` — `files:read`: the distinct `instance_type` values of the tenant
 *   that have live files, with the number of those files, sorted by name.
 */
export const lookupRoutes: FastifyPluginAsync<LookupRoutesDeps> = async (app, deps) => {
  app.get<{ Querystring: LocaleQuery }>(
    "/lookups",
    { config: { auth: "none" } },
    async (request): Promise<LookupsResponse> =>
      lookupsResponse(deps.lookups, parseLocale(request.query[LOCALE_QUERY])),
  );

  app.get(
    "/instance-types",
    { config: { scope: "files:read" } },
    async (): Promise<InstanceTypesResponse> => {
      const tenant = requireTenant();
      const rows = await deps.db
        .select({ instanceType: files.instanceType, files: count() })
        .from(files)
        .where(and(eq(files.tenantId, tenant.tenantId), isNull(files.deletedAt)))
        .groupBy(files.instanceType)
        .orderBy(asc(files.instanceType));
      return {
        instance_types: rows.map((row) => ({
          instance_type: row.instanceType,
          files: Number(row.files),
        })),
      };
    },
  );
};
