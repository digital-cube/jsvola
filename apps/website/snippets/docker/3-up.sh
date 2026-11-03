docker compose -f docker-compose.yaml up -d --build
until curl -sf localhost:8300/vola/health/ready; do sleep 2; done
