#!/bin/sh
# `thilo.toml` [testing] command: tools/test-full.mjs with Node 24+ and pnpm on PATH.
#
# A thilo runner starts the command from a service whose PATH has no nvm in it, so when `node`
# (24 or newer) or `pnpm` is not found, the newest Node >= 24 under $NVM_DIR (default ~/.nvm)
# is put first on PATH. Anything else is up to the caller's PATH. Arguments are passed through.
set -eu
cd "$(dirname "$0")/.."

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
}

if ! node_ok || ! command -v pnpm >/dev/null 2>&1; then
  best=""
  for dir in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin; do
    [ -x "$dir/node" ] || continue
    major=$(basename "$(dirname "$dir")" | sed 's/^v//; s/\..*//')
    [ "$major" -ge 24 ] 2>/dev/null || continue
    best=$(printf '%s\n%s\n' "$best" "$dir" | sed '/^$/d' | sort -V | tail -n 1)
  done
  [ -n "$best" ] && PATH="$best:$PATH" && export PATH
fi

if ! node_ok; then
  echo "test-full: Node.js 24 or newer is not on PATH (nor under \$NVM_DIR)." >&2
  exit 2
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "test-full: pnpm is not on PATH — \`corepack enable\` (package.json pins pnpm)." >&2
  exit 2
fi

exec node tools/test-full.mjs "$@"
