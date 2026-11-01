import type { Row } from "@jsudc/core";
import { createContext, useContext } from "react";

/** A file as the browser's rows carry it (the `files` UDC row, typed for what the actions need). */
export interface BrowserFile {
  id: string;
  instance_type: string;
  instance_id: string;
  filename: string;
  kind: string | null;
  size: number;
  extension: string | null;
  mime_type: string | null;
  folder_path: string;
  is_public: boolean;
  is_global_public: boolean;
  encryption: string;
  processing_status: string | null;
  created_at: string | null;
  deleted_at: string | null;
}

/** The `files` UDC row as a `BrowserFile`. */
export function rowToFile(row: Row): BrowserFile {
  const str = (v: unknown) =>
    typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
  return {
    id: String(row.id ?? row.__meta.id),
    instance_type: String(row.instance_type ?? ""),
    instance_id: String(row.instance_id ?? ""),
    filename: String(row.filename ?? ""),
    kind: str(row.kind),
    size: typeof row.size === "number" ? row.size : Number(row.size ?? 0),
    extension: str(row.extension),
    mime_type: str(row.mime_type),
    folder_path: String(row.folder_path ?? ""),
    is_public: row.is_public === true,
    is_global_public: row.is_global_public === true,
    encryption: String(row.encryption ?? "none"),
    processing_status: str(row.processing_status),
    created_at: str(row.created_at),
    deleted_at: str(row.deleted_at),
  };
}

export type RowAction =
  | "download"
  | "rename"
  | "move"
  | "delete"
  | "versions"
  | "share"
  | "visibility";

export const ROW_ACTIONS: readonly RowAction[] = [
  "download",
  "rename",
  "move",
  "delete",
  "versions",
  "share",
  "visibility",
];

export interface FileBrowserContextValue {
  instanceType: string;
  instanceId: string;
  folderPath: string;
  /** The fields to show, in order; `undefined`: the view's columns. */
  columns: readonly string[] | undefined;
  /** The row actions on offer. */
  actions: readonly RowAction[];
  /** Fields a header click sorts by. */
  sortable: readonly string[];
  onOpen: ((file: BrowserFile) => void) | undefined;
  onAction: (action: RowAction, file: BrowserFile) => void;
}

export const FileBrowserContext = createContext<FileBrowserContextValue | null>(null);

export function useFileBrowser(): FileBrowserContextValue | null {
  return useContext(FileBrowserContext);
}
