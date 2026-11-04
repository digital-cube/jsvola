# @vol-a/core

The JSVola protocol as code: the Zod schemas and inferred TypeScript types of every request body
and answer of [`@vol-a/server`](https://github.com/digital-cube/jsvola/tree/main/packages/server),
the header, query-parameter and error-code constants both sides agree on, the scopes, and the
helpers the server, the CLI and the clients share. No Node-only API — it runs in browsers too.

```sh
pnpm add @vol-a/core
```

```ts
import { FileInfoSchema, type FileInfo, ShareCreateSchema, UNLOCK_HEADER, LOCKED_CODE, SCOPES } from "@vol-a/core";

const info: FileInfo = FileInfoSchema.parse(await response.json());
ShareCreateSchema.parse({ file_id: info.id, max_downloads: 3 });
```

| area | schemas (each with its inferred type) |
|---|---|
| files | `FileInfoSchema`, `FileDetailSchema` (+ `ocr`), `FileListSchema`, `FileVersionsSchema`, `FilePatchSchema`, `PurgeResultSchema`, `FileKindSchema`, `FileEncryptionSchema`, `ThumbnailSizeSchema`, `ThumbnailCropSchema`, `InstanceTypeSchema`, `FileSlugSchema`, `UserIdSchema` |
| folders | `FolderInfoSchema`, `FolderListingSchema`, `FolderPatchSchema`, `FolderDeleteResultSchema`, `FolderPathSchema` |
| uploads (tus) | the `UPLOAD_*` header and metadata constants, `UPLOAD_META_KEYS` |
| shares | `ShareCreateSchema`, `ShareCreatedSchema`, `ShareInfoSchema`, `ShareListSchema`, `SharedFolderListingSchema`, `callerGrantAad` |
| keyrings | `KeyringCreateSchema`, `KeyringCreatedSchema`, `KeyringStatusSchema`, `UnlockSchema`, `UnlockedSchema`, `PinChangeSchema`, `RecoverSchema`, `RecoveredSchema`, `KeyringResetSchema`, `KeyringDeletePreviewSchema`, `PIN_LENGTH` |
| stats, transfer | `TenantStatsSchema`, `StorageStatsSchema`, `TransferRequestSchema`, `TransferResultSchema`, `TRANSFER_MAX_INSTANCES` |
| keys, tenants | `ApiKeyCreateSchema`, `ApiKeyCreatedSchema`, `ApiKeyListSchema`, `TenantSchema`, `SCOPES`, `parseApiKey`, `displayApiKey`, `missingScopes` |
| real-time | `ClientMessageSchema`, `ServerMessageSchema`, `SubscribePayloadSchema`, `VOLA_SUBPROTOCOL`, `BEARER_SUBPROTOCOL_PREFIX` |
| lookups, health, errors | `LookupsResponseSchema`, `InstanceTypesResponseSchema`, `LiveResponseSchema`, `ReadyResponseSchema`, `ErrorResponseSchema`, the `*_CODE` constants |

The route reference that these schemas describe:
[docs/API.md](https://github.com/digital-cube/jsvola/blob/main/docs/API.md). A ready-made client
over them: [`@vol-a/client`](https://www.npmjs.com/package/@vol-a/client).

MIT.
