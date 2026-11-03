curl -s -X POST "localhost:8080/tickets/$ID/comments" \
  -H 'x-user-id: ana' -H 'content-type: application/json' \
  -d '{"text":"On my way"}'; echo
