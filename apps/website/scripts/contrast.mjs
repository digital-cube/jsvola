#!/usr/bin/env node
/**
 *   node scripts/contrast.mjs
 *
 * WCAG 2.1 contrast of every text colour of src/styles/tokens.css on every ground it is used on, in
 * both themes. Exit 1 below AA (4.5:1). Run it when a colour changes.
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  return Object.fromEntries(
    [
      ...css.slice(start, css.indexOf("}", start)).matchAll(/--vola-([\w-]+):\s*(#[0-9a-f]{6})/g),
    ].map((m) => [m[1], m[2]]),
  );
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const PAIRS = [
  ...["ink", "ink-2", "ink-3", "accent"].flatMap((text) =>
    ["ground", "surface", "raised"].map((ground) => [text, ground]),
  ),
  ["accent-ink", "accent"],
];
let failed = 0;
for (const [theme, tokens] of [
  ["dark", block(":root")],
  ["light", block(':root[data-theme="light"]')],
]) {
  for (const [text, ground] of PAIRS) {
    const value = ratio(tokens[text], tokens[ground]);
    const ok = value >= 4.5;
    if (!ok) failed++;
    console.log(
      `${theme.padEnd(6)}${text.padEnd(12)}on ${ground.padEnd(9)}${value.toFixed(2).padStart(6)}${ok ? "" : "  below AA"}`,
    );
  }
}
if (failed) process.exit(1);
