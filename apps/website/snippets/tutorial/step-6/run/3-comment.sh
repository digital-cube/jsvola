curl -s -X POST localhost:8080/tickets \
  -H 'x-user-id: igor' -H 'content-type: application/json' \
  -d '{"title":"Printer on fire"}' > /tmp/ticket.json
ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/ticket.json)
echo "http://localhost:8080/t/$ID"
