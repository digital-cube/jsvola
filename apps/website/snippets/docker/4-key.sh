docker compose -f docker-compose.yaml exec vola vola create-tenant --slug acme --name "Acme Inc"
docker compose -f docker-compose.yaml exec vola vola create-key --tenant acme --name backend \
  --env live --scopes files:read,files:write,folders:read,folders:write,shares:write
