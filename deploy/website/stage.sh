#!/usr/bin/env bash
# Deploy https://stage.vol-a.com (the vola website, apps/website) on this VM, build-and-swap,
# the way jsmemento's deploy/website/stage.sh deploys stage.memento-service.org:
#   clone or fetch digital-cube/jsvola into $ROOT/src -> check out origin/<branch>
#   (default main) -> pnpm (the repo's packageManager, through corepack) install of
#   @vola/website and its dependencies only -> build with
#   SITE_URL=https://stage.vol-a.com and EXAMPLE_URL=https://examples.stage.vol-a.com
#   -> apps/website/dist to releases/<short sha> -> atomically repoint `current`
#   -> keep the last three releases -> 200 through nginx and through the edge.
# Idempotent: when releases/<short sha> already holds that commit built with the same two
# variables and `current` points at it, nothing is rebuilt or moved; the script only checks the
# site again.
# The vhost (deploy/website/nginx/stage.vol-a.com.conf) is linked from $ROOT/src, so
# a deploy that changes it reloads nginx; --install links it the first time.
# Works from any copy of the script: it deploys what the remote branch has, not the checkout
# it was started from.
#
# REPO_URL may be a local path, to deploy commits not pushed yet (--help).
#
# Usage: deploy/website/stage.sh [--install] [--branch <name>] [--force]
set -euo pipefail

ROOT=/home/digital/sites/stage.vol-a.com
SRC="$ROOT/src"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
REPO_URL="${REPO_URL:-https://github.com/digital-cube/jsvola.git}"
HOST=stage.vol-a.com
SITE_URL="https://$HOST"
EXAMPLE_URL="${EXAMPLE_URL:-https://examples.stage.vol-a.com}"
NODE_BIN="${NODE_BIN:-/home/digital/.nvm/versions/node/v24.19.0/bin}"
APP=apps/website
VHOST_REL="deploy/website/nginx/$HOST.conf"
VHOST_SRC="$SRC/$VHOST_REL"
VHOST_ENABLED="/etc/nginx/sites-enabled/$HOST"
KEEP=3

