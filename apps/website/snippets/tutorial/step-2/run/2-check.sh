cut -d= -f1 .env | grep KEY
docker compose exec -T memento memento --json list-tenants | grep -o '"slug":"desk"'
docker compose exec -T vola vola --json list-keys --tenant desk | grep -o '"name":"[^"]*"'
