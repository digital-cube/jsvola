# vendor/

`@vol-a/*` and `@memento/*` are not on npm yet, so this program carries the five client packages
as tarballs and `pnpm-workspace.yaml` points their names here. The servers are NOT here: they
are the Docker images in `docker-compose.yaml`.

| tarball | built from |
|---|---|
| `vol-a-core`, `vol-a-client`, `vol-a-react` 1.0.1 | digital-cube/jsvola at `f6410bb` |
| `memento-core`, `memento-react` 1.0.0 | digital-cube/jsmemento at `748054c` |

Each one is `pnpm --filter <package>... build && pnpm pack` in that repository.

The day the packages are on npm: delete this folder and the `overrides` in
`pnpm-workspace.yaml`, replace each `file:vendor/…` in `package.json` with the version of its
tarball (`^1.0.1` for `@vol-a/*`, `^1.0.0` for `@memento/*`), run `pnpm install`. Nothing else
changes.
