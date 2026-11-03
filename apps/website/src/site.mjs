/*
 * Where the site lives and where the examples instance it links to lives, read once from the
 * environment at build time. astro.config.mjs, the components and the content import these
 * instead of spelling a host, so one build command serves stage and production. The defaults
 * are production's:
 *
 *   SITE_URL     the site's own origin, Astro's `site` (default https://vol-a.com; stage:
 *                https://stage.vol-a.com)
 *   EXAMPLE_URL  the examples site every "live example" link opens
 *                (default https://examples.stage.vol-a.com: no production examples instance
 *                exists yet; the default moves when one does)
 */
const origin = (value, fallback) => (value || fallback).replace(/\/+$/, "");

export const SITE_URL = origin(process.env.SITE_URL, "https://vol-a.com");
export const EXAMPLE_URL = origin(process.env.EXAMPLE_URL, "https://examples.stage.vol-a.com");
export const REPO_URL = "https://github.com/digital-cube/jsvola";
