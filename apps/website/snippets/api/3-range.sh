# The first kilobyte of the first of them, and the headers that came back.
FILE=$(jq -r '.payload.rows[0].download_url' list.json)
curl -s -o /dev/null -D - -H "Authorization: Bearer $KEY" -H "Range: bytes=0-1023" \
  "https://examples.stage.vol-a.com$FILE" | grep -iE '^(HTTP|content-range|accept-ranges)'
