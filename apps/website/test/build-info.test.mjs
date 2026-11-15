/*
 * src/build-info.mjs without the network: the registry is a fake fetch or the fixture, git is
 * this repository (or a directory without one).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dateOf,
  fetchNpm,
  findRoot,
  loadBuildInfo,
  minuteOf,
  npmStateOf,
  npmStates,
  packageNames,
  releaseFromChangelog,
  releaseFromGit,
} from "../src/build-info.mjs";

const FIXTURE = fileURLToPath(new URL("fixtures/npm-published.json", import.meta.url));
const ROOT = findRoot(fileURLToPath(new URL(".", import.meta.url)));
const NAMES = packageNames(ROOT);
const answer = (status, body) => async () =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status });

test("the published packages are the six non-private ones", () => {
  assert.deepEqual(NAMES, [
    "@vol-a/cli",
    "@vol-a/client",
    "@vol-a/core",
    "@vol-a/lookups",
    "@vol-a/react",
    "@vol-a/server",
  ]);
});

test("a registry document: dist-tags.latest and its time, in UTC", () => {
  assert.deepEqual(
    npmStateOf({
      "dist-tags": { latest: "1.0.1" },
      time: {
        created: "x",
        modified: "2026-11-15T00:00:00Z",
        "1.0.1": "2026-11-12T10:00:03.250+01:00",
      },
    }),
    { state: "published", version: "1.0.1", time: "2026-11-12T09:00:03Z" },
  );
  // no latest tag: the version published last
  assert.deepEqual(
    npmStateOf({ time: { "1.0.0": "2026-01-01T00:00:00Z", "1.0.1": "2026-02-01T00:00:00Z" } }),
    {
      state: "published",
      version: "1.0.1",
      time: "2026-02-01T00:00:00Z",
    },
  );
  assert.deepEqual(npmStateOf(null), { state: "absent" });
  assert.deepEqual(npmStateOf({ time: {} }), { state: "unknown" });
});

test("fetchNpm: 404 is absent, an error or a timeout is unknown, never a throw", async () => {
  assert.deepEqual(await fetchNpm("@vol-a/core", { fetchImpl: answer(404) }), { state: "absent" });
  assert.equal((await fetchNpm("@vol-a/core", { fetchImpl: answer(503) })).state, "unknown");
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal((await fetchNpm("@vol-a/core", { fetchImpl: offline })).state, "unknown");
  const hang = (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const t0 = Date.now();
  const slow = await fetchNpm("@vol-a/core", { fetchImpl: hang, timeoutMs: 50 });
  assert.equal(slow.state, "unknown");
  assert.ok(Date.now() - t0 < 2000);
});

test("fetchNpm asks for the scoped name with the slash escaped", async () => {
  let asked = "";
  await fetchNpm("@vol-a/core", {
    fetchImpl: async (url) => {
      asked = url;
      return new Response("", { status: 404 });
    },
  });
  assert.equal(asked, "https://registry.npmjs.org/@vol-a%2fcore");
});

test("npmStates: one warning for an unreachable registry, none for 404s or off", async () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  const down = await npmStates(NAMES, { fetchImpl: offline, warn });
  assert.equal(warnings.length, 1);
  assert.equal(down.npmReachable, false);
  assert.ok(Object.values(down.npm).every((s) => s.state === "unknown" && !("reason" in s)));

  const missing = await npmStates(NAMES, { fetchImpl: answer(404), warn });
  assert.equal(warnings.length, 1);
  assert.ok(Object.values(missing.npm).every((s) => s.state === "absent"));

  const off = await npmStates(NAMES, { source: "off", warn });
  assert.equal(warnings.length, 1);
  assert.equal(off.npmSource, "off");
});

test("npmStates from the fixture: published, null as a 404", async () => {
  const { npm, npmSource } = await npmStates(NAMES, { source: FIXTURE });
  assert.equal(npmSource, "fixture");
  assert.deepEqual(npm["@vol-a/server"], {
    state: "published",
    version: "1.0.1",
    time: "2026-11-12T09:00:03Z",
  });
  assert.deepEqual(npm["@vol-a/react"], { state: "absent" });
});

test("the release from CHANGELOG.md: the version's heading, else the newest", () => {
  const text = "## [Unreleased]\n\n## [1.1.0] - 2026-11-15\n\n## [1.0.1] - 2026-11-12\n";
  assert.deepEqual(releaseFromChangelog(text, "1.0.1"), {
    tag: null,
    version: "1.0.1",
    date: "2026-11-12",
    source: "changelog",
  });
  assert.equal(releaseFromChangelog(text, "9.9.9")?.version, "1.1.0");
  assert.equal(releaseFromChangelog("## [Unreleased]\n", "1.0.0"), null);
});

test("the release from git matches `git log -1 --format=%cI <tag>`", () => {
  const release = releaseFromGit(ROOT);
  assert.ok(release, "this checkout has a v*.*.* tag");
  const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*.*.*"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const date = execFileSync("git", ["log", "-1", "--format=%cI", tag], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  assert.equal(release.tag, tag);
  assert.equal(Date.parse(release.date), Date.parse(date));
});

test("without git history the release and the commit come from CHANGELOG.md, or are null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "build-info-"));
  try {
    for (const f of ["package.json", "CHANGELOG.md", "pnpm-workspace.yaml"])
      cpSync(join(ROOT, f), join(dir, f));
    cpSync(
      join(ROOT, "packages", "core", "package.json"),
      join(dir, "packages", "core", "package.json"),
    );
    const info = await loadBuildInfo({
      root: dir,
      env: { SITE_NPM: "off" },
      now: Date.parse("2026-11-15T17:01:30Z"),
    });
    const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    assert.equal(info.version, version);
    assert.equal(info.release?.source, "changelog");
    assert.equal(info.release?.version, version);
    assert.equal(info.builtAt, "2026-11-15T17:01:30Z");
    assert.equal(info.commit, null);
    assert.deepEqual(info.npm, { "@vol-a/core": { state: "unknown" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SOURCE_DATE_EPOCH fixes the build time", async () => {
  const info = await loadBuildInfo({
    root: ROOT,
    env: { SITE_NPM: "off", SOURCE_DATE_EPOCH: "1763226060" },
  });
  assert.equal(info.builtAt, "2025-11-15T17:01:00Z");
  assert.ok(info.commit && /^[0-9a-f]{7}$/.test(info.commit.short));
});

test("the dates as the footer prints them", () => {
  assert.equal(dateOf("2026-11-15T16:45:53Z"), "2026-11-15");
  assert.equal(dateOf("2026-11-15"), "2026-11-15");
  assert.equal(minuteOf("2026-11-15T17:01:59Z"), "2026-11-15 17:01 UTC");
});
