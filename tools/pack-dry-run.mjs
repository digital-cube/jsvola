#!/usr/bin/env node
/**
 * `pnpm pack --dry-run` in every PUBLIC workspace package (`private: true` ones are skipped):
 * proves that each one packs — `files`, `exports`, `main`/`bin` targets exist after a build —
 * and prints what npm would receive. Exit 1 on the first failure.
 *
 *   pnpm build && pnpm pack:dry
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const dirs = ["packages", "apps"].flatMap((group) => {
  const base = join(root, group);
  return existsSync(base) ? readdirSync(base).map((name) => join(base, name)) : [];
});

let packed = 0;
for (const dir of dirs) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) {
    console.log(`skip  ${manifest.name} (private)`);
    continue;
  }
  for (const field of [
    "name",
    "version",
    "license",
    "repository",
    "files",
    "exports",
    "description",
  ]) {
    if (manifest[field] === undefined) {
      console.error(`${manifest.name}: package.json has no "${field}"`);
      process.exit(1);
    }
  }
  if (manifest.repository?.directory !== dir.slice(root.length + 1)) {
    console.error(
      `${manifest.name}: repository.directory is "${manifest.repository?.directory}", expected "${dir.slice(root.length + 1)}"`,
    );
    process.exit(1);
  }
  const entry = manifest.exports?.["."]?.import ?? manifest.main;
  if (entry && !existsSync(join(dir, entry))) {
    console.error(`${manifest.name}: ${entry} does not exist — run pnpm build first`);
    process.exit(1);
  }
  console.log(`pack  ${manifest.name}@${manifest.version}`);
  const result = spawnSync("pnpm", ["pack", "--dry-run"], { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${manifest.name}: pnpm pack --dry-run failed`);
    process.exit(result.status ?? 1);
  }
  packed++;
}
console.log(`packed ${packed} public package(s) (dry run)`);
