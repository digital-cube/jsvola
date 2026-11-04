# Ticket desk

A small help desk built on two services that do one thing each:
[vola](https://github.com/digital-cube/jsvola) keeps the files of a ticket, and
[memento](https://github.com/digital-cube/jsmemento) keeps who did what, when.

**This is the finished program of a tutorial, which builds it from an empty folder in seven steps:
[in English](https://vol-a.com/tutorials/ticket-desk/),
[na srpskom](https://vol-a.com/tutorials/ticket-desk-sr/).** Each step is one commit, `step N: …`, in
the history of this folder.

## Run it

Docker, Node 24 and pnpm:

```sh
make setup    # brings the stack up, makes the tenants and the keys, writes them to .env
open http://localhost:8080
```

```sh
pnpm install
pnpm test                       # the backend and the feed, nothing has to be running
make e2e                        # the main flow, against the stack that is up
pnpm typecheck && pnpm lint
```

vola's own events in the feed need an image with the fix "The audit trail reaches memento" from
vola's changelog; step 7 of the tutorial says what to do until a release has it. `@vola/*` and
`@memento/*` are not on npm yet, so `vendor/` holds their client packages
([vendor/README.md](vendor/README.md)).
