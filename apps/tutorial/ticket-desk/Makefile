.PHONY: up setup down clean

up:
	docker compose up -d --build

# Tenants and keys in vola and memento, written to .env.
setup:
	sh scripts/setup.sh

down:
	docker compose down

# Everything, the data and the keys too.
clean:
	docker compose down -v
	rm -f .env
