# vendor/

`@vola/*` and `@memento/*` are not on npm yet, so this program carries the five client packages
as tarballs and `pnpm-workspace.yaml` points their names here. The servers are NOT here: they
are the Docker images in `docker-compose.yaml`.

| tarball | built from |
|---|---|
| `vola-core`, `vola-client`, `vola-react` 1.0.0 | digital-cube/jsvola at `334a67c` |
| `memento-core`, `memento-react` 1.0.0 | digital-cube/jsmemento at `748054c` |

Each one is `pnpm --filter <package>... build && pnpm pack` in that repository.

The day the packages are on npm: delete this folder and the `overrides` in
`pnpm-workspace.yaml`, put `^1.0.0` in `package.json`, run `pnpm install`. Nothing else changes.
