# @vol-a/website

The website of vola: **vol-a.com** (stage: <https://stage.vol-a.com>). Astro, with Starlight under
the documentation only; the home page and the 404 are the site's own pages. MDX content under
`src/content/docs` (the sidebar is in `astro.config.mjs`), Pagefind search in the docs. Private,
static, not part of the Docker image.

## Run and build

From the repository root (Node 24, pnpm from `packageManager`):

```sh
pnpm install
pnpm --filter @vol-a/website gen         # the generated pages (below); dev, build and typecheck run it first
pnpm --filter @vol-a/website dev         # http://localhost:4321
pnpm --filter @vol-a/website build       # apps/website/dist; fails on a broken internal link
pnpm --filter @vol-a/website preview     # serves dist/
pnpm --filter @vol-a/website typecheck   # gen + astro check + check:snippets (also in the root `pnpm typecheck`)
```

`.astro` and `.mdx` files are not linted by Biome (the root `biome.json` skips them); the rest of
`src/` is. The build needs no network.

## The look

Deliberately neither memento (cream paper, serif, red) nor jsudc.dev (white, stock Starlight, blue).
Vola is a service for bytes, so the site reads like an archive at night:

- **Dark first.** No stored choice means dark, whatever the system says
  (`src/components/ThemeProvider.astro`); `ThemeToggle.astro` replaces Starlight's three-way select.
  Light is grey card stock, complete but second. The tokens are `src/styles/tokens.css`, and both
  the home page and the docs read them; `src/styles/theme.css` maps them onto Starlight's variables.
- **One warm accent** (amber on dark, copper on light), hairlines instead of shadows and cards.
- **Archivo** at wide widths for headings, regular width for text, **JetBrains Mono** for everything
  that is on the wire. No serif, no italics.
- **Pictures come from the product** (`src/components/motifs/`): `ThumbState` (the one animation,
  202 to 200, honouring reduced motion), `ByteRuler` (the real bytes of the file, the recorded
  `Content-Range` lit), `ContactSheet` (renditions the server answered, at true pixel size),
  `SegmentDiagram` (`docs/CRYPTO.md` § 2), `HashTexture` (decorative, `aria-hidden`).

`scripts/contrast.mjs` checks every text colour of `tokens.css` against its grounds, AA in both
themes. Run it when you change a colour.

## Where each section comes from

| section | pages | source |
|---|---|---|
| Get started | `src/content/docs/get-started/*.mdx` | hand-written; the code from `snippets/` |
| Tutorials | `src/content/docs/tutorials/*.mdx`, one page per language (`-sr` is Serbian) | hand-written; the code from `snippets/tutorial/`, written from the program's `step N: …` commits (below) |
| Concepts | `src/content/docs/concepts/*.mdx` | hand-written from `docs/` (ARCHITECTURE, CRYPTO, REALTIME, EXAMPLES-SITE, MIGRATION-FROM-VOLA-SPP) |
| Reference | `src/content/docs/reference/*.md`, **generated, not in git** | `scripts/gen-reference.mjs`: `docs/API.md`, `docs/CRYPTO.md`, `docs/REALTIME.md`, `docs/CLI.md`, the environment-variable tables of `docs/DEPLOYMENT.md` |
| Examples | `src/content/docs/examples/*.mdx` | hand-written from `docs/EXAMPLES-SITE.md` and the pages' code, one per `menu.yaml` example; `<ExampleShot>` shows `src/assets/examples/<page>-light.webp` |
| Packages | `src/content/docs/packages/index.mdx`, `changelog.md`, **the changelog generated, not in git** | `<PackageTable>` reads `packages/*/package.json`; `scripts/gen-changelog.mjs` turns `CHANGELOG.md` into the page |

### `pnpm run gen`: the generated pages

`scripts/gen-reference.mjs` and `scripts/gen-changelog.mjs` (shared code in
`scripts/repo-markdown.mjs`) write the Reference section and Packages › Changelog from the
repository's markdown. A page's title is the file's H1 (or the section's heading), its description
the first sentence of the opening paragraph, and a note on top names the file and the commit it was
last changed in. Links between the docs become links between the pages (anchors included, checked by
the links validator); other repository links go to GitHub, and a link to a file that does not exist
fails `gen`. A doc that reads wrong as a public page is fixed in `docs/`, not in the generator. The
list of pages is `REFERENCE` in `scripts/repo-markdown.mjs`, in the order of the sidebar in
`astro.config.mjs`.

## Content: the code is files, the pictures are shots

**Code the site shows is a file of the repository imported `?raw`, never pasted into a page**, and
every screenshot is a real shot of the live examples site.

| home section (`src/components/home/`) | where its content comes from |
|---|---|
| `Hero.astro` | the hash from `snippets/wire/info.out.txt`, the install line from `snippets/docker/3-up.sh`, `ThumbState` |
| `OneFile.astro`: one file, every way to read it | `snippets/wire/<name>.req.txt` + `<name>.out.txt`; `src/assets/wire/aurora-<size>-<crop>.webp` |
| `Examples.astro`: the examples, live | `src/assets/examples/<page>-light.webp`; one line per page in `src/examples.mjs`, the routes of `menu.yaml` |
| `AtRest.astro`: encrypted at rest | `docs/CRYPTO.md` § 0 and § 2, in words and in `SegmentDiagram` |
| `Api.astro`: the API | `src/routes.mjs`, held to `docs/API.md` by `check:snippets`; `snippets/api/<n>-<step>.sh` + `.out.txt` |
| `QuickStarts.astro`: start where you are | `snippets/docker/<n>-<step>.sh` + `.out.txt`, `snippets/client/`, `snippets/react/App.tsx`, `snippets/embedded/server.ts` |
| `Packages.astro`: packages | `packages/*/package.json` at build time; the image tags of `docs/DEPLOYMENT.md` |

