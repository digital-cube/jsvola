// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { SITE_URL } from "./src/site.mjs";
import codeDark from "./src/styles/code-dark.json" with { type: "json" };
import codeLight from "./src/styles/code-light.json" with { type: "json" };

export default defineConfig({
  site: SITE_URL,
  integrations: [
    starlight({
      title: "vola",
      description:
        "A self-hosted, multi-tenant, content-addressable file service: uploads, Range and streaming, thumbnails and OCR, folders and versions, share links, encryption per file.",
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/digital-cube/jsvola",
        },
      ],
      // The home page and the 404 are the site's own Astro pages (src/pages/), not Starlight's.
      disable404Route: true,
      components: {
        PageTitle: "./src/components/PageTitle.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        // Dark first: no stored choice means dark, whatever the system says (ThemeToggle.astro).
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeToggle.astro",
      },
      expressiveCode: {
        themes: [codeDark, codeLight],
        defaultProps: { wrap: true, preserveIndent: true, frame: "code" },
        // A tab stays a tab: a Makefile copied from the tutorial does not work with spaces.
        tabWidth: 0,
        styleOverrides: {
          borderRadius: "0",
          borderColor: "var(--vola-rule)",
          codeFontFamily: "var(--sl-font-mono)",
          uiFontFamily: "var(--sl-font-mono)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.65",
          frames: {
            shadowColor: "transparent",
            editorTabBarBackground: "transparent",
            editorTabBarBorderBottomColor: "var(--vola-rule)",
            editorActiveTabBackground: "transparent",
            editorActiveTabForeground: "var(--vola-ink-3)",
            editorActiveTabIndicatorTopColor: "transparent",
            editorActiveTabIndicatorBottomColor: "transparent",
            editorActiveTabBorderColor: "transparent",
          },
        },
      },
      customCss: [
        "@fontsource-variable/archivo/wdth.css",
        "@fontsource-variable/jetbrains-mono/wght.css",
        "./src/styles/tokens.css",
        "./src/styles/theme.css",
      ],
      sidebar: [
        { label: "Get started", items: [{ autogenerate: { directory: "get-started" } }] },
        // Hand-written, one page per language; the code comes from the program's history.
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorials" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        {
          // Written by scripts/gen-reference.mjs from docs/ (pnpm run gen; REFERENCE in
          // scripts/repo-markdown.mjs has the same order).
          label: "Reference",
          items: [
            "reference",
            "reference/api",
            "reference/crypto",
            "reference/realtime",
            "reference/cli",
            "reference/environment",
          ],
        },
        { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
        {
          label: "Packages",
          // changelog: written by scripts/gen-changelog.mjs from CHANGELOG.md.
          items: ["packages", "packages/changelog"],
        },
      ],
      /* The home page is an Astro page and its sections are components: the validator sees
         neither `/` nor their anchors. */
      plugins: [
        starlightLinksValidator({
          exclude: ({ link }) => link === "/" || link.startsWith("/#"),
        }),
      ],
      routeMiddleware: "./src/routeData.ts",
      lastUpdated: false,
      pagination: true,
    }),
  ],
});
