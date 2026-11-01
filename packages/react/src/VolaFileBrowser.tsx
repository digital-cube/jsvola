import {
  createUdcQueryClient,
  UdcDataView,
  UdcProvider,
  UdcUrlStateProvider,
  type UrlStateAdapter,
  udcKeys,
} from "@jsudc/react";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileInfo, FolderInfo } from "@vola/core";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import {
  type BrowserFile,
  FileBrowserContext,
  type FileBrowserContextValue,
  ROW_ACTIONS,
  type RowAction,
} from "./browserContext.js";
import { useVolaContext } from "./context.js";
import { useVolaT } from "./i18n.js";
import { type LiveStatus, useFilesLive } from "./live.js";
import { filesScope, ScopedUdcClient } from "./scopedUdc.js";
import { useVolaUpload } from "./useVolaUpload.js";
import { FILES_SORTABLE } from "./VolaFilesTable.js";
import { VolaMenu } from "./VolaMenu.js";
import { VolaModal } from "./VolaModal.js";
import { VolaKeyringStatus } from "./VolaPinGate.js";
import { VolaShareDialog } from "./VolaShareDialog.js";
import { type BrowserEncryption, VolaUploadButton, VolaUploadList } from "./VolaUploadButton.js";

export interface VolaFileBrowserProps {
  instanceType: string;
  instanceId: string;
  /** The folder shown first (`""`: the root). The browser follows a change of this prop. */
  folderPath?: string | undefined;
  onFolderChange?: ((path: string) => void) | undefined;
  /** A file's name was clicked (or "Open" in its menu): a preview, a route of the host. */
  onOpen?: ((file: BrowserFile) => void) | undefined;
  /** The fields to show, in order. Default: the `files` view's columns. */
  columns?: readonly string[] | undefined;
  /** The row actions on offer. Default: all of them. */
  actions?: readonly RowAction[] | undefined;
  /** Subscribe to `/udc/subscribe` for live rows. Default `true`. */
  live?: boolean | undefined;
  /** Where the data view keeps its search and filters: in memory (default) or the page's query string. */
  urlState?: "memory" | "window" | undefined;
  /** Show the upload button (and accept drops). Default `true`. */
  upload?: boolean | undefined;
  /** Encryption modes the upload button offers. */
  encryptionChoices?: readonly BrowserEncryption[] | undefined;
  /** The mode every upload goes up with, when the person gets no choice. */
  encryption?: BrowserEncryption | undefined;
  /** Show the keyring status (locked / unlocked, lock, change PIN) in the toolbar. Default `true`. */
  keyringStatus?: boolean | undefined;
  title?: ReactNode;
  className?: string | undefined;
}

