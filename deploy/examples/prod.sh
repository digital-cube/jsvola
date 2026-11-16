#!/usr/bin/env bash
# Deploy https://examples.vol-a.com (the vola examples stack: @vol-a/server with VOLA_EXAMPLES=true,
# the site apps/examples, the demo tenant and its seeded pack) on digitalcube-production-websites,
# natively: no container (nothing on this VM is), two systemd user units, the VM's own
# PostgreSQL 18 and Redis.
#   clone or fetch digital-cube/jsvola into $ROOT/src -> check out origin/<branch> (default main)
#   -> when the commit changed: pnpm (the repo's packageManager, through corepack) install and
#   turbo build of @vol-a/server, @vol-a/cli and @vol-a/examples (the Dockerfile's filters)
#   -> restart vola-prod + vola-prod-worker (deploy/examples/systemd/, linked from the checkout)
#   -> wait for /vola/health/ready -> `vola demo-seed` (an upsert per slug: "N uploaded, M unchanged")
#   -> /vola/health/live and the site's <title> through nginx, /vola/examples/config through the edge.
# The server applies its Drizzle migrations at start; the worker follows the server.
# --install does the one-time steps (apt tools for OCR and PDF thumbnails, the PostgreSQL role
# and database, .env with generated secrets, the key and pepper files, the demo keys, linger, the
# units, the vhost); it is idempotent: what exists is kept, what is missing is added.
# No secret is printed: the database password, the demo keys, the key and the pepper exist only
# in $ROOT/.env (mode 600) and $ROOT/secrets/ (mode 700) on the VM.
# Works from any copy of the script (scp it to /tmp for the first run): it deploys what the
# remote branch has, not the checkout it was started from. After the first run it lives in
# $ROOT/src/deploy/examples/prod.sh.
#
# Usage: deploy/examples/prod.sh [--install] [--branch <name>] [--force] [--reseed]
set -euo pipefail

ROOT=/home/digital/sites/examples.vol-a.com
SRC="$ROOT/src"
ENV_FILE="$ROOT/.env"
SECRETS="$ROOT/secrets"
STORAGE="$ROOT/data/storage"       # VOLA_STORAGE_PATH, the CAS blobs: never removed by this script
CANDIDATES="$ROOT/data/candidates" # VOLA_CANDIDATES_DIR, outside src/ (git clean would empty it)
NODE_LINK="$ROOT/node"             # -> the nvm bin dir the units and the build run with
SHIMS="$ROOT/corepack"             # corepack's pnpm shim: the version package.json pins
VOLA_BIN="$ROOT/bin/vola"          # the CLI with this deployment's .env
BUILT="$ROOT/.built"               # the commit src/ was last built at
REPO_URL="${REPO_URL:-https://github.com/digital-cube/jsvola.git}"
HOST=examples.vol-a.com
SITE_URL="https://$HOST"
PORT=8300
API="http://127.0.0.1:$PORT/vola"
EXPECTED_HOST=digitalcube-production-websites
EXPECTED_USER=digital
UNITS=(vola-prod vola-prod-worker)
UNIT_REL=deploy/examples/systemd
UNIT_DIR="$HOME/.config/systemd/user"
VHOST_REL="deploy/examples/nginx/$HOST.conf"
VHOST_SRC="$SRC/$VHOST_REL"
VHOST_AVAILABLE="/etc/nginx/sites-available/$HOST"
VHOST_ENABLED="/etc/nginx/sites-enabled/$HOST"
DB_NAME=vola
DB_USER=vola
APT_PACKAGES=(tesseract-ocr tesseract-ocr-eng poppler-utils)
# the Dockerfile's build: the server, the CLI and the examples site, with their dependencies
FILTERS=(--filter=@vol-a/server... --filter=@vol-a/cli... --filter=@vol-a/examples)

