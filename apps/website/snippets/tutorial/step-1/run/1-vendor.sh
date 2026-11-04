mkdir -p vendor
for package in vola-core vola-client vola-react memento-core memento-react; do
  curl -fsSL -o "vendor/$package-1.0.0.tgz" \
    "https://vol-a.com/tutorials/ticket-desk/vendor/$package-1.0.0.tgz"
done
ls vendor
