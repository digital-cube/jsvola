#!/usr/bin/env node
/**
 *   node scripts/gen-changelog.mjs        (npm run gen; dev, build and typecheck run it first)
 *
 * Packages › Changelog: the repository's CHANGELOG.md as a page,
 * src/content/docs/packages/changelog.md (git-ignored). One changelog for every @vol-a
 * package and the image: they share one version. Links into docs/ become the Reference pages
 * that hold them (scripts/gen-reference.mjs writes the same routes), the rest go to GitHub.
 * No network.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  anchorsOf,
  frontmatter,
  linkRewriter,
  readDoc,
  referencePages,
  SITE,
  sourceNote,
  wholeFile,
} from "./repo-markdown.mjs";

const OUT = join(SITE, "src", "content", "docs", "packages", "changelog.md");
const FILE = "CHANGELOG.md";

const { body } = wholeFile(readDoc(FILE));
// The Reference pages, so a link to docs/API.md#… lands on /reference/api/#….
const rewrite = linkRewriter([
  ...referencePages(),
  { route: "/packages/changelog/", file: FILE, label: "Changelog", anchors: anchorsOf(body) },
]);

await writeFile(
  OUT,
  [
    frontmatter({
      title: "Changelog",
      description:
        "Every release of vola's packages and Docker image, from the repository's CHANGELOG.md.",
      sidebar: { label: "Changelog", order: 1 },
      editUrl: false,
    }),
    `<!-- Written by scripts/gen-changelog.mjs from ${FILE}. Do not edit: the build rewrites it. -->`,
    "",
    sourceNote(FILE),
    "",
    ...rewrite(body, FILE),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n"),
);
console.log("gen-changelog: CHANGELOG.md → src/content/docs/packages/changelog.md");
