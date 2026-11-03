#!/bin/sh
# Makes a tenant called `desk` in vola and in memento, and the API keys the desk needs, and writes
# them to .env; then gives memento the sentences of the desk's events. Safe to run again: a key
# .env already has is kept.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env

memento() { docker compose exec -T memento memento --json "$@"; }
vola() { docker compose exec -T vola vola --json "$@"; }

# save_key NAME: reads a CLI answer from stdin and writes its "key" to .env as NAME=…
save_key() {
  key=$(sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
  [ -n "$key" ] || { echo "setup: no key came back for $1" >&2; exit 1; }
  echo "$1=$key" >> .env
  echo "  $1"
}
missing() { ! grep -q "^$1=." .env; }

echo "Starting the stack (the first time this builds the desk)…"
docker compose up -d --build

echo "Tenants…"
memento list-tenants | grep -q '"slug":"desk"' \
  || memento create-tenant desk --name "Ticket desk" > /dev/null
vola create-tenant --slug desk --name "Ticket desk" > /dev/null 2>&1 || true # already there

echo "Keys…"
# The backend writes events and reads a file's name.
missing MEMENTO_SERVER_KEY \
  && memento create-key --tenant desk --name desk-server --scopes write | save_key MEMENTO_SERVER_KEY
missing VOLA_SERVER_KEY \
  && vola create-key --tenant desk --name desk-server --scopes files:read | save_key VOLA_SERVER_KEY
# The browser reads the feed, and works with files directly on vola.
missing MEMENTO_BROWSER_KEY \
  && memento create-key --tenant desk --name desk-browser --scopes read | save_key MEMENTO_BROWSER_KEY
missing VOLA_BROWSER_KEY \
  && vola create-key --tenant desk --name desk-browser \
    --scopes files:read,files:write,folders:read,folders:write,shares:write \
  | save_key VOLA_BROWSER_KEY

echo "Templates…"
# templates/<EVENT_TYPE>.<locale>.hbs: the sentence memento renders for an event, in that language.
for file in templates/*.hbs; do
  name=$(basename "$file" .hbs)
  memento create-template --tenant desk --event-type "${name%.*}" --locale "${name##*.}" \
    --body "$(cat "$file")" --replace > /dev/null
done

echo "Restarting with the keys…"
docker compose up -d

port=$(sed -n 's/^DESK_PORT=//p' .env)
echo "Ready: http://localhost:${port:-8080}"
