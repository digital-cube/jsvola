#!/usr/bin/env bash
# Deploy https://vol-a.com (the vola website, apps/website) on digitalcube-production-websites,
# build-and-swap, the same steps as deploy/website/stage.sh on another machine:
#   clone or fetch digital-cube/jsvola (with its tags) into $ROOT/src -> check out
#   origin/<branch> (default main) -> pnpm (the repo's packageManager, through corepack)
#   install of @vol-a/website and its dependencies only -> build with SITE_URL=https://vol-a.com
#   (and EXAMPLE_URL only when it is set; otherwise src/site.mjs's default) -> apps/website/dist
#   to releases/<short sha> -> atomically repoint `current` -> keep the last three releases
#   -> 200 and the site's 404 through nginx, 200 with this build's canonical through the edge.
# Idempotent: when releases/<short sha> already holds that commit built with the same variables
# and `current` points at it, nothing is rebuilt or moved; the script only checks the site again.
# The vhost (deploy/website/nginx/vol-a.com.conf) is linked from $ROOT/src, so a deploy that
# changes it reloads nginx; --install links it the first time and keeps the hand-written
# "coming soon" vhost as sites-available/vol-a.com.coming-soon.
# The footer and the Packages table are read at build time (apps/website/src/build-info.mjs):
# the commit and the release from git (hence the full checkout with tags), the packages from
# registry.npmjs.org (the VM needs a way out to it; without one the build still succeeds and
# the table says "unknown").
# Works from any copy of the script (scp it to /tmp for the first run): it deploys what the
# remote branch has, not the checkout it was started from. After the first run it lives in
# $ROOT/src/deploy/website/prod.sh.
#
# Usage: deploy/website/prod.sh [--install] [--branch <name>] [--force]
set -euo pipefail

ROOT=/home/digital/sites/vol-a.com
SRC="$ROOT/src"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
NODE_LINK="$ROOT/node" # -> the nvm bin dir the build runs with
REPO_URL="${REPO_URL:-https://github.com/digital-cube/jsvola.git}"
HOST=vol-a.com
SITE_URL="https://$HOST"
EXPECTED_HOST=digitalcube-production-websites
EXPECTED_USER=digital
APP=apps/website
VHOST_REL="deploy/website/nginx/$HOST.conf"
VHOST_SRC="$SRC/$VHOST_REL"
VHOST_AVAILABLE="/etc/nginx/sites-available/$HOST"
VHOST_ENABLED="/etc/nginx/sites-enabled/$HOST"
KEEP=3

