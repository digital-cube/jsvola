.PHONY: up setup e2e down clean

up:
	docker compose up -d --build

# Tenants and keys in vola and memento, written to .env.
setup:
	sh scripts/setup.sh

# The main flow, against the stack that is up.
e2e:
	pnpm install --frozen-lockfile
	set -a; . ./.env; set +a; pnpm test:e2e

down:
	docker compose down

# Everything, the data and the keys too.
clean:
	docker compose down -v
	rm -f .env
