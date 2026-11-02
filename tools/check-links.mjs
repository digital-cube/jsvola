#!/usr/bin/env node
/**
 * Checks every RELATIVE link in the repository's Markdown documents: the target file must
 * exist, and a `#fragment` must name a heading of the target (GitHub's slug rules). External
 * links (`http:`, `https:`, `mailto:`) are not fetched. Exit 1 with one line per broken link.
 *
 *   node tools/check-links.mjs            # the whole repository
 *   node tools/check-links.mjs docs/API.md README.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".turbo",
  ".worktrees",
  ".thilo",
  "var",
  "secrets",
]);

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* markdownFiles(join(dir, entry.name));
    } else if (entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

/** GitHub's heading → anchor rule (github-slugger); a repeated heading gets -1, -2, … */
export function slugsOf(markdown) {
  const seen = new Map();
  const slugs = new Set();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[1]
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
      .replace(/<[^>]+>/g, "") // inline html
      .replace(/[`*~]/g, ""); // emphasis and code marks (underscores stay: GitHub keeps them)
    // github-slugger: lower case, drop everything but letters, digits, spaces, hyphens and
    // underscores, then ONE hyphen per space — "Range & streaming" is "range--streaming".
    let slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    slugs.add(slug);
  }
  return slugs;
}

/** Every `[text](target)` and `[ref]: target` in a document, outside fenced code, with its line. */
export function linksOf(markdown) {
  const links = [];
  let inFence = false;
  markdown.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const stripped = line.replace(/`[^`]*`/g, ""); // inline code is not a link
    for (const m of stripped.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ target: m[1], line: index + 1 });
    }
    const ref = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(stripped);
    if (ref) links.push({ target: ref[1], line: index + 1 });
  });
  return links;
}

const files =
  process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f)) : [...markdownFiles(root)];
const slugCache = new Map();
const slugsOfFile = (path) => {
  if (!slugCache.has(path)) slugCache.set(path, slugsOf(readFileSync(path, "utf8")));
  return slugCache.get(path);
};

const broken = [];
let checked = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { target, line } of linksOf(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, data:
    checked++;
    const [pathPart, fragment] = target.split("#");
    const decoded = decodeURIComponent(pathPart);
    const targetPath = decoded === "" ? file : resolve(dirname(file), decoded);
    const where = `${relative(root, file)}:${line}`;
    if (!existsSync(targetPath)) {
      broken.push(`${where}: ${target} → ${relative(root, targetPath)} does not exist`);
      continue;
    }
    if (fragment !== undefined && fragment !== "") {
      if (statSync(targetPath).isDirectory() || !targetPath.endsWith(".md")) {
        broken.push(`${where}: ${target} has a fragment but the target is not a Markdown file`);
        continue;
      }
      const slugs = slugsOfFile(targetPath);
      if (!slugs.has(fragment.toLowerCase())) {
        broken.push(
          `${where}: ${target} → no heading #${fragment} in ${relative(root, targetPath)}`,
        );
      }
    }
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken link(s) out of ${checked} in ${files.length} file(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(
  `links ok: ${checked} relative link(s) in ${files.length} Markdown file(s) under ${root.split(sep).pop()}`,
);
