# @vola/cli

The `vola` command line for a JSVola deployment: migrations, tenants, API keys, the encryption
key file and the keyring pepper file, moving instances between tenants, the lookups vocabulary,
and the examples site's demo keys and seeder. It talks to PostgreSQL directly
(`VOLA_DATABASE_URL`), so it runs next to the server — the Docker image ships it as
`/usr/local/bin/vola`.

```sh
pnpm add -g @vola/cli          # or: npx @vola/cli --help
vola --help
vola migrate
vola create-tenant --slug acme --name "Acme Inc"
vola create-key --tenant acme --name backend --env live --scopes files:read,files:write,folders:read,folders:write
#   → the plaintext key, printed ONCE
vola create-admin-key --name ops
vola list-keys --tenant acme
vola revoke-key vola_live…k3Qz
vola keys-generate && vola pepper-generate      # the two secret files; back them up
vola keys-status && vola pepper-status
vola transfer --from acme --to beta --instance tickets:<uuid> --dry-run
vola lookups validate
```

Add `--json` before the command for machine-readable output. Every command, its options, the
environment it reads and example output:
[docs/CLI.md](https://github.com/digital-cube/jsvola/blob/main/docs/CLI.md).

MIT.
