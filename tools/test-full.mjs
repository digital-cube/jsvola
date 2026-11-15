#!/usr/bin/env node
/**
 * The whole test suite in one command, with ONE coverage report — what `thilo.toml` [testing]
 * runs (through `tools/test-full.sh`) and what `pnpm test:full` runs by hand.
 *
 *   1. checks that the PostgreSQL and Redis of `compose.yaml` answer (exit 2 with a sentence
 *      when they do not);
 *   2. `turbo run test:cov --continue`: every package with coverage, `@vol-a/server` and
 *      `@vol-a/cli` on both databases (PostgreSQL and SQLite — their Vitest projects);
 *   3. `turbo run test:e2e`: the built server over HTTP (skip with `--no-e2e`);
 *   4. merges every workspace's `coverage/coverage-final.json` (`packages/*`, `apps/*`) into
 *      `coverage/coverage.json` at the repository root, in coverage.py's JSON format
 *      (`format = "coverage-py-json"`, the only one the thilo runner reads), plus a `packages`
 *      key with each workspace's own totals.
 *
 * Exit status: 0 only when every step passed (a package's coverage threshold failing fails the
 * step, as in CI); the coverage file is written either way, so a red run still carries its numbers.
 *
 * Workers: a thilo test ticket's `workers` reaches the command as pytest-xdist's `-n N` in
 * `PYTEST_ADDOPTS`; it is translated to Vitest's `--maxWorkers=N` (`-n 0` → one worker, no file
 * parallelism; `-n auto` → Vitest's default). `VOLA_TEST_WORKERS` (`auto`, `off`, or N) wins
 * over it.
 *
 *   node tools/test-full.mjs              # everything
 *   node tools/test-full.mjs --no-e2e     # unit suites and coverage only
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const OUT = "coverage/coverage.json";
const args = new Set(process.argv.slice(2));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: read by this script, before and outside any turbo task
const e2e = !args.has("--no-e2e") && process.env.VOLA_TEST_E2E !== "0";

/** `.env`, then `.env.example` (the `compose.yaml` defaults) — neither overrides what is set. */
for (const file of [".env", ".env.example"]) {
  const path = join(root, file);
  if (existsSync(path)) process.loadEnvFile(path);
}

/** `true` when something accepts a TCP connection at `host:port` within `ms`. */
function reachable(host, port, ms = 3000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(ms, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The services the suites need, each checked; a sentence per one that does not answer. */
async function preflight() {
  const needed = [
    ["PostgreSQL", "VOLA_DATABASE_URL_TEST", 5432, /^postgres(ql)?:/],
    ["Redis", "VOLA_REDIS_URL", 6379, /^rediss?:/],
  ];
  const problems = [];
  for (const [what, name, defaultPort, scheme] of needed) {
    const value = process.env[name];
    if (!value) {
      problems.push(`${name} is not set (copy .env.example to .env)`);
      continue;
    }
    if (!scheme.test(value)) continue; // not a server (e.g. a SQLite file): nothing to reach
    const url = new URL(value);
    const port = Number(url.port || defaultPort);
    if (!(await reachable(url.hostname, port))) {
      problems.push(`${what} is not reachable at ${url.hostname}:${port} (${name})`);
    }
  }
  if (problems.length === 0) return;
  console.error("test-full: the test suites need the PostgreSQL and Redis of compose.yaml.");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("  Start them with `docker compose up -d postgres redis` (or `pnpm db:up`);");
  console.error("  the ports come from .env (VOLA_DATABASE_URL_TEST, VOLA_REDIS_URL).");
  process.exit(2);
}

/** `auto` | `off` | `"N"` | `null` (say nothing) from VOLA_TEST_WORKERS or PYTEST_ADDOPTS' `-n`. */
function requestedWorkers() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: read by this script, before and outside any turbo task
  const own = (process.env.VOLA_TEST_WORKERS ?? "").trim().toLowerCase();
  if (own) return own === "0" ? "off" : own;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: read by this script, before and outside any turbo task
  const tokens = (process.env.PYTEST_ADDOPTS ?? "").trim().split(/\s+/);
  let value = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-n" || t === "--numprocesses") value = tokens[++i] ?? null;
    else if (t.startsWith("--numprocesses=")) value = t.slice("--numprocesses=".length);
    else if (/^-n\S+$/.test(t)) value = t.slice(2);
  }
  if (value === null) return null;
  value = value.toLowerCase();
  return value === "0" ? "off" : value;
}

/** Vitest arguments for a worker request; an unreadable one is ignored with a note. */
function vitestWorkerArgs(workers) {
  if (workers === null || workers === "auto" || workers === "logical") return [];
  if (workers === "off") return ["--maxWorkers=1", "--no-file-parallelism"];
  if (/^[1-9]\d*$/.test(workers)) return [`--maxWorkers=${workers}`];
  console.warn(`test-full: ignoring the worker count ${JSON.stringify(workers)}`);
  return [];
}