usage() {
  cat <<EOF
Usage: deploy/examples/prod.sh [--install] [--branch <name>] [--force] [--reseed]

Runs ON $EXPECTED_HOST as $EXPECTED_USER. Deploys $SITE_URL ($REPO_URL) into $ROOT:
  src/            the checkout (detached at origin/<branch>), built in place
  data/storage/   VOLA_STORAGE_PATH, the blobs and thumbnails (never removed)
  data/candidates VOLA_CANDIDATES_DIR, unknown vocabulary values
  secrets/        mode 700: vola.key (VOLA_KEY_FILE), vola.pepper (VOLA_PEPPER_FILE)
  .env            mode 600: the configuration of both units and of bin/vola
  bin/vola        the vola CLI (src/packages/cli/dist/main.js) with .env loaded
  node -> ~/.nvm/…/bin   the Node the build and the units run (newest installed v24)
  corepack/       corepack's pnpm shim, first on PATH (the pnpm package.json pins)
Units (systemctl --user, linked from src/$UNIT_REL): ${UNITS[*]} on 127.0.0.1:$PORT.
Then: GET /vola/health/ready 200, \`vola demo-seed\`, /vola/health/live 200 and / with
<title>vola examples</title> through nginx on 127.0.0.1, /vola/examples/config 200 through the edge.

  --install        the one-time steps, harmless to repeat (what exists is kept):
                   apt-get install ${APT_PACKAGES[*]};
                   PostgreSQL role and database $DB_NAME with a generated password;
                   .env (missing variables are added, existing ones never changed);
                   vola keys-generate / pepper-generate into secrets/; vola demo-keys into .env;
                   loginctl enable-linger; link and enable the units; the vhost: a hand-written
                   $VHOST_AVAILABLE is kept as $VHOST_AVAILABLE.coming-soon,
                   $VHOST_AVAILABLE -> src/$VHOST_REL, $VHOST_ENABLED -> $VHOST_AVAILABLE,
                   nginx -t, reload; then the deploy
  --branch <name>  branch to deploy (default: main; e.g. jsvola before it is merged)
  --force          install and build even when src/ was already built at this commit
  --reseed         only run \`vola demo-seed\` again and the checks (no fetch, no build, no restart)
  -h, --help       this text

NODE_BIN (default: the newest ~/.nvm/versions/node/v24.*/bin, linked as node/) is where node
and corepack come from. REPO_URL (default the GitHub repository) is what src/ fetches; a local
path deploys commits that are not pushed yet. The next run without it fetches from GitHub again.
A deploy that rebuilds builds in src/ while the old processes still run, then restarts them:
the site answers from the old build until the restart (a few seconds of 502 then).

Exit codes: 0 deployed, 1 a step failed, 2 usage, 3 refused (root, another host or user,
a missing tool, no passwordless sudo, not installed yet), 4 the server did not get ready,
5 nginx on this VM does not answer as expected, 6 this VM answers but $SITE_URL does not (the edge).
EOF
}

INSTALL=0
BRANCH=main
FORCE=0
RESEED_ONLY=0
while (($#)); do
  case "$1" in
    --install) INSTALL=1 ;;
    --branch)
      [[ $# -ge 2 && -n "$2" ]] || { echo "prod.sh: --branch needs a name" >&2; exit 2; }
      BRANCH="$2"
      shift
      ;;
    --force) FORCE=1 ;;
    --reseed) RESEED_ONLY=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "prod.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if ((RESEED_ONLY && (INSTALL || FORCE))); then
  echo "prod.sh: --reseed runs alone (a deploy seeds anyway)" >&2
  exit 2
fi

die() { # die <exit code> <message...>
  local code="$1"
  shift
  echo "prod.sh: $*" >&2
  exit "$code"
}

sql() { sudo -n -u postgres psql -v ON_ERROR_STOP=1 -X -Atq "$@"; }

# Everything below is in functions, read whole before they run: when this script is
# $SRC/deploy/examples/prod.sh, the checkout step rewrites it under a running bash.
main() {
  [[ $EUID -ne 0 ]] || die 3 "refusing to run as root — run it as $EXPECTED_USER"
  [[ "$(hostname)" == "$EXPECTED_HOST" ]] ||
    die 3 "refusing to run on $(hostname) — this script deploys production on $EXPECTED_HOST"
  [[ "$(id -un)" == "$EXPECTED_USER" ]] || die 3 "refusing to run as $(id -un) — the site belongs to $EXPECTED_USER"
  local tool
  for tool in git curl flock sudo sha256sum openssl systemctl; do
    command -v "$tool" >/dev/null || die 3 "$tool is required (sudo apt install $tool)"
  done
  sudo -n true 2>/dev/null || die 3 "passwordless sudo is required (apt, psql as postgres, nginx, loginctl)"
  # NODE_ENV=production would make pnpm skip the devDependencies the build needs (tsc, vite);
  # the units get theirs from .env.
  unset NODE_ENV
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

  mkdir -p "$ROOT"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || die 1 "another deploy of $HOST is running"

  if ((RESEED_ONLY)); then
    [[ -f "$ENV_FILE" && -x "$VOLA_BIN" ]] || die 3 "not installed — run deploy/examples/prod.sh --install"
    wait_ready
    seed
    check
    echo "prod.sh: $SITE_URL reseeded"
    return
  fi

  echo "==> node"
  pick_node
  export PATH="$NODE_LINK:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  [[ -x "$NODE_LINK/corepack" ]] || die 1 "no corepack in $(readlink "$NODE_LINK")"
  # The nvm bin dir on this VM has a global pnpm of its own; turbo runs `pnpm run build` in
  # every package, which must be the pinned packageManager, so corepack's shim goes first.
  mkdir -p "$SHIMS"
  corepack enable --install-directory "$SHIMS" pnpm
  export PATH="$SHIMS:$PATH"
  [[ "$(command -v pnpm)" == "$SHIMS/pnpm" ]] || die 1 "pnpm on PATH is $(command -v pnpm), not $SHIMS/pnpm"
  echo "    $NODE_LINK -> $(readlink "$NODE_LINK") ($(node --version))"

  if ((INSTALL)); then
    echo "==> install: apt ${APT_PACKAGES[*]}"
    install_apt
  fi
  if ! command -v tesseract >/dev/null || ! command -v pdftoppm >/dev/null; then
    die 3 "tesseract and pdftoppm are required — run deploy/examples/prod.sh --install"
  fi

  echo "==> source ($SRC)"
  if [[ ! -d "$SRC/.git" ]]; then
    timeout 300 git clone --quiet "$REPO_URL" "$SRC"
  fi
  git -C "$SRC" remote set-url origin "$REPO_URL"
  timeout 120 git -C "$SRC" fetch --quiet --prune origin
  git -C "$SRC" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null ||
    die 1 "origin has no branch $BRANCH"
  # sites-available and the user units link into this checkout: a commit without them would
  # leave nginx a dangling include (the next reload of any site on the VM fails) and systemd
  # a dangling unit.
  local f
  for f in "$VHOST_REL" "$UNIT_REL/vola-prod.service" "$UNIT_REL/vola-prod-worker.service"; do
    git -C "$SRC" cat-file -e "origin/$BRANCH:$f" 2>/dev/null ||
      die 1 "origin/$BRANCH has no $f, refusing to check it out"
  done

  local vhost_before="" vhost_after=""
  [[ -f "$VHOST_SRC" ]] && vhost_before="$(sha256sum <"$VHOST_SRC")"
  local target built=""
  target="$(git -C "$SRC" rev-parse "origin/$BRANCH")"
  [[ -f "$BUILT" ]] && built="$(cat "$BUILT")"
  git -C "$SRC" checkout --quiet --force --detach "origin/$BRANCH"
  # -x also removes ignored files; node_modules and the dist/ the running units load stay
  # (a build overwrites dist/ in place).
  git -C "$SRC" clean --quiet -ffdx -e node_modules -e dist
  [[ -f "$VHOST_SRC" ]] && vhost_after="$(sha256sum <"$VHOST_SRC")"
  local sha
  sha="$(git -C "$SRC" rev-parse --short=7 HEAD)"
  echo "    $BRANCH at $sha: $(git -C "$SRC" log -1 --format=%s)"

  if ((!FORCE)) && [[ "$built" == "$target" && -f "$SRC/packages/server/dist/server.js" ]]; then
    echo "==> build: src/ is already built at $sha, not rebuilding"
  else
    rm -f "$BUILT"
    # pnpm is the version the repository pins in package.json's packageManager.
    echo "==> pnpm install"
    (cd "$SRC" && timeout 900 corepack pnpm install --frozen-lockfile)
    echo "==> build (${FILTERS[*]})"
    (cd "$SRC" && timeout 900 corepack pnpm turbo run build "${FILTERS[@]}")
    for f in packages/server/dist/server.js packages/server/dist/worker.js \
      packages/cli/dist/main.js apps/examples/dist/index.html; do
      [[ -f "$SRC/$f" ]] || die 1 "the build left no $f"
    done
    printf '%s\n' "$target" >"$BUILT"
  fi
  write_cli

  if ((INSTALL)); then
    echo "==> install: PostgreSQL role and database $DB_NAME"
    install_db
    echo "==> install: secrets/ (the key file, the pepper file)"
    install_secrets
    echo "==> install: .env"
    install_env
    echo "==> install: linger (the units start at boot)"
    sudo -n loginctl enable-linger "$EXPECTED_USER"
    echo "==> install: units"
    install_units
  fi
  [[ -f "$ENV_FILE" ]] || die 3 "no $ENV_FILE — run deploy/examples/prod.sh --install"
  mkdir -p "$STORAGE" "$CANDIDATES"

  echo "==> units"
  local unit
  for unit in "${UNITS[@]}"; do
    [[ "$(readlink "$UNIT_DIR/$unit.service" 2>/dev/null)" == "$SRC/$UNIT_REL/$unit.service" ]] ||
      die 3 "$UNIT_DIR/$unit.service is not linked to the checkout; run deploy/examples/prod.sh --install"
  done
  # the unit files may have changed with the checkout
  timeout 30 systemctl --user daemon-reload
  timeout 90 systemctl --user restart "${UNITS[@]}"
  echo "    restarted ${UNITS[*]}"
  wait_ready
  wait_active

  echo "==> nginx vhost"
  if ((INSTALL)); then
    install_vhost
  elif [[ "$(readlink "$VHOST_AVAILABLE" 2>/dev/null)" != "$VHOST_SRC" ||
    "$(readlink "$VHOST_ENABLED" 2>/dev/null)" != "$VHOST_AVAILABLE" ]]; then
    die 3 "$VHOST_ENABLED -> $VHOST_AVAILABLE -> $VHOST_SRC is not linked; run deploy/examples/prod.sh --install"
  elif [[ "$vhost_before" != "$vhost_after" ]]; then
    sudo -n nginx -t
    sudo -n systemctl reload nginx
    echo "    the vhost changed, nginx reloaded"
  else
    echo "    unchanged"
  fi

  seed
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

install_apt() {
  local missing=() p
  for p in "${APT_PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p")
  done
  if ((${#missing[@]} == 0)); then
    echo "    installed"
    return
  fi
  timeout 300 sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing[@]}"
}

# bin/vola: the CLI of this checkout with this deployment's .env (the database, the key and
# pepper files, the demo write key and VOLA_URL for demo-seed).
write_cli() {
  mkdir -p "$(dirname "$VOLA_BIN")"
  cat >"$VOLA_BIN.tmp" <<EOF
#!/usr/bin/env bash
# written by deploy/examples/prod.sh: the vola CLI of $SRC with $ENV_FILE
set -a
# shellcheck source=/dev/null
[[ -r "$ENV_FILE" ]] && . "$ENV_FILE"
set +a
exec "$NODE_LINK/node" "$SRC/packages/cli/dist/main.js" "\$@"
EOF
  chmod 755 "$VOLA_BIN.tmp"
  mv -f "$VOLA_BIN.tmp" "$VOLA_BIN"
}

# Role $DB_USER and database $DB_NAME on the local PostgreSQL, the password only in .env.
# An existing VOLA_DATABASE_URL is kept; a missing one gets a fresh password set on the role.
install_db() {
  local have_role have_db pw
  have_role="$(sql -c "select 1 from pg_roles where rolname = '$DB_USER'")"
  have_db="$(sql -c "select 1 from pg_database where datname = '$DB_NAME'")"
  if [[ "$have_role" == 1 ]] && env_has VOLA_DATABASE_URL; then
    echo "    role $DB_USER exists and .env has VOLA_DATABASE_URL — kept"
  else
    pw="$(openssl rand -hex 24)"
    # the password goes to psql on stdin, not on a command line other users could read
    if [[ "$have_role" == 1 ]]; then
      echo "    role $DB_USER exists but .env has no VOLA_DATABASE_URL — new password"
      printf "alter role %s with login password '%s';\n" "$DB_USER" "$pw" | sql
    else
      echo "    create role $DB_USER"
      printf "create role %s with login password '%s';\n" "$DB_USER" "$pw" | sql
    fi
    env_set VOLA_DATABASE_URL "postgresql://$DB_USER:$pw@127.0.0.1:5432/$DB_NAME"
    echo "    VOLA_DATABASE_URL written to .env"
  fi
  if [[ "$have_db" == 1 ]]; then
    echo "    database $DB_NAME exists"
  else
    echo "    create database $DB_NAME owner $DB_USER"
    sql -c "create database $DB_NAME owner $DB_USER"
  fi
}

# secrets/vola.key and secrets/vola.pepper, generated once (the CLI refuses to overwrite).
install_secrets() {
  mkdir -p "$SECRETS"
  chmod 700 "$SECRETS"
  if [[ -f "$SECRETS/vola.key" ]]; then
    echo "    vola.key exists — kept"
  else
    "$VOLA_BIN" keys-generate --path "$SECRETS/vola.key" | sed -n 1p | sed 's/^/    /'
  fi
  if [[ -f "$SECRETS/vola.pepper" ]]; then
    echo "    vola.pepper exists — kept"
  else
    "$VOLA_BIN" pepper-generate --path "$SECRETS/vola.pepper" | sed -n 1p | sed 's/^/    /'
  fi
}

# .env: every variable the stack needs, added when missing, an existing value never changed.
# (Names: packages/server/src/config.ts; the CLI's VOLA_URL and VOLA_DEMO_ASSETS for demo-seed.)
install_env() {
  if ! env_has VOLA_DEMO_API_KEY || ! env_has VOLA_DEMO_WRITE_KEY; then
    local pair read write
    pair="$("$VOLA_BIN" --json demo-keys)"
    read="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).VOLA_DEMO_API_KEY)' "$pair")"
    write="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).VOLA_DEMO_WRITE_KEY)' "$pair")"
    [[ "$read" == vola_live_* && "$write" == vola_live_* ]] || die 1 "vola demo-keys did not print two keys"
    # a pair belongs together: both are replaced when one is missing
    env_set VOLA_DEMO_API_KEY "$read" force
    env_set VOLA_DEMO_WRITE_KEY "$write" force
    echo "    VOLA_DEMO_API_KEY, VOLA_DEMO_WRITE_KEY written (vola demo-keys)"
  fi
  local kv added=0
  for kv in \
    "NODE_ENV=production" \
    "VOLA_HOST=127.0.0.1" \
    "VOLA_PORT=$PORT" \
    "VOLA_PREFIX=/vola" \
    "VOLA_PUBLIC_URL=$SITE_URL" \
    "VOLA_TRUST_PROXY=true" \
    "VOLA_LOG_LEVEL=info" \
    "VOLA_REDIS_URL=redis://127.0.0.1:6379/2" \
    "VOLA_QUEUE_PREFIX=vola-prod" \
    "VOLA_STORAGE_PATH=$STORAGE" \
    "VOLA_CANDIDATES_DIR=$CANDIDATES" \
    "VOLA_KEY_FILE=$SECRETS/vola.key" \
    "VOLA_PEPPER_FILE=$SECRETS/vola.pepper" \
    "VOLA_UI_DIR=$SRC/apps/examples/dist" \
    "VOLA_EXAMPLES=true" \
    "VOLA_DEMO_TTL_HOURS=24" \
    "VOLA_DEMO_RATE_LIMIT=60" \
    "VOLA_OCR_ENABLED=auto" \
    "VOLA_OCR_LANGS=eng" \
    "VOLA_WORKER_CONCURRENCY=2" \
    "VOLA_URL=$API" \
    "VOLA_DEMO_ASSETS=$SRC/apps/examples/assets"; do
    if ! env_has "${kv%%=*}"; then
      env_set "${kv%%=*}" "${kv#*=}"
      added=$((added + 1))
    fi
  done
  chmod 600 "$ENV_FILE"
  echo "    $added variable(s) added, the rest kept (mode 600)"
}

env_has() { [[ -f "$ENV_FILE" ]] && grep -q "^$1=." "$ENV_FILE"; }

# env_set NAME VALUE [force]: append NAME=VALUE (force: drop an existing NAME line first).
# Created with umask 077; systemd's EnvironmentFile and bin/vola (bash) both read it.
env_set() {
  (
    umask 077
    if [[ ! -f "$ENV_FILE" ]]; then
      printf '# %s: the vola examples stack (docs/EXAMPLES-SITE.md "Production deploy"),\n# written by deploy/examples/prod.sh --install on %s; read by the units %s and bin/vola.\n' \
        "$HOST" "$(date -Is)" "${UNITS[*]}" >"$ENV_FILE"
    fi
    if [[ "${3:-}" == force ]]; then
      grep -v "^$1=" "$ENV_FILE" >"$ENV_FILE.tmp" || true
      mv -f "$ENV_FILE.tmp" "$ENV_FILE"
    fi
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

# ~/.config/systemd/user/<unit>.service -> src/deploy/examples/systemd/<unit>.service, enabled
# (started by the caller).
install_units() {
  mkdir -p "$UNIT_DIR"
  local unit dst
  for unit in "${UNITS[@]}"; do
    dst="$UNIT_DIR/$unit.service"
    if [[ -f "$dst" && ! -L "$dst" ]]; then
      echo "    $dst is a regular file, keeping it as $dst.bak"
      mv -f "$dst" "$dst.bak"
    fi
    ln -sfn "$SRC/$UNIT_REL/$unit.service" "$dst"
  done
  timeout 30 systemctl --user daemon-reload
  timeout 30 systemctl --user enable --quiet "${UNITS[@]}"
  echo "    ${UNITS[*]} linked from src/$UNIT_REL (enabled)"
}

# sites-available/examples.vol-a.com -> $VHOST_SRC, sites-enabled -> sites-available, as every
# site on this VM. The hand-written "coming soon" vhost that was there stays beside it as
# $VHOST_AVAILABLE.coming-soon (nginx includes only sites-enabled/*); its page in
# /var/www/examples.vol-a.com is not touched.
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

wait_ready() {
  echo "==> $API/health/ready"
  local code="" deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/health/ready" || true)"
    [[ "$code" == 200 ]] && break
    sleep 2
  done
  [[ "$code" == 200 ]] || die 4 "the server is not ready (last answer: ${code:-none}): journalctl --user -u vola-prod -n 50"
  echo "    200"
}

# Both units active; the worker may be between two attempts when it raced the migrations.
wait_active() {
  local unit deadline=$((SECONDS + 30))
  for unit in "${UNITS[@]}"; do
    until systemctl --user is-active --quiet "$unit" || ((SECONDS >= deadline)); do sleep 1; done
    systemctl --user is-active --quiet "$unit" ||
      die 4 "$unit is not active: journalctl --user -u $unit -n 50"
  done
  echo "    ${UNITS[*]}: active"
}

seed() {
  echo "==> vola demo-seed"
  if ! timeout 600 "$VOLA_BIN" demo-seed --wait 60 | sed 's/^/    /'; then
    die 1 "vola demo-seed failed (VOLA_DEMO_WRITE_KEY and VOLA_URL in .env; journalctl --user -u vola-prod -n 50)"
  fi
}

local_get() { # local_get <path>: the body, then the status on the last line
  curl -s -w '\n%{http_code}' --max-time 15 -H "Host: $HOST" "http://127.0.0.1$1" || true
}

check() {
  local body code
  echo "==> http://127.0.0.1/vola/health/live (Host: $HOST)"
  # Right after a reload nginx's old workers may still answer from the "coming soon" vhost,
  # which gave every path a 200 with its own page; wait for the server's JSON.
  local deadline=$((SECONDS + 30))
  until [[ "$(local_get /vola/health/live)" == *'"status":"ok"'*$'\n'200 ]] || ((SECONDS >= deadline)); do
    sleep 1
  done
  body="$(local_get /vola/health/live)"
  code="${body##*$'\n'}"
  if [[ "$code" != 200 || "$body" != *'"status":"ok"'* ]]; then
    echo "prod.sh: FAILED — nginx on this VM answers $code for $HOST/vola/health/live, not the server's 200" >&2
    echo "  curl -si -H 'Host: $HOST' http://127.0.0.1/vola/health/live ; tail /var/log/nginx/$HOST.error.log" >&2
    exit 5
  fi
  echo "    200"
  echo "==> http://127.0.0.1/ (Host: $HOST)"
  body="$(local_get /)"
  code="${body##*$'\n'}"
  if [[ "$code" != 200 || "$body" != *"<title>vola examples</title>"* ]]; then
    echo "prod.sh: FAILED — / answers $code without <title>vola examples</title> (VOLA_UI_DIR?)" >&2
    exit 5
  fi
  echo "    200, <title>vola examples</title>"
  echo "==> $SITE_URL/vola/examples/config"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$SITE_URL/vola/examples/config" || true)"
  if [[ "$code" != 200 ]]; then
    echo "prod.sh: FAILED — this VM answers but $SITE_URL/vola/examples/config answers $code:" >&2
    echo "  the edge in front of this VM does not route $HOST here" >&2
    exit 6
  fi
  echo "    200"
}

main
exit