usage() {
  cat <<EOF
Usage: deploy/website/prod.sh [--install] [--branch <name>] [--force]

Runs ON $EXPECTED_HOST as $EXPECTED_USER. Builds $SITE_URL ($APP of $REPO_URL)
into $ROOT:
  src/                   the checkout (detached at origin/<branch>, with the tags)
  releases/<short sha>/  one built $APP/dist per commit, the last $KEEP kept
  current -> releases/…  what nginx serves, swapped atomically
  node -> ~/.nvm/…/bin   the Node the build runs with (newest installed v24)
then checks / (200) and a missing page (the site's 404) through nginx on 127.0.0.1, and /
through the edge (200 with this build's canonical link).

  --install        link the vhost: the hand-written "coming soon" $VHOST_AVAILABLE
                   is kept as $VHOST_AVAILABLE.coming-soon (its page in /var/www/$HOST
                   is not touched), $VHOST_AVAILABLE -> src/$VHOST_REL,
                   $VHOST_ENABLED -> $VHOST_AVAILABLE, nginx -t, reload; then deploy
                   (once per VM; harmless to repeat)
  --branch <name>  branch to build (default: main; e.g. jsvola before it is merged)
  --force          rebuild even when the release for this commit is already current
  -h, --help       this text

Build variables (src/site.mjs): SITE_URL is $SITE_URL; EXAMPLE_URL is passed to the build
only when it is set in the environment, otherwise the build uses site.mjs's default.
NODE_BIN (default: the newest ~/.nvm/versions/node/v24.*/bin, linked as node/) is where node
and corepack come from.
REPO_URL (default the GitHub repository) is what src/ fetches; a local path deploys commits
that are not pushed yet. The next run without it fetches from GitHub again.

Exit codes: 0 deployed, 1 a step failed, 2 usage, 3 refused (root, another host or user,
a missing tool, no passwordless sudo), 5 nginx on this VM does not answer as expected,
6 this VM answers 200 but https://$HOST does not (the edge).
EOF
}

INSTALL=0
BRANCH=main
FORCE=0
while (($#)); do
  case "$1" in
    --install) INSTALL=1 ;;
    --branch)
      [[ $# -ge 2 && -n "$2" ]] || { echo "prod.sh: --branch needs a name" >&2; exit 2; }
      BRANCH="$2"
      shift
      ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "prod.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() { # die <exit code> <message...>
  local code="$1"
  shift
  echo "prod.sh: $*" >&2
  exit "$code"
}

# Everything below is in functions, read whole before they run: when this script is
# $SRC/deploy/website/prod.sh, the checkout step rewrites it under a running bash.
main() {
  [[ $EUID -ne 0 ]] || die 3 "refusing to run as root — run it as $EXPECTED_USER"
  [[ "$(hostname)" == "$EXPECTED_HOST" ]] ||
    die 3 "refusing to run on $(hostname) — this script deploys production on $EXPECTED_HOST"
  [[ "$(id -un)" == "$EXPECTED_USER" ]] || die 3 "refusing to run as $(id -un) — the site belongs to $EXPECTED_USER"
  local tool
  for tool in git curl flock sudo sha256sum; do
    command -v "$tool" >/dev/null || die 3 "$tool is required (sudo apt install $tool)"
  done
  sudo -n true 2>/dev/null || die 3 "passwordless sudo is required (nginx)"
  # A production NODE_ENV would make pnpm skip the devDependencies the build needs (astro).
  unset NODE_ENV

  mkdir -p "$RELEASES"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || die 1 "another deploy of $HOST is running"

  echo "==> node"
  pick_node
  export PATH="$NODE_LINK:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  [[ -x "$NODE_LINK/corepack" ]] || die 1 "no corepack in $(readlink "$NODE_LINK")"
  echo "    $NODE_LINK -> $(readlink "$NODE_LINK") ($(node --version))"

  echo "==> source ($SRC)"
  if [[ ! -d "$SRC/.git" ]]; then
    timeout 300 git clone --quiet "$REPO_URL" "$SRC"
  fi
  git -C "$SRC" remote set-url origin "$REPO_URL"
  # --tags: the footer names the newest v<x.y.z> tag reachable from the built commit.
  timeout 120 git -C "$SRC" fetch --quiet --prune --tags --force origin
  git -C "$SRC" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null ||
    die 1 "origin has no branch $BRANCH"
  # sites-available links into this checkout: a commit without the vhost would leave nginx a
  # dangling include, and the next reload of any site on the VM would fail.
  git -C "$SRC" cat-file -e "origin/$BRANCH:$VHOST_REL" 2>/dev/null ||
    die 1 "origin/$BRANCH has no $VHOST_REL, refusing to check it out"

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
    install_vhost
  elif [[ "$(readlink "$VHOST_AVAILABLE" 2>/dev/null)" != "$VHOST_SRC" ||
    "$(readlink "$VHOST_ENABLED" 2>/dev/null)" != "$VHOST_AVAILABLE" ]]; then
    die 1 "$VHOST_ENABLED -> $VHOST_AVAILABLE -> $VHOST_SRC is not linked; run deploy/website/prod.sh --install"
  elif [[ "$vhost_before" != "$vhost_after" ]]; then
    sudo -n nginx -t
    sudo -n systemctl reload nginx
    echo "    the vhost changed, nginx reloaded"
  else
    echo "    unchanged"
  fi

  # What a release was built from; a release is reused only when all of it matches.
  local stamp release="$RELEASES/$sha"
  stamp="$(printf 'commit=%s\nsite_url=%s\nexample_url=%s\n' \
    "$(git -C "$SRC" rev-parse HEAD)" "$SITE_URL" "${EXAMPLE_URL:-(site.mjs default)}")"

  if ((!FORCE)) && [[ -f "$release/.release" && "$(cat "$release/.release")" == "$stamp" ]]; then
    echo "==> build: releases/$sha already has $sha for these variables, not rebuilding"
  else
    # pnpm is the version the repository pins in package.json's packageManager.
    echo "==> pnpm install (@vol-a/website and its dependencies)"
    (cd "$SRC" && timeout 600 corepack pnpm install --frozen-lockfile --filter "@vol-a/website...")
    echo "==> build (SITE_URL=$SITE_URL EXAMPLE_URL=${EXAMPLE_URL:-<site.mjs default>})"
    (
      cd "$SRC"
      export SITE_URL
      [[ -n "${EXAMPLE_URL:-}" ]] && export EXAMPLE_URL
      timeout 600 corepack pnpm --filter @vol-a/website build
    )
    [[ -f "$SRC/$APP/dist/index.html" ]] || die 1 "the build left no $APP/dist/index.html"

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
  echo "prod.sh: $SITE_URL serves $BRANCH at $sha"
}

newest_node24() {
  find "$HOME/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v24.*' 2>/dev/null |
    sort -V | tail -n 1 | sed 's:$:/bin:'
}

# node/ -> NODE_BIN when it is set, else the newest installed Node 24 (nvm install 24 if none).
pick_node() {
  local bin="${NODE_BIN:-}"
  if [[ -z "$bin" ]]; then
    bin="$(newest_node24)"
    if [[ -z "$bin" || ! -x "$bin/node" ]]; then
      [[ -s "$HOME/.nvm/nvm.sh" ]] || die 1 "no Node 24 under ~/.nvm and no nvm to install one"
      echo "    no Node 24 under ~/.nvm — nvm install 24"
      # shellcheck source=/dev/null
      (. "$HOME/.nvm/nvm.sh" && timeout 600 nvm install 24 >/dev/null)
      bin="$(newest_node24)"
    fi
  fi
  [[ -n "$bin" && -x "$bin/node" ]] || die 1 "no node at ${bin:-<none>}"
  if [[ "$(readlink "$NODE_LINK" 2>/dev/null)" != "$bin" ]]; then
    ln -sfn "$bin" "$ROOT/.node.tmp"
    mv -T "$ROOT/.node.tmp" "$NODE_LINK"
  fi
}

# sites-available/vol-a.com -> $VHOST_SRC, sites-enabled -> sites-available, as every site
# on this VM. The hand-written "coming soon" vhost that was there stays beside it as
# $VHOST_AVAILABLE.coming-soon (nginx includes only sites-enabled/*); its page in
# /var/www/vol-a.com is not touched.
install_vhost() {
  [[ -f "$VHOST_SRC" ]] || die 1 "no $VHOST_SRC in the checkout"
  if [[ -f "$VHOST_AVAILABLE" && ! -L "$VHOST_AVAILABLE" ]]; then
    if [[ -e "$VHOST_AVAILABLE.coming-soon" ]]; then
      die 1 "$VHOST_AVAILABLE is a regular file and $VHOST_AVAILABLE.coming-soon exists already; move one of them by hand"
    fi
    echo "    keeping the previous regular file as $VHOST_AVAILABLE.coming-soon"
    sudo -n mv "$VHOST_AVAILABLE" "$VHOST_AVAILABLE.coming-soon"
  fi
  sudo -n ln -sfn "$VHOST_SRC" "$VHOST_AVAILABLE"
  sudo -n ln -sfn "$VHOST_AVAILABLE" "$VHOST_ENABLED"
  sudo -n nginx -t
  sudo -n systemctl reload nginx
  echo "    $VHOST_ENABLED -> $VHOST_AVAILABLE -> $VHOST_SRC, nginx reloaded"
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
  # The body is checked, not only the status: for a moment after a reload nginx's old
  # workers may still answer, and the "coming soon" vhost gave every path a 200.
  local deadline=$((SECONDS + 30))
  until [[ "$(local_code /no-such-page/)" == 404 ]] || ((SECONDS >= deadline)); do sleep 1; done
  code="$(local_code /)"
  if [[ "$code" != 200 ]]; then
    echo "prod.sh: FAILED — nginx on this VM answers $code for $HOST, not 200" >&2
    echo "  curl -sI -H 'Host: $HOST' http://127.0.0.1/ ; tail /var/log/nginx/$HOST.error.log" >&2
    exit 5
  fi
  echo "    200"
  code="$(local_code /no-such-page/)"
  if [[ "$code" != 404 ]] ||
    ! curl -s --max-time 15 -H "Host: $HOST" http://127.0.0.1/no-such-page/ | grep -q 'Nothing is stored at this address'; then
    echo "prod.sh: FAILED — a missing page answers $code, not the site's 404" >&2
    exit 5
  fi
  echo "    a missing page: 404 (the site's)"
  echo "==> $SITE_URL/"
  local body
  body="$(curl -s -w '\n%{http_code}' --max-time 30 "$SITE_URL/" || true)"
  code="${body##*$'\n'}"
  if [[ "$code" != 200 ]] || [[ "$body" != *"<link rel=\"canonical\" href=\"$SITE_URL/\""* ]]; then
    echo "prod.sh: FAILED — this VM answers 200 but $SITE_URL/ answers $code without this build:" >&2
    echo "  the edge in front of this VM does not route $HOST here" >&2
    exit 6
  fi
  echo "    200, this build"
}

main
exit