/** A `UrlStateAdapter` that keeps the query string in memory: the host's URL is left alone. */
export function memoryUrlState(initial = ""): UrlStateAdapter {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => new URLSearchParams(current),
    set: (next) => {
      current = next.toString();
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type Dialog =
  | { kind: "none" }
  | { kind: RowAction; file: BrowserFile }
  | { kind: "new_folder" }
  | { kind: "rename_folder"; folder: FolderInfo }
  | { kind: "delete_folder"; folder: FolderInfo };

/** The query key of a folder listing. */
export const folderKey = (type: string, id: string, path: string) =>
  ["vola", "folders", type, id, path] as const;

/**
 * The files of one instance, folder by folder: breadcrumbs, the subfolders, and the `files`
 * UDC collection as `<UdcDataView>` draws it — scoped to the instance and the folder, kept
 * current through the live subscription (a new upload, a rename, a move, a delete, a change
 * of `processing_status` arrive without a reload). Row actions: download, rename, move,
 * delete, versions, share, visibility. The whole surface is a drop zone.
 */
export function VolaFileBrowser(props: VolaFileBrowserProps) {
  const {
    instanceType,
    instanceId,
    folderPath = "",
    onFolderChange,
    onOpen,
    columns,
    actions = ROW_ACTIONS,
    live = true,
    urlState = "memory",
    upload = true,
    encryptionChoices,
    encryption,
    keyringStatus = true,
    title,
    className,
  } = props;
  const { client, keyring } = useVolaContext();
  const { t } = useVolaT();
  const [path, setPath] = useState(folderPath);
  useEffect(() => setPath(folderPath), [folderPath]);
  const navigate = useCallback(
    (next: string) => {
      setPath(next);
      onFolderChange?.(next);
    },
    [onFolderChange],
  );

  // One query cache per scope: the data view's list keys do not carry the scope, so two
  // folders (or two browsers) must not share one.
  const [queryClient, scoped] = useMemo(
    () => [
      createUdcQueryClient(),
      new ScopedUdcClient(client.udc, "files", filesScope(instanceType, instanceId, path)),
    ],
    [client, instanceType, instanceId, path],
  );
  const adapter = useMemo(() => (urlState === "memory" ? memoryUrlState() : null), [urlState]);

  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploads = useVolaUpload();

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: udcKeys.lists("files") });
    void queryClient.invalidateQueries({ queryKey: ["vola", "folders", instanceType, instanceId] });
  }, [queryClient, instanceType, instanceId]);

  const fail = useCallback(
    (e: unknown) => {
      keyring.handleError(e);
      setError(e instanceof Error ? e.message : String(e));
    },
    [keyring],
  );

  const download = useCallback(
    async (file: BrowserFile) => {
      try {
        const response = await client.files.download(
          file.instance_type,
          file.instance_id,
          file.id,
          {
            download: true,
          },
        );
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.filename;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        fail(e);
      }
    },
    [client, fail],
  );

  const onAction = useCallback(
    (action: RowAction, file: BrowserFile) => {
      if (action === "download") void download(file);
      else setDialog({ kind: action, file });
    },
    [download],
  );

  const context = useMemo<FileBrowserContextValue>(
    () => ({
      instanceType,
      instanceId,
      folderPath: path,
      columns,
      actions,
      sortable: FILES_SORTABLE,
      onOpen,
      onAction,
    }),
    [instanceType, instanceId, path, columns, actions, onOpen, onAction],
  );

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!upload) return;
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    void uploads.upload(files, {
      instanceType,
      instanceId,
      folderPath: path,
      ...(encryption ? { encryption } : {}),
      onUploaded: refresh,
      onError: fail,
    });
  };

  const close = () => setDialog({ kind: "none" });

  const view = (
    <FileBrowserContext.Provider value={context}>
      <UdcProvider client={scoped}>
        <div className="vola-browser__view">
          <UdcDataView key={`${instanceType}/${instanceId}/${path}`} collection="files" />
        </div>
      </UdcProvider>
    </FileBrowserContext.Provider>
  );

  return (
    <QueryClientProvider client={queryClient}>
      <section
        className={`vola vola-browser${dragging ? " vola-browser--dragging" : ""}${className ? ` ${className}` : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (upload) setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (upload) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (
            event.currentTarget === event.target ||
            !event.currentTarget.contains(event.relatedTarget as Node)
          ) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
        aria-label={typeof title === "string" ? title : undefined}
      >
        <BrowserHeader
          title={title}
          path={path}
          navigate={navigate}
          instanceType={instanceType}
          instanceId={instanceId}
          live={live}
          keyringStatus={keyringStatus}
          onNewFolder={() => setDialog({ kind: "new_folder" })}
          onRenameFolder={(folder) => setDialog({ kind: "rename_folder", folder })}
          onDeleteFolder={(folder) => setDialog({ kind: "delete_folder", folder })}
          refresh={refresh}
          upload={
            upload ? (
              <VolaUploadButton
                instanceType={instanceType}
                instanceId={instanceId}
                folderPath={path}
                uploads={uploads}
                encryption={encryption}
                encryptionChoices={encryptionChoices}
                onUploaded={refresh}
                onError={fail}
                showList={false}
              />
            ) : null
          }
        />
        {error ? (
          <p className="vola-error" role="alert">
            {t("ERROR", { message: error })}{" "}
            <button type="button" className="vola-link" onClick={() => setError(null)}>
              {t("CLOSE")}
            </button>
          </p>
        ) : null}
        {uploads.uploads.length > 0 ? <VolaUploadList uploads={uploads} /> : null}
        {adapter ? <UdcUrlStateProvider adapter={adapter}>{view}</UdcUrlStateProvider> : view}
        {dragging ? (
          <div className="vola-browser__drop" aria-hidden="true">
            {t("DROP_HERE")}
          </div>
        ) : null}
        <BrowserDialogs
          dialog={dialog}
          close={close}
          refresh={refresh}
          fail={fail}
          download={download}
          instanceType={instanceType}
          instanceId={instanceId}
          path={path}
        />
      </section>
    </QueryClientProvider>
  );
}

// --- header: breadcrumbs, subfolders, status, upload -------------------------------------------

function BrowserHeader({
  title,
  path,
  navigate,
  instanceType,
  instanceId,
  live,
  keyringStatus,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  refresh,
  upload,
}: {
  title: ReactNode;
  path: string;
  navigate: (path: string) => void;
  instanceType: string;
  instanceId: string;
  live: boolean;
  keyringStatus: boolean;
  onNewFolder: () => void;
  onRenameFolder: (folder: FolderInfo) => void;
  onDeleteFolder: (folder: FolderInfo) => void;
  refresh: () => void;
  upload: ReactNode;
}) {
  const { client, keyring } = useVolaContext();
  const { t } = useVolaT();
  const queryClient = useQueryClient();
  const status = useFilesLive({
    filter: filesScope(instanceType, instanceId, path),
    enabled: live,
    onEvent: (event) => {
      if (event.event !== "processing") {
        void queryClient.invalidateQueries({
          queryKey: ["vola", "folders", instanceType, instanceId],
        });
      }
    },
  });
  const folders = useQuery({
    queryKey: folderKey(instanceType, instanceId, path),
    queryFn: () => client.folders.list(instanceType, instanceId, path),
  });
  useEffect(() => {
    if (folders.error) keyring.handleError(folders.error);
  }, [folders.error, keyring]);
  const segments = path ? path.split("/") : [];

  return (
    <header className="vola-browser__header">
      <div className="vola-browser__toolbar">
        {title ? <h2 className="vola-browser__title">{title}</h2> : null}
        <nav className="vola-breadcrumbs" aria-label={t("BREADCRUMBS")}>
          <ol>
            <li>
              <button
                type="button"
                className="vola-link"
                onClick={() => navigate("")}
                aria-current={path === "" ? "page" : undefined}
              >
                {t("ROOT")}
              </button>
            </li>
            {segments.map((segment, index) => {
              const target = segments.slice(0, index + 1).join("/");
              return (
                <li key={target}>
                  <button
                    type="button"
                    className="vola-link"
                    onClick={() => navigate(target)}
                    aria-current={target === path ? "page" : undefined}
                  >
                    {segment}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <span className="vola-browser__spacer" />
        <LiveIndicator status={status} />
        {keyringStatus ? <VolaKeyringStatus /> : null}
        <button type="button" className="vola-btn" onClick={onNewFolder}>
          {t("NEW_FOLDER")}
        </button>
        {upload}
      </div>
      <fieldset className="vola-browser__folders">
        <legend className="vola-sr-only">{t("FOLDERS")}</legend>
        {folders.data?.subfolders.map((folder) => (
          <span key={folder.id} className="vola-folder">
            <button
              type="button"
              className="vola-folder__open"
              onClick={() => navigate(folder.path)}
            >
              📁 {folder.name}
            </button>
            <VolaMenu
              label={t("FOLDER_ACTIONS")}
              items={[
                { key: "rename", label: t("RENAME"), onSelect: () => onRenameFolder(folder) },
                {
                  key: "delete",
                  label: t("DELETE"),
                  danger: true,
                  onSelect: () => onDeleteFolder(folder),
                },
              ]}
            />
          </span>
        ))}
        {folders.error ? (
          <button type="button" className="vola-link" onClick={refresh}>
            {t("RETRY")}
          </button>
        ) : null}
      </fieldset>
    </header>
  );
}

function LiveIndicator({ status }: { status: LiveStatus }) {
  const { t } = useVolaT();
  const text =
    status === "live"
      ? t("LIVE")
      : status === "connecting"
        ? t("CONNECTING")
        : status === "offline"
          ? t("OFFLINE")
          : t("LIVE_OFF");
  return (
    <span className="vola-live" data-status={status} role="status" title={text}>
      <span className="vola-live__dot" aria-hidden="true" />
      <span className="vola-live__text">{text}</span>
    </span>
  );
}

// --- dialogs -------------------------------------------------------------------------------------

function BrowserDialogs({
  dialog,
  close,
  refresh,
  fail,
  download,
  instanceType,
  instanceId,
  path,
}: {
  dialog: Dialog;
  close: () => void;
  refresh: () => void;
  fail: (e: unknown) => void;
  download: (file: BrowserFile) => Promise<void>;
  instanceType: string;
  instanceId: string;
  path: string;
}) {
  const { client } = useVolaContext();
  const { t, intlLocale } = useVolaT();
  const [value, setValue] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [isGlobal, setIsGlobal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<FileInfo[] | null>(null);
  const id = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new dialog starts from its subject's values.
  useEffect(() => {
    setBusy(false);
    setVersions(null);
    if (dialog.kind === "rename") setValue(dialog.file.filename);
    else if (dialog.kind === "move") setValue(dialog.file.folder_path);
    else if (dialog.kind === "rename_folder") setValue(dialog.folder.name);
    else if (dialog.kind === "visibility") {
      setIsPublic(dialog.file.is_public);
      setIsGlobal(dialog.file.is_global_public);
    } else if (dialog.kind === "versions") {
      client.files
        .versions(dialog.file.instance_type, dialog.file.instance_id, dialog.file.id)
        .then((v) => setVersions(v.versions))
        .catch((e) => {
          fail(e);
          setVersions([]);
        });
    } else setValue("");
  }, [dialog]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      refresh();
      close();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    confirmLabel: string,
    onConfirm: () => void,
    danger = false,
    disabled = false,
  ) => (
    <>
      <button type="button" className="vola-btn" onClick={close} disabled={busy}>
        {t("CANCEL")}
      </button>
      <button
        type="button"
        className={`vola-btn ${danger ? "vola-btn--danger" : "vola-btn--primary"}`}
        onClick={onConfirm}
        disabled={busy || disabled}
      >
        {confirmLabel}
      </button>
    </>
  );

  switch (dialog.kind) {
    case "none":
    case "download":
      return null;
    case "share":
      return <VolaShareDialog file={dialog.file} open onClose={close} />;
    case "rename": {
      const { file } = dialog;
      const save = () =>
        void run(() =>
          client.files.patch(file.instance_type, file.instance_id, file.id, {
            filename: value.trim(),
          }),
        );
      return (
        <VolaModal
          open
          title={t("RENAME")}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("SAVE"), save, false, !value.trim())}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="vola-field" htmlFor={`${id}-name`}>
              <span>{t("NEW_NAME")}</span>
              <input
                id={`${id}-name`}
                className="vola-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          </form>
        </VolaModal>
      );
    }
    case "move": {
      const { file } = dialog;
      const save = () =>
        void run(() =>
          client.files.patch(file.instance_type, file.instance_id, file.id, {
            folder_path: value.trim(),
          }),
        );
      return (
        <VolaModal
          open
          title={t("MOVE")}
          description={t("TARGET_FOLDER_HINT")}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("MOVE"), save)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="vola-field" htmlFor={`${id}-folder`}>
              <span>{t("TARGET_FOLDER")}</span>
              <input
                id={`${id}-folder`}
                className="vola-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={path}
              />
            </label>
          </form>
        </VolaModal>
      );
    }
    case "delete": {
      const { file } = dialog;
      const confirm = () =>
        void run(() => client.files.delete(file.instance_type, file.instance_id, file.id));
      return (
        <VolaModal
          open
          role="alertdialog"
          title={t("DELETE")}
          description={t("DELETE_CONFIRM", { name: file.filename })}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("DELETE"), confirm, true)}
        />
      );
    }
    case "visibility": {
      const { file } = dialog;
      const encrypted = file.encryption !== "none";
      const save = () =>
        void run(() =>
          client.files.patch(file.instance_type, file.instance_id, file.id, {
            is_public: isPublic,
            ...(encrypted ? {} : { is_global_public: isGlobal }),
          }),
        );
      return (
        <VolaModal
          open
          title={t("VISIBILITY")}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("SAVE"), save)}
        >
          <label className="vola-check">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <span>{t("PUBLIC")}</span>
          </label>
          <label className="vola-check">
            <input
              type="checkbox"
              checked={isGlobal && !encrypted}
              disabled={encrypted}
              onChange={(e) => setIsGlobal(e.target.checked)}
            />
            <span>{t("GLOBAL_PUBLIC")}</span>
          </label>
          {encrypted ? <p className="vola-muted">{t("GLOBAL_PUBLIC_ENCRYPTED")}</p> : null}
        </VolaModal>
      );
    }
    case "versions": {
      const { file } = dialog;
      return (
        <VolaModal open title={t("VERSIONS_OF", { name: file.filename })} onClose={close}>
          {versions === null ? (
            <p className="vola-muted">{t("LOADING")}</p>
          ) : versions.length <= 1 ? (
            <p className="vola-muted">{t("NO_VERSIONS")}</p>
          ) : (
            <ol className="vola-versions">
              {versions.map((version) => (
                <li key={version.id} className="vola-versions__item">
                  <span>
                    {version.filename} · {new Date(version.created_at).toLocaleString(intlLocale)}
                    {version.id === file.id ? ` (${t("CURRENT")})` : ""}
                  </span>
                  <button
                    type="button"
                    className="vola-btn vola-btn--ghost"
                    onClick={() =>
                      void download({
                        ...file,
                        id: version.id,
                        filename: version.filename,
                        encryption: version.encryption,
                      })
                    }
                  >
                    {t("DOWNLOAD")}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </VolaModal>
      );
    }
    case "new_folder": {
      const create = () =>
        void run(() =>
          client.folders.create(
            instanceType,
            instanceId,
            path ? `${path}/${value.trim()}` : value.trim(),
          ),
        );
      return (
        <VolaModal
          open
          title={t("NEW_FOLDER")}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("SAVE"), create, false, !value.trim())}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label className="vola-field" htmlFor={`${id}-new-folder`}>
              <span>{t("FOLDER_NAME")}</span>
              <input
                id={`${id}-new-folder`}
                className="vola-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          </form>
        </VolaModal>
      );
    }
    case "rename_folder": {
      const { folder } = dialog;
      const save = () =>
        void run(() =>
          client.folders.rename(
            folder.instance_type,
            folder.instance_id,
            folder.path,
            value.trim(),
          ),
        );
      return (
        <VolaModal
          open
          title={t("RENAME")}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("SAVE"), save, false, !value.trim())}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="vola-field" htmlFor={`${id}-folder-name`}>
              <span>{t("FOLDER_NAME")}</span>
              <input
                id={`${id}-folder-name`}
                className="vola-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          </form>
        </VolaModal>
      );
    }
    case "delete_folder": {
      const { folder } = dialog;
      const confirm = () =>
        void run(() =>
          client.folders.delete(folder.instance_type, folder.instance_id, folder.path, {
            recursive: true,
          }),
        );
      return (
        <VolaModal
          open
          role="alertdialog"
          title={t("DELETE")}
          description={t("FOLDER_DELETE_CONFIRM", { name: folder.name })}
          onClose={close}
          dismissable={!busy}
          footer={footer(t("DELETE"), confirm, true)}
        />
      );
    }
    default:
      return null;
  }
}
