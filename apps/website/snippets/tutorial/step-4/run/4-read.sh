. ./.env
for locale in en sr; do
  docker compose exec -T memento node -e "
    fetch('http://localhost:3000/memento/entities/tickets/$ID/events?locale=$locale', {
      headers: { authorization: 'Bearer $MEMENTO_BROWSER_KEY' },
    })
      .then((answer) => answer.json())
      .then(({ data }) => data.forEach((event) => console.log(event.rendered)));"
done
