import {
  type FolderDeleteResult,
  FolderDeleteResultSchema,
  type FolderInfo,
  FolderInfoSchema,
  type FolderListing,
  FolderListingSchema,
  type FolderPatch,
  RECURSIVE_QUERY,
} from "@vol-a/core";
import type { CallOptions, VolaClient } from "./client.js";
import { encodePath } from "./env.js";
import { instancePath } from "./files.js";

export interface FolderDeleteOptions extends CallOptions {
  /** Delete a non-empty folder with everything in it (`409 folder_not_empty` otherwise). */
  recursive?: boolean | undefined;
}

/** `/folders/:type/:id[/a/b/c]`. */
export function folderPath(type: string, id: string, path: string): string {
  const encoded = encodePath(path);
  return `/folders/${encodeURIComponent(type)}/${encodeURIComponent(id)}${encoded ? `/${encoded}` : ""}`;
}

/** The virtual folders of an instance. Paths are `a/b/c` (`""` is the root). */
export class FoldersApi {
  constructor(private readonly client: VolaClient) {}

  /** `POST /folders/:type/:id/*path`: the folder and every missing parent (`201` new, `200` existing). */
  create(type: string, id: string, path: string, options: CallOptions = {}): Promise<FolderInfo> {
    return this.client.json(folderPath(type, id, path), FolderInfoSchema, {
      method: "POST",
      ...options,
    });
  }

  /** `GET /folders/:type/:id/*path`: one level — the folder (`null` for the root), its subfolders, its live files. */
  list(type: string, id: string, path = "", options: CallOptions = {}): Promise<FolderListing> {
    return this.client.json(folderPath(type, id, path), FolderListingSchema, options);
  }

  /** `PATCH /folders/:type/:id/*path` with any combination of `name`, `parent_path`, `default_keyring`. */
  patch(
    type: string,
    id: string,
    path: string,
    patch: FolderPatch,
    options: CallOptions = {},
  ): Promise<FolderInfo> {
    return this.client.json(folderPath(type, id, path), FolderInfoSchema, {
      method: "PATCH",
      json: patch,
      ...options,
    });
  }

  /** Renames the folder (its descendants follow). */
  rename(
    type: string,
    id: string,
    path: string,
    name: string,
    options: CallOptions = {},
  ): Promise<FolderInfo> {
    return this.patch(type, id, path, { name }, options);
  }

  /** Moves the folder under `parentPath` (`""`: the root, created when missing). */
  move(
    type: string,
    id: string,
    path: string,
    parentPath: string,
    options: CallOptions = {},
  ): Promise<FolderInfo> {
    return this.patch(type, id, path, { parent_path: parentPath }, options);
  }

  /**
   * The folder's encryption policy: `"me"` — every new upload into it (or below) is encrypted
   * under the keyring of the instance's `userId` (an unlock token is then required to upload);
   * `null` — no policy of its own.
   */
  setDefaultKeyring(
    type: string,
    id: string,
    path: string,
    keyring: "me" | null,
    options: CallOptions = {},
  ): Promise<FolderInfo> {
    return this.patch(type, id, path, { default_keyring: keyring }, options);
  }

  /** `DELETE /folders/:type/:id/*path[?recursive=1]`: soft delete. */
  delete(
    type: string,
    id: string,
    path: string,
    options: FolderDeleteOptions = {},
  ): Promise<FolderDeleteResult> {
    return this.client.json(folderPath(type, id, path), FolderDeleteResultSchema, {
      method: "DELETE",
      query: { [RECURSIVE_QUERY]: options.recursive },
      signal: options.signal,
      unlock: options.unlock,
    });
  }
}

/** Re-exported for symmetry with `filePath`. */
export { instancePath };
