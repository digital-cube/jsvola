#!/usr/bin/env node
/**
 * The tutorial (src/content/docs/tutorials/) and the history it is written from.
 *
 *   node scripts/tutorial.mjs snippets      the program's `step N: …` commits → snippets/tutorial/step-N/files/
 *   node scripts/tutorial.mjs md <dir>      each page, as plain markdown, into <dir> (its pictures too)
 *   node scripts/tutorial.mjs check         each chapter on a clean checkout of the step before == that step
 *   node scripts/tutorial.mjs run <n> [dir] run chapter n's commands, as written, against a real stack
 *
 * `snippets` and `check` need the commits in this repository's history. `run` brings the Docker stack
 * of the program up on this machine, with its real name and port, and drops its data first.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { langOf } from "../src/tutorial-lang.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const PROGRAM = "apps/tutorial/ticket-desk";
const SNIPPETS = join(ROOT, "snippets", "tutorial");
const PAGES = join(ROOT, "src", "content", "docs", "tutorials");
const STEPS = [1, 2, 3, 4, 5, 6, 7];
const SITE = "https://vol-a.com";
/** Not code the reader types: the lock is made by `pnpm install`, the tarballs are downloaded. */
const NOT_IN_A_CHAPTER = /^(README\.md|pnpm-lock\.yaml|vendor\/.*)$/;
/**
 * A mistake in a step's commit, fixed by a later commit instead of rewriting the history: the
 * chapter shows the file as it is now, and it counts as what that step's commit should have had.
 */
const CORRECTED = ["docker/init-databases.sql"];
const PAGE_FILES = { en: "ticket-desk.mdx", sr: "ticket-desk-sr.mdx" };

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });

const commitOf = (step) => {
  const sha = git("log", "--format=%H", `--grep=^step ${step}:`, "-1", "--", PROGRAM).trim();
  if (!sha) throw new Error(`no commit "step ${step}: …" touches ${PROGRAM}`);
  return sha;
};

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      )
    : [];

/** The code of a chapter as the history has it: a new file whole, a changed one as its diff. */
function snippets() {
  for (const step of STEPS) {
    rmSync(join(SNIPPETS, `step-${step}`, "files"), { recursive: true, force: true });
    const sha = commitOf(step);
    const changes = git(
      "diff",
      "--name-status",
      `--relative=${PROGRAM}`,
      `${sha}^`,
      sha,
      "--",
      PROGRAM,
    )
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    for (const [status, path] of changes) {
      if (NOT_IN_A_CHAPTER.test(path)) continue;
      const base = join(SNIPPETS, `step-${step}`, "files", path);
      mkdirSync(dirname(base), { recursive: true });
      if (status === "A") {
        const rev = CORRECTED.includes(path) ? "HEAD" : sha;
        writeFileSync(`${base}.txt`, git("show", `${rev}:${PROGRAM}/${path}`));
      } else if (status === "M") {
        const diff = git(
          "diff",
          `--relative=${PROGRAM}`,
          `${sha}^`,
          sha,
          "--",
          `${PROGRAM}/${path}`,
        );
        const body = diff.slice(diff.indexOf("--- a/"));
        writeFileSync(`${base}.diff.txt`, body);
      } else {
        throw new Error(`step ${step}: ${path} is ${status}: a chapter cannot show that yet`);
      }
    }
  }
}

/** One page as plain markdown: every component replaced by the fence it renders. */
function pageToMarkdown(file, labels, pictures) {
  const fenceFor = (lang, text, title = "") => {
    const longest = Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length + 1));
    const ticks = "`".repeat(longest);
    return `${ticks}${lang}${title ? ` title="${title}"` : ""}\n${text.replace(/\n$/, "")}\n${ticks}`;
  };
  return readFileSync(join(PAGES, file), "utf8")
    .replace(/^import .*\n/gm, "")
    .replace(/<TutorialFile step=\{(\d)\} path="([^"]+)" \/>/g, (_, step, path) => {
      const base = join(SNIPPETS, `step-${step}`, "files", path);
      if (existsSync(`${base}.diff.txt`)) {
        return fenceFor("diff", readFileSync(`${base}.diff.txt`, "utf8"), path);
      }
      return fenceFor(langOf(path), readFileSync(`${base}.txt`, "utf8"), path);
    })
    .replace(/<TutorialRun step=\{(\d)\} name="([^"]+)" \/>/g, (_, step, name) => {
      const dir = join(SNIPPETS, `step-${step}`, "run");
      const command = fenceFor("sh", readFileSync(join(dir, `${name}.sh`), "utf8"));
      const out = join(dir, `${name}.out.txt`);
      if (!existsSync(out)) return command;
      return `${command}\n\n${labels.printed}:\n\n${fenceFor("txt", readFileSync(out, "utf8"))}`;
    })
    .replace(/!\[([^\]]*)\]\([^)]*\/assets\/tutorial\/([^)]+)\)/g, (_, alt, name) => {
      pictures.add(name);
      return `![${alt}](${name})`;
    })
    .replace(/^---\n[\s\S]*?\n---\n+/, (front) => {
      const title = front.match(/^title: (.*)$/m)?.[1] ?? "";
      return `# ${title.replace(/^"|"$/g, "")}\n\n`;
    });
}

