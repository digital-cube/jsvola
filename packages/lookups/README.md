# @vola/lookups

Controlled vocabularies for JSVola: the `lookups.yaml` compiler and registry, CSV
translations with a validator, candidate recording for unknown values, promotion of
candidates back into the vocabulary, and TypeScript/Zod codegen. Same format and API as
`@memento/lookups` (JSMemento); a copy, not a dependency.

Part of [JSVola](https://github.com/digital-cube/jsvola), self-hosted, multi-tenant
content-addressable file storage. The vocabulary itself (`lookups.yaml`,
`i18n/translations.csv`) lives at the repository root and is served by `GET /vola/lookups`.

Requires Node 24+. MIT licensed.
