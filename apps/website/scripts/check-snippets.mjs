#!/usr/bin/env node
/**
 *   pnpm run check:snippets        (also the last step of `pnpm run typecheck`)
 *
 * The code the home page and Get started show is a file of the repository imported `?raw`
 * (snippets/), never typed into a page. This keeps it that way:
 *
 *   1. no code fence under get-started/, and no ts/tsx/js/jsx fence in any hand-written page: their
 *      code comes from snippets/ (the pages scripts/gen-*.mjs writes from docs/ and CHANGELOG.md are
 *      those files, so they are left out). The home page is src/components/home/: a raw <pre> holding
 *      literal code there fails too, it must render a snippet;
 *   2. snippets/wire/: every `<name>.req.txt` has the `<name>.out.txt` scripts/capture.mjs recorded
 *      for it, and the other way round; each answer starts with a status line;
 *   3. nothing recorded holds a key: no `vola_live_…`, `vola_test_…` or `vola_admin_…` with a value;
 *   4. the routes table of the home page (src/routes.mjs) follows docs/API.md: a route it lists
 *      that the document does not name fails here;
 *   5. every page of menu.yaml has its page under examples/, and the other way round;
 *   6. `tsc -p snippets`: the embedded server, the client program and the React app compile against
 *      the workspace's @vola/server, @vola/core, @vola/client and @vola/react (their sources,
 *      through the `@vola/source` condition), so a renamed option fails here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../src/routes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const DOCS = join(ROOT, "src", "content", "docs");
const SNIPPETS = join(ROOT, "snippets");
const WIRE = join(SNIPPETS, "wire");
const HOME = join(ROOT, "src", "components", "home");
const failures = [];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

// --- 1. no code typed into the pages -----------------------------------------------------
for (const file of walk(DOCS)) {
  if (!/\.mdx?$/.test(file)) continue;
  const path = relative(DOCS, file);
  const strict = path.startsWith("get-started/");
  const text = readFileSync(file, "utf8");
  if (/^<!-- Written by scripts\/gen-/m.test(text)) continue;
  for (const m of text.matchAll(/^\s*```(\w*)/gm)) {
    if (!strict && !/^(ts|tsx|js|jsx|typescript|javascript)$/.test(m[1] ?? "")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    failures.push(`src/content/docs/${path}:${line}: a \`\`\`${m[1]} fence; put it in snippets/`);
  }
}
for (const file of walk(HOME)) {
  const text = readFileSync(file, "utf8");
  if (/^\s*```/m.test(text) || /<pre[^>]*>\s*[^<{\s]/.test(text)) {
    failures.push(`${relative(ROOT, file)}: code typed into the page; put it in snippets/`);
  }
}

// --- 2. the recorded requests and answers ------------------------------------------------
const wire = readdirSync(WIRE);
for (const name of wire) {
  if (!/\.(req|out)\.txt$/.test(name)) {
    failures.push(`snippets/wire/${name}: not a .req.txt or an .out.txt`);
    continue;
  }
  const other = name.endsWith(".req.txt")
    ? name.replace(/\.req\.txt$/, ".out.txt")
    : name.replace(/\.out\.txt$/, ".req.txt");
  if (!wire.includes(other)) {
    failures.push(
      name.endsWith(".req.txt")
        ? `snippets/wire/${name}: no recorded answer ${other}; run pnpm run capture`
        : `snippets/wire/${name}: an answer to no request (${other})`,
    );
  }
  if (
    name.endsWith(".out.txt") &&
    !/^HTTP\/\d(\.\d)? \d{3}/.test(readFileSync(join(WIRE, name), "utf8"))
  ) {
    failures.push(`snippets/wire/${name}: does not start with a status line`);
  }
}

// --- 3. no key in what is shown ----------------------------------------------------------
for (const file of walk(SNIPPETS)) {
  if (/vola_(live|test|admin)_[A-Za-z0-9]{8,}/.test(readFileSync(file, "utf8"))) {
    failures.push(`${relative(ROOT, file)}: holds an API key`);
  }
}

// --- 4. the routes table follows docs/API.md ---------------------------------------------
const api = readFileSync(join(REPO, "docs", "API.md"), "utf8");
for (const { doc } of ROUTES) {
  if (!api.includes(doc)) failures.push(`src/routes.mjs: docs/API.md does not name "${doc}"`);
}

// --- 5. a page per example ---------------------------------------------------------------
const menu = readFileSync(join(REPO, "menu.yaml"), "utf8");
const examples = [...menu.matchAll(/url: \/examples\/([\w-]+)/g)].map((m) => m[1]);
const pages = readdirSync(join(DOCS, "examples"))
  .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
  .map((f) => f.replace(/\.mdx$/, ""));
for (const name of examples) {
  if (!pages.includes(name)) failures.push(`menu.yaml: no page examples/${name}.mdx`);
}
for (const page of pages) {
  if (!examples.includes(page)) failures.push(`examples/${page}.mdx: not in menu.yaml`);
}

// --- 6. compile ------------------------------------------------------------------------
const tsc = join(ROOT, "node_modules", ".bin", "tsc");
if (!existsSync(tsc)) failures.push("no node_modules/.bin/tsc: pnpm install first");
else {
  const r = spawnSync(tsc, ["-p", SNIPPETS], { stdio: "inherit" });
  if (r.status !== 0) failures.push("tsc -p snippets failed (above)");
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("snippets ok: no typed code in the pages, wire/ recorded, snippets compile");
