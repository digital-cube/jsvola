/*
 * What this build of the site is: read once per build, shown in the footer of every page
 * (BuildLine.astro) and in the Packages table (PackageTable.astro).
 *
 *   version   the root package.json's
 *   commit    the built commit, short and full (git); null without git history
 *   release   the newest v<x.y.z> tag reachable from the built commit and its commit date (git),
 *             else the `## [x.y.z] - <date>` heading of CHANGELOG.md for that version (a
 *             checkout without history or tags: a tarball, a shallow clone)
 *   builtAt   the time of the build, UTC (SOURCE_DATE_EPOCH when set)
 *   npm       per published @vol-a package, what the npm registry has (below)
 *
 * The registry is asked once per package, in parallel, with a short timeout, and never fails the
 * build. Each package ends in one of three states:
 *
 *   { state: "published", version, time }   dist-tags.latest and the time it was published
 *   { state: "absent" }                     the registry answers 404: not on npm yet
 *   { state: "unknown" }                    no answer (offline, timeout, an error, or SITE_NPM=off)
 *
 * SITE_NPM chooses where the npm data comes from:
 *
 *   (unset)        https://registry.npmjs.org, timeout SITE_NPM_TIMEOUT_MS (default 5000)
 *   off            nothing is fetched; every package is "unknown"
 *   <file>.json    a fixture: { "<name>": <registry document> | null }, null being a 404 and a
 *                  missing name "unknown" (a path relative to apps/website, or absolute)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * @typedef {{ state: "published", version: string, time: string } | { state: "absent" } | { state: "unknown" }} NpmState
 * @typedef {{ tag: string | null, version: string, date: string, source: "git" | "changelog" }} Release
 * @typedef {{
 *   version: string,
 *   commit: { short: string, full: string } | null,
 *   release: Release | null,
 *   builtAt: string,
 *   npm: Record<string, NpmState>,
 *   npmSource: "registry" | "fixture" | "off",
 *   npmReachable: boolean,
 * }} BuildInfo
 */

export const REGISTRY = "https://registry.npmjs.org";

/** The repository root: the nearest directory above `start` holding pnpm-workspace.yaml. */
export function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`build-info: no pnpm-workspace.yaml above ${start}`);
    dir = up;
  }
  return dir;
}

/** An ISO time in UTC without milliseconds: 2026-11-15T16:45:53Z. */
export const utc = (/** @type {string | number | Date} */ when) =>
  new Date(when).toISOString().replace(/\.\d{3}Z$/, "Z");

/** `git <args>` in `cwd`, trimmed; null when git is missing or the command fails. */
function git(cwd, ...args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The built commit, or null outside a git checkout. */
export function commitOf(root) {
  const full = git(root, "rev-parse", "HEAD");
  return full ? { full, short: full.slice(0, 7) } : null;
}

/** The newest release tag reachable from HEAD and its commit date; null without one. */
export function releaseFromGit(root) {
  const tag = git(
    root,
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v[0-9]*.[0-9]*.[0-9]*",
    "--exclude",
    "*-*",
    "HEAD",
  );
  if (!tag) return null;
  const date = git(root, "log", "-1", "--format=%cI", `${tag}^{commit}`);
  if (!date) return null;
  return { tag, version: tag.slice(1), date: utc(date), source: "git" };
}

/**
 * The release of CHANGELOG.md: the `## [x.y.z] - YYYY-MM-DD` heading of `version`, else the
 * newest released one. A date only, no time. Null when the file has no released heading.
 */
export function releaseFromChangelog(text, version) {
  const headings = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm)];
  const hit = headings.find((m) => m[1] === version) ?? headings[0];
  if (!hit?.[1] || !hit[2]) return null;
  return { tag: null, version: hit[1], date: hit[2], source: "changelog" };
}

