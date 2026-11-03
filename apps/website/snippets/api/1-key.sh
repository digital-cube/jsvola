# The examples instance hands its read-only visitor key to anyone who asks.
VOLA=https://examples.stage.vol-a.com/vola
KEY=$(curl -s $VOLA/examples/config | jq -r .api_key)
