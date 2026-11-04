import type { FileEncryption } from "@vol-a/core";
import { type ChangeEvent, type ReactNode, useId, useRef, useState } from "react";
import { useVolaT } from "./i18n.js";
import {
  type UploadItem,
  useVolaUpload,
  type VolaUploadOptions,
  type VolaUploads,
} from "./useVolaUpload.js";

/** The encryption modes a person may pick in the browser (`caller` and `client` are not for a browser). */
export type BrowserEncryption = Extract<FileEncryption, "none" | "tenant" | "keyring">;

export interface VolaUploadButtonProps extends Omit<VolaUploadOptions, "encryption"> {
  /** The mode every upload goes up with, when the person gets no choice. */
  encryption?: BrowserEncryption | undefined;
  /** Offer these modes in a select next to the button (`""` = the folder's policy / the tenant's default). */
  encryptionChoices?: readonly BrowserEncryption[] | undefined;
  multiple?: boolean | undefined;
  accept?: string | undefined;
  disabled?: boolean | undefined;
  /** The button's label. Default: "Upload". */
  children?: ReactNode;
  /** Show the list of uploads under the button. Default `true`. */
  showList?: boolean | undefined;
  /** Use an outer `useVolaUpload()` instead of one of its own (one list for the button and a drop zone). */
  uploads?: VolaUploads | undefined;
  className?: string | undefined;
}

/**
 * A file picker that uploads what it is given (`useVolaUpload`), with an optional encryption
 * choice and the list of uploads with progress, cancel and resume.
 */
export function VolaUploadButton({
  encryption,
  encryptionChoices,
  multiple = true,
  accept,
  disabled,
  children,
  showList = true,
  uploads: outer,
  className,
  ...options
}: VolaUploadButtonProps) {
  const { t } = useVolaT();
  const own = useVolaUpload();
  const uploads = outer ?? own;
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [choice, setChoice] = useState<BrowserEncryption | "">(encryption ?? "");

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const mode = encryptionChoices ? choice : encryption;
    void uploads.upload(files, { ...options, ...(mode ? { encryption: mode } : {}) });
    event.target.value = "";
  };

  return (
    <div className={`vola vola-upload${className ? ` ${className}` : ""}`}>
      <div className="vola-upload__controls">
        {encryptionChoices ? (
          <label className="vola-field vola-field--inline">
            <span>{t("ENCRYPTION")}</span>
            <select
              className="vola-select"
              value={choice}
              onChange={(event) => setChoice(event.target.value as BrowserEncryption | "")}
            >
              <option value="">{t("ENC_DEFAULT")}</option>
              {encryptionChoices.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`ENC_${mode.toUpperCase()}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <input
          ref={input}
          id={`${id}-file`}
          className="vola-upload__input"
          type="file"
          multiple={multiple}
          accept={accept}
          disabled={disabled}
          onChange={onChange}
          aria-label={t("CHOOSE_FILES")}
        />
        <button
          type="button"
          className="vola-btn vola-btn--primary"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {children ?? t("UPLOAD")}
        </button>
      </div>
      {showList ? <VolaUploadList uploads={uploads} /> : null}
    </div>
  );
}

/** The percentage of an item, 0–100. */
export function uploadPercent(item: Pick<UploadItem, "uploaded" | "size">): number {
  if (item.size === 0) return 100;
  return Math.min(100, Math.floor((100 * item.uploaded) / item.size));
}

/** The uploads of a `useVolaUpload()` as rows with a progress bar, cancel, resume and remove. */
export function VolaUploadList({ uploads }: { uploads: VolaUploads }) {
  const { t } = useVolaT();
  if (uploads.uploads.length === 0) return null;
  return (
    <ul className="vola-upload__list" aria-label={t("UPLOADS")}>
      {uploads.uploads.map((item) => {
        const percent = uploadPercent(item);
        return (
          <li key={item.id} className="vola-upload__item" data-status={item.status}>
            <span className="vola-upload__name" title={item.name}>
              {item.name}
              {item.resumable ? <small className="vola-upload__tag">{t("RESUMABLE")}</small> : null}
            </span>
            <progress
              className="vola-upload__bar"
              max={100}
              value={item.status === "uploading" && !item.resumable ? undefined : percent}
              aria-label={item.name}
            />
            <span className="vola-upload__status" role="status">
              {item.status === "queued"
                ? t("QUEUED")
                : item.status === "uploading"
                  ? t("UPLOADING", { percent })
                  : item.status === "done"
                    ? t("UPLOADED")
                    : item.status === "cancelled"
                      ? t("UPLOAD_CANCELLED")
                      : t("UPLOAD_FAILED", { message: item.error ?? "" })}
            </span>
            <span className="vola-upload__actions">
              {item.status === "uploading" || item.status === "queued" ? (
                <button
                  type="button"
                  className="vola-btn vola-btn--ghost"
                  onClick={() => uploads.cancel(item.id)}
                  aria-label={t("CANCEL_UPLOAD", { name: item.name })}
                >
                  {t("CANCEL")}
                </button>
              ) : null}
              {item.status === "cancelled" || item.status === "error" ? (
                <button
                  type="button"
                  className="vola-btn vola-btn--ghost"
                  onClick={() => void uploads.resume(item.id)}
                >
                  {t("RESUME")}
                </button>
              ) : null}
              {item.status !== "uploading" && item.status !== "queued" ? (
                <button
                  type="button"
                  className="vola-btn vola-btn--ghost"
                  onClick={() => uploads.remove(item.id)}
                >
                  {t("REMOVE")}
                </button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
