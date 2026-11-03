curl -s localhost:8080/ | grep -o '<title>.*</title>'
curl -s -o /dev/null -w '/config %{http_code}\n' localhost:8080/config