Every command there was run as written: the Docker steps in a scratch directory with their own
`COMPOSE_PROJECT_NAME` and ports, `snippets/client/read.ts` and `snippets/api/*.sh` against the live
examples. A `*.out.txt` is what the step printed then, with the key taken out of `4-key.out.txt`.

### `pnpm run capture`: the recorded requests and answers

```sh
VOLA_DEMO_WRITE_KEY=vola_live_… pnpm --filter @vol-a/website capture
```

`scripts/capture.mjs` uploads the demo pack's `aurora.jpg` with a few bytes appended, so the
thumbnails do not exist yet and the first answer really is a `202`, records the answers, downloads
the twelve renditions, then revokes the share and purges the file. It also runs `snippets/api/*.sh`
in one shell and writes their `.out.txt`. Records are 72 columns wide, UUIDs cut to eight characters
and hashes to sixteen; a file's and a share's JSON keep the fields the page talks about. The key
comes from the stage `.env` and is never written anywhere: requests show `$KEY`. `VOLA_URL` (default
`{EXAMPLE_URL}/vola`) points it elsewhere. Run it when an answer's shape changes, then commit the
files.

### `pnpm run shots`: the examples site's screenshots

```sh
pnpm --filter @vol-a/website exec playwright install chromium   # once
pnpm --filter @vol-a/website shots                              # or: shots -- browse share
```

`scripts/shots.mjs` (Playwright + sharp) opens each page of `src/examples.mjs` on `EXAMPLE_URL`
(`SHOTS_BASE` overrides it) at 1280×800, device scale 2, and writes
`src/assets/examples/<page>-light.webp`. Commit the webp files; the build only reads them.

**Look at them before you commit them.** Visitors upload to this instance, and it is public. The
script selects a seeded file on the pages with a file picker, because a picker opens on the newest
upload, and a shot of whatever a stranger uploaded must not end up on the site.

**Dark:** the examples site has no dark theme yet; forcing one wrote byte-identical files. So the
script takes the light theme only, and `<ExampleShot>` shows the light shot in both of the site's
themes, a little dimmed in dark. Add `"dark"` to `THEMES` once `apps/examples` has one, and
`ExampleShot.astro` picks up `<page>-dark.webp` by itself.

### `scripts/tutorial.mjs`: the tutorial and the history it is written from

The tutorial builds `apps/tutorial/ticket-desk` from an empty folder, a chapter per `step N: …`
commit. The site has no locales, because Starlight's would add an English `/sr/` copy of every other
page, so Serbian is one more page: `route.lang` comes from the `-sr` in its name (`src/routeData.ts`),
and both pages take their code from the same files, through `<TutorialFile>` and `<TutorialRun>`.

```sh
node scripts/tutorial.mjs snippets     # snippets/tutorial/step-N/files/ from the commits
node scripts/tutorial.mjs md <dir>     # each page as plain markdown: tutorial.md, tutorial.sr.md
node scripts/tutorial.mjs check        # each chapter on a clean checkout of the step before == that step
node scripts/tutorial.mjs run <n>      # chapter n's commands, as written, against a real stack
```

`snippets/tutorial/step-N/run/` is written by hand: the commands of a chapter, and in `*.out.txt` the
lines each one printed. `run` holds a command to its lines, leaves out ids, times and durations, and
brings the program's Docker stack up on this machine, dropping its data first. Set `VOLA_IMAGE` for
step 7 until a release has the audit fix. A mistake in a step's commit is fixed on top and listed in
`CORRECTED`, so the chapter shows the good file. `public/tutorials/ticket-desk/vendor/` holds the
tarballs chapter 1 downloads, the same ones as the program's `vendor/`, until the packages are on npm.

### `pnpm run check:snippets` (part of `typecheck`)

`scripts/check-snippets.mjs` fails on a code fence in Get started, on a `ts`/`js` fence in any
hand-written page, on code typed into a home section, on a `snippets/wire` request without its
recorded answer (or the other way round), on an API key in anything under `snippets/`, on a route of
`src/routes.mjs` that `docs/API.md` does not name, on a `menu.yaml` example without its page, and
runs `tsc -p snippets`: `server.ts`, `read.ts` and `App.tsx` compile against the workspace's
`@vol-a/server`, `@vol-a/core`, `@vol-a/client` and `@vol-a/react`, from their sources (the
`@vol-a/source` condition), so a renamed option breaks the check, not the reader.

## Build variables

Read once at build time by `src/site.mjs`; components and content import them instead of spelling a
host. The defaults are production's:

| variable | | default |
|---|---|---|
| `SITE_URL` | the site's own origin (Astro's `site`: canonical links, sitemap) | `https://vol-a.com` |
| `EXAMPLE_URL` | the examples site every "live example" link opens | `https://examples.stage.vol-a.com` |

No production examples instance exists yet; that default moves when one does.

## Deploy: stage

On the stage VM, from any copy of the repository:

```sh
deploy/website/stage.sh --install           # once: links the vhost into sites-enabled, reloads nginx, deploys
deploy/website/stage.sh                     # every deploy: builds origin/main and swaps it in
deploy/website/stage.sh --branch <name>     # a branch before review
```

Build-and-swap into `/home/digital/sites/stage.vol-a.com/releases/<short sha>`, the `current` symlink
nginx serves (`deploy/website/nginx/stage.vol-a.com.conf`), three releases kept, checked through
nginx and the edge. Details: [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-website).
