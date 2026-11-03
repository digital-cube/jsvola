/**
 * Shared by scripts/gen-reference.mjs and scripts/gen-changelog.mjs: reading a markdown file
 * of the repository (docs/*.md, CHANGELOG.md) and turning it into a Starlight page.
 *
 *   readDoc(path)            the file split into lines, with its headings (outside code fences)
 *   section(doc, heading)    one `##`/`###` section of it, its headings moved up to `##`
 *   sourceOf(path)           the commit the file was last changed in (git), for the page's note
 *   linkRewriter(pages)      rewrites the links of a page: to another generated page and anchor
 *                            when one holds the target, else to the file on GitHub
 *
 * Nothing here needs the network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

export const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(SITE, "..", "..");
export const REPO = "https://github.com/digital-cube/jsvola";
/** Links to the production site inside the docs become paths of this site. */
const SITE_ORIGIN = "https://vol-a.com";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** A heading's text as a person reads it: no backticks, no link syntax. */
export const plain = (md) =>
  md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** `{lines, headings: [{index, level, text}]}` of a repository file. */
export function readDoc(path) {
  const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
  const headings = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m) headings.push({ index, level: m[1].length, text: m[2] });
    }
  });
  return { path, lines, headings };
}

/** The whole file below its H1: `{title, body}`. */
export function wholeFile(doc) {
  const h1 = doc.headings[0];
  if (h1?.level !== 1) throw new Error(`${doc.path}: no H1 on top to take the title from`);
  return { title: plain(h1.text), body: doc.lines.slice(h1.index + 1), shift: 0 };
}

/** One section, up to the next heading of its level or higher; its subheadings start at `##`. */
export function section(doc, heading) {
  const at = doc.headings.findIndex((h) => plain(h.text) === heading);
  if (at < 0) throw new Error(`${doc.path}: no section "${heading}"`);
  const h = doc.headings[at];
  const next = doc.headings.slice(at + 1).find((n) => n.level <= h.level);
  const body = doc.lines.slice(h.index + 1, next ? next.index : doc.lines.length);
  return { title: plain(h.text), body, shift: h.level - 1, anchor: slug(h.text) };
}

const slug = (text) => new GithubSlugger().slug(plain(text));

/** Move every heading of `body` up by `shift` levels (outside code fences). */
export function shiftHeadings(body, shift) {
  if (!shift) return body;
  let fenced = false;
  return body.map((line) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return line;
    const m = HEADING.exec(line);
    return m ? `${"#".repeat(Math.max(2, m[1].length - shift))} ${m[2]}` : line;
  });
}

/** The anchors a page's headings get: Astro slugs them with github-slugger, as GitHub does. */
export function anchorsOf(body) {
  const slugger = new GithubSlugger();
  const anchors = new Set();
  let fenced = false;
  for (const line of body) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m) anchors.add(slugger.slug(plain(m[2])));
    }
  }
  return anchors;
}

