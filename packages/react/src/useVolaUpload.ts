import type { FingerprintStore, UploadPlacement } from "@vol-a/client";
import type { FileInfo } from "@vol-a/core";
import { useCallback, useMemo, useRef, useState } from "react";
import { useVolaContext } from "./context.js";

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "cancelled";

export interface UploadItem {
  /** A local id of the row (not the file's). */
  id: string;
  name: string;
  /** Bytes in all. */
  size: number;
  /** Bytes the server has (plaintext bytes). */
  uploaded: number;
  status: UploadStatus;
  /** The message of a failure. */
  error: string | null;
  /** The stored file, once done. */
  fileId: string | null;
  /** The upload goes through `/uploads` (tus): it can be cancelled and resumed. */
  resumable: boolean;
  instanceType: string;
  instanceId: string;
}

export interface VolaUploadOptions extends UploadPlacement {
  instanceType: string;
  instanceId: string;
  /** Where resumable uploads are remembered. Default: `localStorage` (the SDK's default). */
  store?: FingerprintStore | undefined;
  /** Bytes per `PATCH` of a resumable upload. Default 8 MiB. */
  chunkSize?: number | undefined;
  /** Called once per file that landed (`FileInfo` for a plain upload, the id for a resumable one). */
  onUploaded?:
    | ((result: { fileId: string; info: FileInfo | null; item: UploadItem }) => void)
    | undefined;
  onError?: ((error: unknown, item: UploadItem) => void) | undefined;
}

export interface VolaUploads {
  uploads: UploadItem[];
  /** Starts one upload per file; resolves when every one of them ended (done, failed or cancelled). */
  upload: (files: FileList | File[] | File, options: VolaUploadOptions) => Promise<UploadItem[]>;
  /** Aborts an upload in flight; a resumable one keeps its fingerprint and can `resume()`. */
  cancel: (id: string) => void;
  /** Continues a cancelled or failed upload from the offset the server has. */
  resume: (id: string) => Promise<UploadItem | null>;
  /** Takes a finished row out of the list. */
  remove: (id: string) => void;
  /** Takes every finished row out of the list. */
  clear: () => void;
  /** Bytes from which an upload is resumable (the provider's `resumableThreshold`). */
  threshold: number;
}

let counter = 0;
const nextId = () => `upload-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Uploads with progress: a file under the provider's `resumableThreshold` (8 MiB) goes up as
 * one multipart `POST`; a larger one through the resumable protocol, chunk by chunk, with
 * progress, cancel and resume. A resumable upload is remembered under its fingerprint in
 * `localStorage`, so after a reload the same file (same name, size and modification time)
 * continues where the server stands. Works with `VolaUploadButton` or your own UI.
 */
export function useVolaUpload(): VolaUploads {
  const { client, resumableThreshold, keyring } = useVolaContext();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  // The rows as they are NOW (a state update may not have rendered yet when `resume` is called).
  const latest = useRef(new Map<string, UploadItem>());
  const files = useRef(new Map<string, File>());
  const options = useRef(new Map<string, VolaUploadOptions>());
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, change: Partial<UploadItem>) => {
    const now = latest.current.get(id);
    if (now) latest.current.set(id, { ...now, ...change });
    setUploads((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const run = useCallback(
    async (item: UploadItem): Promise<UploadItem> => {
      const file = files.current.get(item.id);
      const opts = options.current.get(item.id);
      if (!file || !opts) return item;
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      let current: UploadItem = { ...item, status: "uploading", error: null };
      patch(item.id, { status: "uploading", error: null });
      const placement: UploadPlacement = {
        filename: opts.filename ?? file.name,
        contentType: opts.contentType ?? (file.type || undefined),
        folderPath: opts.folderPath,
        folderId: opts.folderId,
        parentId: opts.parentId,
        metadata: opts.metadata,
        encryption: opts.encryption,
      };
      try {
        if (item.resumable) {
          const { fileId } = await client.uploads.resumable(
            opts.instanceType,
            opts.instanceId,
            file,
            {
              ...placement,
              signal: controller.signal,
              chunkSize: opts.chunkSize,
              store: opts.store,
              onProgress: ({ uploaded }) => {
                current = { ...current, uploaded };
                patch(item.id, { uploaded });
              },
            },
          );
          current = { ...current, status: "done", uploaded: file.size, fileId };
          patch(item.id, { status: "done", uploaded: file.size, fileId });
          opts.onUploaded?.({ fileId, info: null, item: current });
        } else {
          const { folderId, ...rest } = placement;
          const info = await client.files.upload(opts.instanceType, opts.instanceId, file, {
            ...rest,
            ...(folderId !== undefined ? { folderId } : {}),
            signal: controller.signal,
          });
          current = { ...current, status: "done", uploaded: file.size, fileId: info.id };
          patch(item.id, { status: "done", uploaded: file.size, fileId: info.id });
          opts.onUploaded?.({ fileId: info.id, info, item: current });
        }
      } catch (error) {
        if (isAbort(error)) {
          current = { ...current, status: "cancelled" };
          patch(item.id, { status: "cancelled" });
        } else {
          keyring.handleError(error);
          const message = error instanceof Error ? error.message : String(error);
          current = { ...current, status: "error", error: message };
          patch(item.id, { status: "error", error: message });
          opts.onError?.(error, current);
        }
      } finally {
        controllers.current.delete(item.id);
      }
      return current;
    },
    [client, keyring, patch],
  );

  const upload = useCallback<VolaUploads["upload"]>(
    async (input, opts) => {
      const list = input instanceof File ? [input] : [...input];
      const items = list.map<UploadItem>((file) => {
        const id = nextId();
        files.current.set(id, file);
        options.current.set(id, opts);
        const item: UploadItem = {
          id,
          name: opts.filename ?? file.name,
          size: file.size,
          uploaded: 0,
          status: "queued",
          error: null,
          fileId: null,
          resumable: file.size >= resumableThreshold,
          instanceType: opts.instanceType,
          instanceId: opts.instanceId,
        };
        latest.current.set(id, item);
        return item;
      });
      setUploads((current) => [...current, ...items]);
      return Promise.all(items.map((item) => run(item)));
    },
    [resumableThreshold, run],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const resume = useCallback<VolaUploads["resume"]>(
    async (id) => {
      const found = latest.current.get(id);
      if (!found || found.status === "uploading" || found.status === "done") return null;
      return run(found);
    },
    [run],
  );

  const remove = useCallback((id: string) => {
    files.current.delete(id);
    options.current.delete(id);
    latest.current.delete(id);
    setUploads((list) => list.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setUploads((list) => {
      const keep = list.filter((item) => item.status === "uploading" || item.status === "queued");
      for (const item of list) {
        if (!keep.includes(item)) {
          files.current.delete(item.id);
          options.current.delete(item.id);
          latest.current.delete(item.id);
        }
      }
      return keep;
    });
  }, []);

  return useMemo(
    () => ({ uploads, upload, cancel, resume, remove, clear, threshold: resumableThreshold }),
    [uploads, upload, cancel, resume, remove, clear, resumableThreshold],
  );
}