/** What one registry answer means: the newest version and when it went out. */
export function npmStateOf(doc) {
  if (doc === null) return { state: "absent" };
  if (!doc || typeof doc !== "object") return { state: "unknown" };
  const time = doc.time ?? {};
  let version = doc["dist-tags"]?.latest;
  if (!version || !time[version]) {
    // No latest tag: the version published last.
    const published = Object.entries(time)
      .filter(([v]) => v !== "created" && v !== "modified")
      .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a));
    version = published[0]?.[0];
  }
  if (!version || !time[version]) return { state: "unknown" };
  return { state: "published", version, time: utc(time[version]) };
}

/** One package from the registry; `fetchImpl` and `timeoutMs` for the tests. */
export async function fetchNpm(
  name,
  { registry = REGISTRY, timeoutMs = 5000, fetchImpl = fetch } = {},
) {
  try {
    const url = `${registry}/${name.replace("/", "%2f")}`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { state: "absent" };
    if (!res.ok) return { state: "unknown", reason: `HTTP ${res.status}` };
    return npmStateOf(await res.json());
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The names of the workspace's published packages (packages/*, not private). */
export function packageNames(root) {
  const dir = join(root, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "package.json")))
    .map((e) => JSON.parse(readFileSync(join(dir, e.name, "package.json"), "utf8")))
    .filter((pkg) => !pkg.private)
    .map((pkg) => pkg.name)
    .sort();
}

/**
 * Every package's npm state, from `source`: "off", a fixture path, or the registry. Logs one
 * warning when the registry could not be asked, never throws.
 */
export async function npmStates(names, { source, timeoutMs, fetchImpl, warn = console.warn } = {}) {
  /** @type {Record<string, NpmState>} */
  const npm = {};
  if (source === "off") {
    for (const name of names) npm[name] = { state: "unknown" };
    return { npm, npmSource: "off", npmReachable: false };
  }
  if (source) {
    const fixture = JSON.parse(readFileSync(resolve(source), "utf8"));
    for (const name of names)
      npm[name] = name in fixture ? npmStateOf(fixture[name]) : { state: "unknown" };
    return { npm, npmSource: "fixture", npmReachable: true };
  }
  const answers = await Promise.all(names.map((n) => fetchNpm(n, { timeoutMs, fetchImpl })));
  const failed = [];
  names.forEach((name, i) => {
    const { reason, ...state } = /** @type {NpmState & { reason?: string }} */ (answers[i]);
    npm[name] = state;
    if (state.state === "unknown") failed.push(reason ? `${name}: ${reason}` : name);
  });
  if (failed.length) {
    warn(
      `build-info: the npm registry did not answer for ${failed.length} of ${names.length} packages ` +
        `(${failed.join("; ")}); the Packages table shows no publication date for them`,
    );
  }
  return { npm, npmSource: "registry", npmReachable: failed.length < names.length };
}

/** Everything above, for the repository at `root`. */
export async function loadBuildInfo({
  root = findRoot(),
  env = process.env,
  now = Date.now(),
  fetchImpl,
} = {}) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const changelog = join(root, "CHANGELOG.md");
  const release =
    releaseFromGit(root) ??
    (existsSync(changelog) ? releaseFromChangelog(readFileSync(changelog, "utf8"), version) : null);
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  const builtAt = utc(Number.isFinite(epoch) && env.SOURCE_DATE_EPOCH ? epoch * 1000 : now);
  const timeoutMs = Number(env.SITE_NPM_TIMEOUT_MS) || 5000;
  const npm = await npmStates(packageNames(root), { source: env.SITE_NPM, timeoutMs, fetchImpl });
  return { version, commit: commitOf(root), release, builtAt, ...npm };
}

/** @type {Promise<BuildInfo> | undefined} */
let once;
/**
 * The build's info, computed on the first call and shared by every page of the build.
 * @returns {Promise<BuildInfo>}
 */
export function buildInfo() {
  if (!once) once = loadBuildInfo();
  return once;
}

/** `2026-11-15` of an ISO time (UTC), or the date itself. */
export const dateOf = (/** @type {string} */ iso) => iso.slice(0, 10);
/** `2026-11-15 17:01 UTC` of an ISO time. */
export const minuteOf = (/** @type {string} */ iso) =>
  `${utc(iso).slice(0, 16).replace("T", " ")} UTC`;