usage() {
  cat <<EOF
Usage: deploy/website/stage.sh [--install] [--branch <name>] [--force]

Builds $SITE_URL ($APP of $REPO_URL) into $ROOT:
  src/                   the checkout (detached at origin/<branch>)
  releases/<short sha>/  one built $APP/dist per commit, the last $KEEP kept
  current -> releases/…  what nginx serves, swapped atomically
then checks / (200) and a missing page (404) through nginx on 127.0.0.1, and / through the edge.

  --install        link the vhost into $VHOST_ENABLED, nginx -t, reload,
                   then deploy (once per VM; harmless to repeat)
  --branch <name>  branch to build (default: main; e.g. jsvola for a worktree's branch
                   before review)
  --force          rebuild even when the release for this commit is already current
  -h, --help       this text

Build variables (src/site.mjs): SITE_URL is $SITE_URL; EXAMPLE_URL (default
https://examples.stage.vol-a.com) may be overridden from the environment.
NODE_BIN (default the nvm Node 24) is where node and corepack come from.
REPO_URL (default the GitHub repository) is what src/ fetches; a local path
(REPO_URL=/home/digital/work/jsvola) deploys commits that are not pushed yet. The next run
without it fetches from GitHub again.

Exit codes: 0 deployed, 1 a step failed, 2 usage, 5 nginx on this VM does not answer as
expected, 6 this VM answers 200 but https://$HOST does not (the edge).
EOF
}

INSTALL=0
BRANCH=main
FORCE=0
while (($#)); do
  case "$1" in
    --install) INSTALL=1 ;;
    --branch)
      [[ $# -ge 2 ]] || { echo "stage.sh: --branch needs a name" >&2; exit 2; }
      BRANCH="$2"
      shift
      ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "stage.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Everything below is one function, read whole before it runs: when this script is
# $SRC/deploy/website/stage.sh, the checkout step rewrites it under a running bash.
main() {
  export PATH="$NODE_BIN:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  [[ -x "$NODE_BIN/node" ]] || { echo "stage.sh: no node at $NODE_BIN (nvm install 24)" >&2; exit 1; }
  [[ -x "$NODE_BIN/corepack" ]] || { echo "stage.sh: no corepack at $NODE_BIN" >&2; exit 1; }

  # Before the examples stack moved out, this path was its compose checkout.
  if [[ -e "$ROOT/docker-compose.yaml" ]]; then
    echo "stage.sh: $ROOT is a compose checkout, not a website root; move it first (docs/EXAMPLES-SITE.md, \"Stage deploy\")" >&2
    exit 1
  fi
  mkdir -p "$RELEASES"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || { echo "stage.sh: another deploy of $HOST is running" >&2; exit 1; }

  echo "==> source ($SRC)"
  if [[ ! -d "$SRC/.git" ]]; then
    timeout 300 git clone --quiet "$REPO_URL" "$SRC"
  fi
  git -C "$SRC" remote set-url origin "$REPO_URL"
  timeout 120 git -C "$SRC" fetch --quiet --prune origin
  git -C "$SRC" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null ||
    { echo "stage.sh: origin has no branch $BRANCH" >&2; exit 1; }
  # sites-enabled links into this checkout: a commit without the vhost would leave nginx a
  # dangling include, and the next reload of any site on the VM would fail.
  git -C "$SRC" cat-file -e "origin/$BRANCH:$VHOST_REL" 2>/dev/null ||
    { echo "stage.sh: origin/$BRANCH has no $VHOST_REL, refusing to check it out" >&2; exit 1; }

  local vhost_before="" vhost_after=""
  [[ -f "$VHOST_SRC" ]] && vhost_before="$(sha256sum <"$VHOST_SRC")"
  git -C "$SRC" checkout --quiet --force --detach "origin/$BRANCH"
  git -C "$SRC" clean --quiet -ffdx -e node_modules
  [[ -f "$VHOST_SRC" ]] && vhost_after="$(sha256sum <"$VHOST_SRC")"

  local sha
  sha="$(git -C "$SRC" rev-parse --short=7 HEAD)"
  echo "    $BRANCH at $sha: $(git -C "$SRC" log -1 --format=%s)"

  echo "==> nginx vhost"
  if ((INSTALL)); then
    sudo ln -sfn "$VHOST_SRC" "$VHOST_ENABLED"
    sudo nginx -t
    sudo systemctl reload nginx
    echo "    $VHOST_ENABLED -> $VHOST_SRC, nginx reloaded"
  elif [[ "$(readlink "$VHOST_ENABLED" 2>/dev/null)" != "$VHOST_SRC" ]]; then
    echo "stage.sh: $VHOST_ENABLED is not linked to $VHOST_SRC; run deploy/website/stage.sh --install" >&2
    exit 1
  elif [[ "$vhost_before" != "$vhost_after" ]]; then
    sudo nginx -t
    sudo systemctl reload nginx
    echo "    the vhost changed, nginx reloaded"
  else
    echo "    unchanged"
  fi

  # What a release was built from; a release is reused only when all of it matches.
  local stamp release="$RELEASES/$sha"
  stamp="$(printf 'commit=%s\nsite_url=%s\nexample_url=%s\n' \
    "$(git -C "$SRC" rev-parse HEAD)" "$SITE_URL" "$EXAMPLE_URL")"

  if ((!FORCE)) && [[ -f "$release/.release" && "$(cat "$release/.release")" == "$stamp" ]]; then
    echo "==> build: releases/$sha already has $sha for these variables, not rebuilding"
  else
    # pnpm is the version the repository pins in package.json's packageManager.
    echo "==> pnpm install (@vola/website and its dependencies)"
    (cd "$SRC" && timeout 600 corepack pnpm install --frozen-lockfile --filter "@vola/website...")
    echo "==> build (SITE_URL=$SITE_URL EXAMPLE_URL=$EXAMPLE_URL)"
    (cd "$SRC" && SITE_URL="$SITE_URL" EXAMPLE_URL="$EXAMPLE_URL" \
      timeout 600 corepack pnpm --filter @vola/website build)
    [[ -f "$SRC/$APP/dist/index.html" ]] || { echo "stage.sh: the build left no $APP/dist/index.html" >&2; exit 1; }

    local next="$release.new"
    rm -rf "$next"
    cp -a "$SRC/$APP/dist" "$next"
    printf '%s\n' "$stamp" >"$next/.release"
    if [[ -e "$release" ]]; then
      # A rebuild of the same commit: serve .new while the old copy is replaced.
      swap "$sha.new"
      rm -rf "$release"
      cp -a "$next" "$release"
      swap "$sha"
      rm -rf "$next"
    else
      mv "$next" "$release"
    fi
  fi

  if [[ "$(readlink "$CURRENT" 2>/dev/null)" == "releases/$sha" ]]; then
    echo "==> current: already releases/$sha"
  else
    touch "$release"
    swap "$sha"
    echo "==> current -> releases/$sha"
  fi

  echo "==> prune (keep $KEEP)"
  local old
  # newest first by the time each release became current; never the current one
  ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP + 1)) | while read -r old; do
    [[ "$old" == "$RELEASES/$sha" ]] && continue
    echo "    removing releases/${old##*/}"
    rm -rf "$old"
  done

  check
  echo "stage.sh: $SITE_URL serves $BRANCH at $sha"
}

# Point `current` at releases/<name> with one rename(2): no moment without it.
swap() {
  ln -sfn "releases/$1" "$ROOT/.current.tmp"
  mv -T "$ROOT/.current.tmp" "$CURRENT"
}

local_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Host: $HOST" "http://127.0.0.1$1" || true
}

check() {
  local code
  echo "==> http://127.0.0.1/ (Host: $HOST)"
  code="$(local_code /)"
  if [[ "$code" != 200 ]]; then
    echo "stage.sh: FAILED — nginx on this VM answers $code for $HOST, not 200" >&2
    echo "  curl -sI -H 'Host: $HOST' http://127.0.0.1/ ; tail /var/log/nginx/stage.vol-a.com.error.log" >&2
    exit 5
  fi
  echo "    200"
  # The site's own 404, not the examples stack's answer.
  code="$(local_code /no-such-page/)"
  if [[ "$code" != 404 ]] ||
    ! curl -s --max-time 15 -H "Host: $HOST" http://127.0.0.1/no-such-page/ | grep -q 'Nothing is stored at this address'; then
    echo "stage.sh: FAILED — a missing page answers $code, not the site's 404" >&2
    exit 5
  fi
  echo "    a missing page: 404 (the site's)"
  echo "==> $SITE_URL/"
  local body
  body="$(curl -s -w '\n%{http_code}' --max-time 30 "$SITE_URL/" || true)"
  code="${body##*$'\n'}"
  # The canonical link names the stage origin only in this build, not in the examples stack.
  if [[ "$code" != 200 ]] || [[ "$body" != *"<link rel=\"canonical\" href=\"$SITE_URL/\""* ]]; then
    echo "stage.sh: FAILED — this VM answers 200 but $SITE_URL/ answers $code without this build:" >&2
    echo "  the edge in front of this VM does not route $HOST here" >&2
    exit 6
  fi
  echo "    200, this build"
}

main
exit