function markdown(outDir) {
  mkdirSync(outDir, { recursive: true });
  const pictures = new Set();
  writeFileSync(
    join(outDir, "tutorial.md"),
    pageToMarkdown(PAGE_FILES.en, { printed: "What it printed" }, pictures),
  );
  writeFileSync(
    join(outDir, "tutorial.sr.md"),
    pageToMarkdown(PAGE_FILES.sr, { printed: "Šta je ispisano" }, pictures),
  );
  for (const name of pictures) {
    copyFileSync(join(ROOT, "src", "assets", "tutorial", name), join(outDir, name));
  }
}

/** What a chapter tells the reader to write: [{ path, kind: "file"|"diff", text }]. */
function chapterOf(md, step) {
  const start = md.search(new RegExp(`^## (Step|Korak) ${step}:`, "m"));
  if (start < 0) throw new Error(`no chapter ${step}`);
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  const body = end < 0 ? rest : rest.slice(0, end);
  return {
    body,
    entries: [...body.matchAll(/^(`{3,})(\w+) title="([^"]+)"\n([\s\S]*?)\n\1$/gm)].map((m) => ({
      path: m[3],
      kind: m[2] === "diff" ? "diff" : "file",
      text: `${m[4]}\n`,
    })),
  };
}

function applyChapter(entries, dir) {
  for (const { path, kind, text } of entries) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    if (kind === "file") {
      writeFileSync(target, text);
    } else {
      const r = spawnSync("patch", ["-p1", "--forward", "--no-backup-if-mismatch", "-s"], {
        cwd: dir,
        input: text,
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`patch ${path}: ${r.stdout}${r.stderr}`);
    }
  }
}

function checkout(sha, dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync(
    "sh",
    ["-c", `git archive ${sha} ${PROGRAM} | tar -x --strip-components=3 -C "${dir}"`],
    { cwd: REPO },
  );
  for (const path of CORRECTED) {
    if (existsSync(join(dir, path))) {
      writeFileSync(join(dir, path), git("show", `HEAD:${PROGRAM}/${path}`));
    }
  }
}

const tree = (dir) =>
  walk(dir)
    .map((path) => relative(dir, path))
    .filter((path) => !NOT_IN_A_CHAPTER.test(path) && !path.endsWith("/README.md"));

function check() {
  const work = mkdtempSync(join(tmpdir(), "tutorial-check-"));
  markdown(work);
  const failures = [];
  const pages = { en: "tutorial.md", sr: "tutorial.sr.md" };
  const firstPage = {};
  for (const [lang, name] of Object.entries(pages)) {
    const md = readFileSync(join(work, name), "utf8");
    for (const step of STEPS) {
      const before = join(work, lang, `before-${step}`);
      const wanted = join(work, lang, `wanted-${step}`);
      mkdirSync(before, { recursive: true });
      if (step > 1) checkout(commitOf(step - 1), before);
      checkout(commitOf(step), wanted);
      const { body, entries } = chapterOf(md, step);
      applyChapter(entries, before);

      const have = tree(before).sort();
      const want = tree(wanted).sort();
      for (const path of want.filter((p) => !have.includes(p))) {
        failures.push(`${lang} step ${step}: the chapter never writes ${path}`);
      }
      for (const path of have.filter((p) => !want.includes(p))) {
        failures.push(
          `${lang} step ${step}: the chapter writes ${path}, the commit has no such file`,
        );
      }
      for (const path of want.filter((p) => have.includes(p))) {
        if (!readFileSync(join(before, path)).equals(readFileSync(join(wanted, path)))) {
          failures.push(`${lang} step ${step}: ${path} differs from the commit`);
        }
      }
      for (const script of runScripts(step)) {
        const command = readFileSync(script, "utf8").trimEnd();
        if (!body.includes(command)) {
          failures.push(`${lang} step ${step}: ${basename(script)} is not in the chapter`);
        }
      }
      if (lang === "en") firstPage[step] = entries.map(({ path }) => path).join();
      else if (firstPage[step] !== entries.map(({ path }) => path).join()) {
        failures.push(
          `sr step ${step}: not the same files, in the same order, as the English page`,
        );
      }
      console.log(
        `${lang} step ${step}: ${entries.length} files, on ${commitOf(step).slice(0, 7)}`,
      );
    }
  }
  rmSync(work, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("tutorial ok: each chapter on a clean checkout of the step before is that step");
}

const runScripts = (step) =>
  walk(join(SNIPPETS, `step-${step}`, "run"))
    .filter((path) => path.endsWith(".sh"))
    .sort();

/** Volatile things in an answer: ids, times, durations, ports of the moment. */
const normalize = (text) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?/g, "<time>")
    .replace(/\d+(\.\d+)?m?s\b/g, "<ms>")
    .replace(/[ \t]+/g, " ")
    .trim();

/**
 * Chapter `step`'s commands, one bash session, in the program's folder. A fresh checkout of the
 * step before, brought to where that step leaves the reader, unless `dir` already is that: the
 * reader's own folder, from the steps before it.
 */
function run(step, keepDir) {
  const dir = resolve(
    keepDir ?? join(process.env.TUTORIAL_WORK ?? tmpdir(), `tutorial-step-${step}`),
  );
  const env = { ...process.env };
  const shell = (command, opts = {}) => {
    const r = spawnSync("bash", ["-c", command], { cwd: dir, env, stdio: "inherit", ...opts });
    if (r.status !== 0) throw new Error(`failed: ${command}`);
  };
  if (!keepDir) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (step > 1) {
      checkout(commitOf(step - 1), dir);
      shell("docker compose down -v --timeout 5 >/dev/null 2>&1 || true");
      shell(
        step > 2
          ? "sh scripts/setup.sh > /dev/null"
          : "docker compose up -d --build > /dev/null 2>&1",
      );
    } else {
      shell("docker compose -p ticket-desk down -v --timeout 5 >/dev/null 2>&1 || true");
    }
  } else {
    mkdirSync(dir, { recursive: true });
    if (step === 1) {
      shell("docker compose -p ticket-desk down -v --timeout 5 >/dev/null 2>&1 || true");
    }
  }

  const pages = mkdtempSync(join(tmpdir(), "tutorial-md-"));
  markdown(pages);
  const md = readFileSync(join(pages, "tutorial.md"), "utf8");
  applyChapter(chapterOf(md, step).entries, dir);

  const logs = join(dir, ".tutorial-run");
  mkdirSync(logs, { recursive: true });
  const lines = ["set +e"];
  for (const script of runScripts(step)) {
    const name = basename(script, ".sh");
    const text = readFileSync(script, "utf8").replaceAll(SITE, `file://${join(ROOT, "public")}`);
    const copy = join(logs, `${name}.sh`);
    writeFileSync(copy, text);
    lines.push(
      `echo "--- ${name}"`,
      `{ . "${copy}"; } > "${join(logs, `${name}.out`)}" 2>&1`,
      `echo "    exit $?"`,
    );
  }
  shell(lines.join("\n"));

  let failed = 0;
  for (const script of runScripts(step)) {
    const name = basename(script, ".sh");
    const got = readFileSync(join(logs, `${name}.out`), "utf8");
    const expectedFile = join(dirname(script), `${name}.out.txt`);
    if (!existsSync(expectedFile)) {
      console.log(`${name}: (nothing recorded for it)`);
      continue;
    }
    // Every recorded line appears, in order: an answer may print more than the page shows.
    const lines = normalize(got)
      .split("\n")
      .map((l) => l.trim());
    let at = 0;
    const missing = [];
    for (const line of normalize(readFileSync(expectedFile, "utf8")).split("\n")) {
      const want = line.trim();
      if (!want || want === "…") continue;
      const found = lines.findIndex((l, i) => i >= at && l.includes(want));
      if (found < 0) missing.push(want);
      else at = found + 1;
    }
    if (missing.length) {
      failed++;
      console.log(
        `${name}: DIFFERENT\n  not printed:\n${missing.map((m) => `    ${m}`).join("\n")}`,
      );
    } else {
      console.log(`${name}: as recorded`);
    }
  }
  console.log(
    `\nstep ${step}: ${failed ? `${failed} command(s) differ` : "every command as the page says"}; folder ${dir}`,
  );
  process.exit(failed ? 1 : 0);
}

const [command, a, b] = process.argv.slice(2);
if (command === "snippets") snippets();
else if (command === "md") markdown(resolve(a ?? "."));
else if (command === "check") check();
else if (command === "run") run(Number(a), b);
else {
  console.error("usage: tutorial.mjs snippets | md <dir> | check | run <step> [dir]");
  process.exit(2);
}
