import { useI18n } from "@jsudc/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileInfo } from "@vol-a/core";
import { useFilesLive, useVola } from "@vol-a/react";
import { type ReactNode, useCallback, useState } from "react";
import { Link } from "react-router";
import { useSettings } from "../connection.js";

/** The compose command that fills the demo instance. */
export const SEED_COMMAND = "docker compose -f docker-compose.yaml --profile demo up -d seeder";

/** The title bar of a page. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <header className="bar">
      <div className="bar__title">
        <h1>{title}</h1>
        {subtitle ? <span className="bar__sub">{subtitle}</span> : null}
      </div>
      {children}
    </header>
  );
}

/** A paragraph that explains what the page shows. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="note">{children}</p>;
}

/** What the demo instance holds: every file, newest first, refetched on every live event. */
export function useDemoFiles(): {
  files: FileInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const client = useVola();
  const { connection } = useSettings();
  const queryClient = useQueryClient();
  const { instanceType, instanceId, baseUrl, apiKey } = connection;
  const key = ["vola-examples", "files", baseUrl, apiKey, instanceType, instanceId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const out: FileInfo[] = [];
      for await (const file of client.files.iterate(instanceType, instanceId, { limit: 200 })) {
        out.push(file);
        if (out.length >= 400) break;
      }
      return out;
    },
    enabled: Boolean(apiKey),
    staleTime: 10_000,
  });
  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: key.slice(0, 2) });
  }, [queryClient, key.slice]);
  useFilesLive({
    filter: {
      and: [
        { field: "instance_type", op: "eq", value: instanceType },
        { field: "instance_id", op: "eq", value: instanceId },
      ],
    },
    enabled: Boolean(apiKey),
    onEvent: refetch,
  });
  return {
    files: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch,
  };
}

/** A select over `files`, by name (with the folder when it has one). */
export function FilePicker({
  files,
  value,
  onChange,
  label,
  testId = "file-picker",
}: {
  files: readonly FileInfo[];
  value: string;
  onChange: (fileId: string) => void;
  label: string;
  testId?: string;
}) {
  return (
    <label className="picker">
      <span className="picker__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {files.map((file) => (
          <option key={file.id} value={file.id}>
            {file.filename}
            {file.encryption !== "none" ? ` · ${file.encryption}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The empty state of a page that needs the seeded pack. */
export function SeedHint({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="empty" data-testid="seed-hint">
      <p>{children ?? t("APP", "SEED_HINT")}</p>
      <Code text={SEED_COMMAND} />
    </div>
  );
}

/** A block of code with a Copy button. */
export function Code({ text, label }: { text: string; label?: string | undefined }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard: the text is selectable
    }
  };
  return (
    <div className="code">
      {label ? <span className="code__label">{label}</span> : null}
      <pre className="code__text">{text}</pre>
      <button type="button" className="btn btn--ghost code__copy" onClick={copy}>
        {copied ? t("APP", "COPIED") : t("APP", "COPY")}
      </button>
    </div>
  );
}

export function ErrorLine({ error }: { error: Error | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {t("APP", "ERROR", { message: error.message })}
    </p>
  );
}

/** The note a page shows when writes cannot go anywhere (own key, proxy off). */
export function WriteNotice() {
  const { t } = useI18n();
  const { connection } = useSettings();
  if (connection.proxied || connection.source !== "own") return null;
  return <p className="notice">{t("APP", "WRITE_KEY_NEEDED")}</p>;
}

/** A link to the Browse page, at a folder. */
export function BrowseLink({ folder }: { folder?: string | undefined }) {
  const { t } = useI18n();
  const to = folder ? `/examples/browse?folder=${encodeURIComponent(folder)}` : "/examples/browse";
  return (
    <Link className="link" to={to}>
      {t("APP", "OPEN_BROWSE")}
    </Link>
  );
}

/** Loading / error / content of a page section. */
export function Loaded({
  isLoading,
  error,
  children,
}: {
  isLoading: boolean;
  error: Error | null;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (error) return <ErrorLine error={error} />;
  if (isLoading) return <p className="muted">{t("APP", "LOADING")}</p>;
  return <>{children}</>;
}
