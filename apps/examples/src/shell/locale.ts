/**
 * The router's base: `/en` when the page was opened under `/en/` (the server serves the
 * site there too, so links of that shape keep working), `/` otherwise.
 */
export function routerBasename(pathname: string): string {
  return /^\/en(\/|$)/.test(pathname) ? "/en" : "/";
}
