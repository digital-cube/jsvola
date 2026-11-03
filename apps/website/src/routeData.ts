/*
 * Starlight route middleware (astro.config.mjs, `routeMiddleware`). Every section's index is
 * "Overview" in the sidebar, under the section's own name; Previous / Next would then say
 * "Overview" with no section. Here a link labelled "Overview" takes the name of the group it
 * sits in ("Examples"), so the pagination reads the way the sidebar does.
 */
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

type Entry = { type: string; label: string; href?: string; entries?: Entry[] };

const groupOf = (entries: Entry[], href: string, parent?: string): string | undefined => {
  for (const entry of entries) {
    if (entry.type === "link" && entry.href === href) return parent;
    if (entry.type === "group" && entry.entries) {
      const found = groupOf(entry.entries, href, entry.label);
      if (found) return found;
    }
  }
  return undefined;
};

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  // The site has no locales, so one page can be Serbian without /sr/ copies of all the others.
  if (route.id.endsWith("-sr")) route.lang = "sr";
  for (const link of [route.pagination.prev, route.pagination.next]) {
    if (link?.label !== "Overview") continue;
    const group = groupOf(route.sidebar as Entry[], link.href);
    if (group) link.label = group;
  }
});
