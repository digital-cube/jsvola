# The images folder of the demo instance, through the UDC `files` collection.
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $VOLA/udc/list -d '{
    "collection": "files",
    "filter": {"and": [
      {"field": "instance_type", "op": "eq", "value": "demo"},
      {"field": "folder_path", "op": "eq", "value": "images"}
    ]},
    "sort": [{"field": "filename", "dir": "asc"}],
    "page": {"limit": 3}
  }' | tee list.json | jq -r '.payload.rows[] | [.filename, .size, .mime_type] | @tsv'
