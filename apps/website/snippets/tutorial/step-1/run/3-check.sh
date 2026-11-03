curl -s --retry 20 --retry-all-errors --retry-delay 1 localhost:8080/health; echo
docker compose ps --format '{{.Service}}: {{.State}}'
