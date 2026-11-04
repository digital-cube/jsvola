curl -s -X POST localhost:8080/tickets \
  -H 'x-user-id: igor' -H 'content-type: application/json' \
  -d '{"title":"Printer on fire"}' | tee /tmp/ticket.json; echo
ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/ticket.json)

curl -s -X POST "localhost:8080/tickets/$ID/assign" \
  -H 'x-user-id: igor' -H 'content-type: application/json' \
  -d '{"assignee":"ana"}'; echo
curl -s -X PATCH "localhost:8080/tickets/$ID/status" \
  -H 'x-user-id: ana' -H 'content-type: application/json' \
  -d '{"status":"in_progress"}'; echo