/** Runs a command from the repository root, output passed through; its exit status. */
function run(command, argv) {
  console.log(`\n$ ${[command, ...argv].join(" ")}`);
  const result = spawnSync(command, argv, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`test-full: cannot run ${command}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

/**
 * One istanbul file record → its lines: `line → hits`, the way istanbul itself counts lines
 * (a line is the highest count of the statements that start on it).
 */
function lineHits(record) {
  const lines = new Map();
  for (const [id, loc] of Object.entries(record.statementMap ?? {})) {
    const line = loc.start.line;
    const hits = record.s?.[id] ?? 0;
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  }
  return lines;
}

const pct = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);

/** The coverage.py-shaped summary of a set of executed and missing lines. */
function summary(executed, missing) {
  const total = executed + missing;
  const percent = pct(executed, total);
  return {
    covered_lines: executed,
    num_statements: total,
    percent_covered: percent,
    percent_covered_display: String(Math.round(percent)),
    missing_lines: missing,
    excluded_lines: 0,
  };
}

/** The workspace directories (`pnpm-workspace.yaml`: `packages/*`, `apps/*`), relative. */
function workspaces() {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, group, d.name, "package.json")))
      .map((d) => `${group}/${d.name}`)
      .sort(),
  );
}

/** Every workspace's `coverage-final.json`, merged into one coverage.py JSON document. */
function mergeCoverage() {
  const files = {};
  const packages = {};
  for (const ws of workspaces()) {
    const dir = join(root, ws, "coverage");
    const final = join(dir, "coverage-final.json");
    if (!existsSync(final)) continue;
    const istanbul = JSON.parse(readFileSync(final, "utf8"));
    let executed = 0;
    let missing = 0;
    for (const record of Object.values(istanbul)) {
      const lines = lineHits(record);
      const hit = [...lines].filter(([, n]) => n > 0).map(([l]) => l);
      const miss = [...lines].filter(([, n]) => n === 0).map(([l]) => l);
      hit.sort((a, b) => a - b);
      miss.sort((a, b) => a - b);
      files[relative(root, record.path)] = {
        executed_lines: hit,
        summary: summary(hit.length, miss.length),
        missing_lines: miss,
        excluded_lines: [],
      };
      executed += hit.length;
      missing += miss.length;
    }
    const istanbulSummary = join(dir, "coverage-summary.json");
    const total = existsSync(istanbulSummary)
      ? JSON.parse(readFileSync(istanbulSummary, "utf8")).total
      : null;
    const { name } = JSON.parse(readFileSync(join(root, ws, "package.json"), "utf8"));
    packages[name ?? ws] = {
      ...summary(executed, missing),
      // Vitest's own numbers (what CI's ≥ 80 % threshold reads), statements counted by AST.
      istanbul: total && {
        lines: total.lines.pct,
        statements: total.statements.pct,
        functions: total.functions.pct,
        branches: total.branches.pct,
      },
    };
  }
  const covered = Object.values(files).reduce((n, f) => n + f.summary.covered_lines, 0);
  const all = Object.values(files).reduce((n, f) => n + f.summary.num_statements, 0);
  return {
    meta: {
      format: 3,
      version: "jsvola tools/test-full.mjs (from Vitest/istanbul line coverage)",
      timestamp: new Date().toISOString(),
      branch_coverage: false,
      show_contexts: false,
    },
    files,
    totals: summary(covered, all - covered),
    packages,
  };
}

function printTable(report) {
  console.log("\ncoverage (lines)               covered / lines     %");
  for (const [name, p] of Object.entries(report.packages)) {
    const nums = `${p.covered_lines} / ${p.num_statements}`.padStart(16);
    console.log(`  ${name.padEnd(26)} ${nums}  ${p.percent_covered.toFixed(1).padStart(5)}`);
  }
  const t = report.totals;
  const nums = `${t.covered_lines} / ${t.num_statements}`.padStart(16);
  console.log(`  ${"TOTAL".padEnd(26)} ${nums}  ${t.percent_covered.toFixed(1).padStart(5)}`);
  console.log(`\nwritten: ${OUT}`);
}

await preflight();

const workers = requestedWorkers();
const workerArgs = vitestWorkerArgs(workers);
if (workers !== null)
  console.log(`test-full: workers ${workers} → ${workerArgs.join(" ") || "Vitest's default"}`);

// Stale reports must not pass for this run's: a package that fails to build writes none.
rmSync(join(root, OUT), { force: true });
for (const ws of workspaces()) rmSync(join(root, ws, "coverage"), { recursive: true, force: true });

const turbo = join(root, "node_modules", ".bin", "turbo");
if (!existsSync(turbo)) {
  console.error("test-full: node_modules/.bin/turbo is missing — run `pnpm install` first.");
  process.exit(2);
}
const statuses = [];
statuses.push(
  run(turbo, [
    "run",
    "test:cov",
    "--continue",
    ...(workerArgs.length ? ["--", ...workerArgs] : []),
  ]),
);
if (e2e) statuses.push(run(turbo, ["run", "test:e2e"]));

const report = mergeCoverage();
mkdirSync(join(root, "coverage"), { recursive: true });
writeFileSync(join(root, OUT), `${JSON.stringify(report)}\n`);
printTable(report);

const failed = statuses.find((s) => s !== 0);
if (failed !== undefined) {
  console.error(`\ntest-full: FAILED (exit ${failed}) — see the output above.`);
  process.exit(failed);
}
console.log("\ntest-full: all suites passed.");
