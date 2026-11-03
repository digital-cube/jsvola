#!/usr/bin/env node
/**
 *   node scripts/gen-reference.mjs        (npm run gen; dev, build and typecheck run it first)
 *
 * The Reference section, written from the repository's docs so it cannot drift from them:
 * every page under src/content/docs/reference/ comes from here, the directory is git-ignored.
 * The list is REFERENCE in scripts/repo-markdown.mjs:
 *
 *   reference/api          docs/API.md
 *   reference/crypto       docs/CRYPTO.md
 *   reference/realtime     docs/REALTIME.md
 *   reference/cli          docs/CLI.md
 *   reference/environment  docs/DEPLOYMENT.md, section "Environment variables"
 *   reference/index        the overview: the list above, with each page's description
 *
 * A page's title is the file's H1 (or the section's heading), its description the first
 * sentence of the opening paragraph; a note on top names the file and the commit it was last
 * changed in. Links between these docs become links between the pages (anchors included);
 * links to the rest of the repository go to GitHub, and one to a file that does not exist
 * fails here. When a doc reads wrong as a public page, edit the doc, not this script.
 * No network.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  frontmatter,
  linkRewriter,
  REPO,
  referencePages,
  SITE,
  sourceNote,
} from "./repo-markdown.mjs";

const OUT = join(SITE, "src", "content", "docs", "reference");
const pages = referencePages();
const rewrite = linkRewriter(pages);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const page of pages) {
  const what = page.section
    ? `The section “${page.section}” of [\`${page.file}\`](${REPO}/blob/main/${page.file}#${page.anchor})`
    : `[\`${page.file}\`](${REPO}/blob/main/${page.file})`;
  await writeFile(
    join(OUT, `${page.slug}.md`),
    [
      frontmatter({
        title: page.title,
        description: page.description,
        sidebar: { label: page.label, order: page.order },
        editUrl: false,
      }),
      `<!-- Written by scripts/gen-reference.mjs from ${page.file}. Do not edit: the build rewrites it. -->`,
      "",
      sourceNote(page.file, what),
      "",
      ...rewrite(page.body, page.file),
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

await writeFile(
  join(OUT, "index.md"),
  [
    frontmatter({
      title: "Reference",
      description:
        "Every route, encryption format, stream message, CLI command and environment variable of vola, generated from the repository's docs.",
      sidebar: { label: "Overview", order: 0 },
      editUrl: false,
    }),
    "<!-- Written by scripts/gen-reference.mjs. Do not edit: the build rewrites it. -->",
    "",
    "The exact facts: what each route takes and answers, the encrypted blob byte by byte, the",
    "frames of the live stream, every command of the CLI, every variable the server reads. Each page is a file of the repository's",
    `[\`docs/\`](${REPO}/tree/main/docs), turned into a page when this site is built, so the`,
    "reference and the repository say the same thing. For the ideas behind them, read",
    "[Concepts](/concepts/) first.",
    "",
    "| page | | from |",
    "| --- | --- | --- |",
    ...pages.map(
      (p) =>
        `| [${p.label}](${p.route}) | ${p.description.replace(/\|/g, "\\|")} | \`${p.file}\`${p.section ? `, “${p.section}”` : ""} |`,
    ),
    "",
  ].join("\n"),
);

console.log(
  `gen-reference: ${pages.length} pages + index → src/content/docs/reference/ (${pages.map((p) => p.slug).join(", ")})`,
);
