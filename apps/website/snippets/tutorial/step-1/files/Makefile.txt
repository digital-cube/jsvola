.PHONY: up down clean

up:
	docker compose up -d --build

down:
	docker compose down

# Everything, the data too.
clean:
	docker compose down -v
