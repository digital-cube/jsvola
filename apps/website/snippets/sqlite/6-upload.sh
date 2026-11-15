export KEY=vola_live_...    # what create-key printed
curl -s localhost:8310/vola/health/ready; echo
echo "Hello from SQLite" > hello.txt
export TICKET=$(uuidgen | tr A-F a-f)
curl -s -H "Authorization: Bearer $KEY" -F file=@hello.txt \
  localhost:8310/vola/files/tickets/$TICKET | tee file.json | jq '{filename, size, mime_type, kind}'
curl -s -H "Authorization: Bearer $KEY" localhost:8310/vola/files/tickets/$TICKET/$(jq -r .id file.json)
ls data