/** The first sentence of the first paragraph: the page's description. */
export function firstSentence(body, where) {
  let fenced = false;
  const paragraph = [];
  for (const line of body) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      if (paragraph.length) break;
      continue;
    }
    if (fenced) continue;
    if (!line.trim()) {
      if (paragraph.length) break;
      continue;
    }
    if (/^\s*([|#>*-]|\d+\.)/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  if (!paragraph.length) throw new Error(`${where}: no opening paragraph for the description`);
  const text = plain(paragraph.join(" "));
  const end = text.search(/[.:](\s|$)/);
  return end > 0 ? text.slice(0, end + 1).replace(/:$/, ".") : text;
}

/** `{sha, short, dirty}` of the last commit that changed `path`, or null outside git. */
export function sourceOf(path) {
  try {
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const sha = git("log", "-1", "--format=%H", "--", path);
    if (!sha) return null;
    return { sha, short: sha.slice(0, 7), dirty: git("status", "--porcelain", "--", path) !== "" };
  } catch {
    return null;
  }
}

/** The `:::note` a generated page opens with: which file, which commit. */
export function sourceNote(path, what = `[\`${path}\`](${REPO}/blob/main/${path})`) {
  const src = sourceOf(path);
  const at = src
    ? ` at commit [\`${src.short}\`](${REPO}/commit/${src.sha})${src.dirty ? " (with changes not committed yet)" : ""}`
    : "";
  return [
    ":::note[Generated from the repository]",
    `${what}${at}, turned into this page when the site was built. To change the page, edit the file.`,
    ":::",
  ].join("\n");
}

/**
 * `pages`: `[{route, file, anchor?, anchors}]`, every page generated from a repository file
 * (`anchor`: the section a page is, when it is one section of `file`). Returns
 * `(lines, from) => lines` that rewrites every inline link of a page made from `from`:
 *
 *   - `#x`, `FILE.md`, `FILE.md#x` (relative to `from`): the generated page holding it, when
 *     there is one (an anchor must be a heading of that page, or the section itself);
 *   - any other path of the repository: the file (or directory) on GitHub — a target that does
 *     not exist fails the build;
 *   - `https://vol-a.com/…`: the same path on this site.
 *
 * A link whose text is only a file name (`[REALTIME.md](REALTIME.md)`) that lands on a generated
 * page is labelled with that page's `label`.
 */
export function linkRewriter(pages) {
  const resolve = (target, from) => {
    if (target.startsWith(SITE_ORIGIN)) return { href: target.slice(SITE_ORIGIN.length) || "/" };
    if (/^[a-z]+:/i.test(target) || target.startsWith("/")) return { href: target };
    const [rawPath, anchor = ""] = target.split("#");
    const path = rawPath
      ? posix.normalize(posix.join(posix.dirname(from), rawPath)).replace(/\/$/, "")
      : from;
    if (path.startsWith("..")) throw new Error(`${from}: link ${target} leaves the repository`);
    for (const page of pages.filter((p) => p.file === path)) {
      if (!anchor && !page.anchor) return { href: page.route, page };
      if (anchor && page.anchor === anchor) return { href: page.route, page };
      if (anchor && page.anchors.has(anchor)) return { href: `${page.route}#${anchor}`, page };
    }
    const abs = join(ROOT, path);
    if (!existsSync(abs)) throw new Error(`${from}: link ${target} → ${path} does not exist`);
    const kind = statSync(abs).isDirectory() ? "tree" : "blob";
    return { href: `${REPO}/${kind}/main/${path}${anchor ? `#${anchor}` : ""}` };
  };
  // A link that reads as a file name (`[REALTIME.md](REALTIME.md)`) takes the page's name instead.
  const label = (text, page) =>
    page?.label && /^`?[\w.-]+\.md`?$/.test(text.trim()) ? page.label : text;
  return (lines, from) => {
    let fenced = false;
    return lines.map((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      if (fenced) return line;
      // One pass: a code span or a link, whichever starts first, so a `[x](y)` inside
      // backticks stays as written and a link whose text is code is still a link.
      return line.replace(
        /`[^`]*`|(!?)\[((?:[^\]`]|`[^`]*`)*)\]\(([^)\s]+)\)/g,
        (match, bang, text, target) => {
          if (target === undefined) return match;
          const { href, page } = resolve(target, from);
          return `${bang}[${label(text, page)}](${href})`;
        },
      );
    });
  };
}

/** Frontmatter of a generated page. */
export function frontmatter(fields) {
  const yaml = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) =>
      typeof v === "object"
        ? `${k}:\n${Object.entries(v)
            .map(([kk, vv]) => `  ${kk}: ${JSON.stringify(vv)}`)
            .join("\n")}`
        : `${k}: ${JSON.stringify(v)}`,
    );
  return ["---", ...yaml, "---", ""].join("\n");
}

/**
 * The Reference section, in the sidebar's order (astro.config.mjs lists the same slugs):
 * a whole doc below its H1, or one section of a doc.
 */
export const REFERENCE = [
  { slug: "api", file: "docs/API.md", label: "HTTP API" },
  { slug: "crypto", file: "docs/CRYPTO.md", label: "Encryption" },
  { slug: "realtime", file: "docs/REALTIME.md", label: "Real-time" },
  { slug: "cli", file: "docs/CLI.md", label: "CLI" },
  {
    slug: "environment",
    file: "docs/DEPLOYMENT.md",
    section: "Environment variables",
    label: "Environment variables",
  },
];

/** Every Reference page read from its file: route, title, body, anchors, description. */
export function referencePages() {
  return REFERENCE.map((s, i) => {
    const doc = readDoc(s.file);
    const part = s.section ? section(doc, s.section) : wholeFile(doc);
    const body = shiftHeadings(part.body, part.shift);
    return {
      ...s,
      order: i + 1,
      route: `/reference/${s.slug}/`,
      title: part.title,
      anchor: part.anchor,
      body,
      anchors: anchorsOf(body),
      description: firstSentence(body, s.section ? `${s.file} › ${s.section}` : s.file),
    };
  });
}
