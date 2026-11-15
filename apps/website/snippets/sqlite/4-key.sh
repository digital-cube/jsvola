npx vola create-tenant --slug acme --name "Acme Inc"
npx vola create-key --tenant acme --name backend --env live \
  --scopes files:read,files:write,folders:read,folders:write,shares:write
