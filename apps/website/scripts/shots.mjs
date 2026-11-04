#!/usr/bin/env node
/**
 *   pnpm run shots [-- <name> ...]
 *
 * The home page's "The examples, live" and the Examples pages: one screenshot per page of the
 * examples site, the whole window, written as src/assets/examples/<name>-<theme>.webp. Re-run it
 * when an example's look changes; the webp files are committed and the build only reads them.
 *
 * Themes. The examples site has no dark theme yet: forcing one writes the same pixels (checked
 * byte for byte when this script was written). So THEMES is ["light"] and the site shows the light
 * shot in both of its own themes. Once apps/examples has a dark theme, add "dark" here and run this
 * again; ExampleShot.astro picks up <name>-dark.webp by itself.
 *
 * SHOTS_BASE     the examples site to shoot (default EXAMPLE_URL from src/site.mjs)
 * SHOTS_SCALE    device pixel ratio (default 2)
 * SHOTS_CHANNEL  a browser Playwright did not download, e.g. `chrome` (default: Playwright's own
 *                Chromium, `pnpm --filter @vol-a/website exec playwright install chromium` once)
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { EXAMPLES } from "../src/examples.mjs";
import { EXAMPLE_URL } from "../src/site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "assets", "examples");
const BASE = (process.env.SHOTS_BASE || EXAMPLE_URL).replace(/\/$/, "");
const SCALE = Number(process.env.SHOTS_SCALE || 2);
const VIEWPORT = { width: 1280, height: 800 };
const THEMES = ["light"];
/**
 * The file a page with a file picker opens on. Visitors upload to this instance and a picker starts
 * on the newest file, so without this a stranger's upload ends up in a committed screenshot. Look
 * at the shots before committing them all the same: these are public pages anyone can write to.
 */
const FILE = { thumbnails: "aurora.jpg", share: "aurora.jpg", streaming: "clip.mp4" };
/** How long a page gets after its data arrived; the thumbnails of a list draw after it. */
const SETTLE = { browse: 2500, thumbnails: 3500, streaming: 2500 };

const only = process.argv.slice(2);
const shots = only.length ? EXAMPLES.filter((e) => only.includes(e.name)) : EXAMPLES;
if (only.length && shots.length !== only.length) {
  console.error(`unknown shot; known: ${EXAMPLES.map((e) => e.name).join(", ")}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.SHOTS_CHANNEL || undefined });
try {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: theme,
      locale: "en-GB",
      timezoneId: "Europe/Belgrade",
    });
    // @jsudc/react keeps theme and language in localStorage; set both before any script runs.
    await context.addInitScript((t) => {
      localStorage.setItem("udc-theme", t);
      localStorage.setItem("udc-locale", "en");
      localStorage.setItem("vola-examples-locale", "en");
    }, theme);
    const page = await context.newPage();
    for (const shot of shots) {
      await page.goto(BASE + shot.path, { waitUntil: "networkidle" });
      await page.locator("main").first().waitFor();
      await page
        .locator(".udc-skeleton")
        .first()
        .waitFor({ state: "detached", timeout: 15_000 })
        .catch(() => {});
      if (FILE[shot.name]) {
        await page.locator("main select").first().selectOption({ label: FILE[shot.name] });
        await page.waitForLoadState("networkidle");
      }
      await page.evaluate(() => {
        /** @type {HTMLElement} */ (document.activeElement)?.blur();
        for (const el of document.querySelectorAll("*")) el.scrollTop = 0;
      });
      await page.mouse.move(0, VIEWPORT.height - 1);
      await page.waitForTimeout(SETTLE[shot.name] ?? 1200);
      const png = await page.screenshot({ animations: "disabled", caret: "hide" });
      await sharp(png)
        .webp({ quality: 82 })
        .toFile(join(OUT, `${shot.name}-${theme}.webp`));
      console.log(`${theme.padEnd(5)} ${shot.name.padEnd(12)} ${page.url()}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
