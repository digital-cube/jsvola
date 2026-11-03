export KEY=vola_live_...    # what create-key printed
export TICKET=$(uuidgen | tr A-F a-f)
curl -s -H "Authorization: Bearer $KEY" -F file=@README.md \
  localhost:8300/vola/files/tickets/$TICKET | tee file.json | jq '{filename, size, mime_type, kind}'
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" -H "Range: bytes=0-9" \
  localhost:8300/vola/files/tickets/$TICKET/$(jq -r .id file.json)
