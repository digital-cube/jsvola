mkdir -p vendor
for tarball in vol-a-core-1.0.1 vol-a-client-1.0.1 vol-a-react-1.0.1 memento-core-1.0.0 memento-react-1.0.0; do
  curl -fsSL -o "vendor/$tarball.tgz" \
    "https://vol-a.com/tutorials/ticket-desk/vendor/$tarball.tgz"
done
ls vendor
