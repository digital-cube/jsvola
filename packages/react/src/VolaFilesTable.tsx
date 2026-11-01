import type { ColumnConfig, Row } from "@jsudc/core";
import {
  createRendererRegistry,
  EmptyState,
  ErrorState,
  FALLBACK_ICON,
  type RendererDefinition,
  type RendererProps,
  resolveIcon,
  useI18n,
} from "@jsudc/react";
import { CellValue } from "@jsudc/react/table";
import { type RefObject, useEffect, useRef } from "react";
import {
  type BrowserFile,
  ROW_ACTIONS,
  type RowAction,
  rowToFile,
  useFileBrowser,
} from "./browserContext.js";
import { useVolaT } from "./i18n.js";
import { VolaMenu } from "./VolaMenu.js";
import { VolaThumb } from "./VolaThumb.js";

/** The sort keys the `files` collection accepts (`FILES_SORTABLE` of `@vola/server`). */
export const FILES_SORTABLE: readonly string[] = ["created_at", "filename", "size"];
/** The name an encrypted file has in a row whose name cannot be decrypted (`@vola/server`). */
export const ENCRYPTED_FILENAME = "<encrypted>";

const ACTION_TERM: Record<RowAction, string> = {
  download: "DOWNLOAD",
  rename: "RENAME",
  move: "MOVE",
  delete: "DELETE",
  versions: "VERSIONS",
  share: "SHARE",
  visibility: "VISIBILITY",
};

/**
 * Infinite mode: when `sentinel` (under the last row) scrolls into view, the next page is
 * asked for. Without `IntersectionObserver` (an old browser, jsdom) the "Load more" button remains.
 */
function useInfiniteSentinel(
  enabled: boolean,
  sentinel: RefObject<HTMLElement | null>,
  data: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => void },
): void {
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    const element = sentinel.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      const { hasNextPage, isFetchingNextPage, fetchNextPage } = latest.current;
      if (visible && hasNextPage && !isFetchingNextPage) fetchNextPage();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, sentinel]);
}

/** The row actions of one file. */
function RowActions({ file }: { file: BrowserFile }) {
  const { t } = useVolaT();
  const browser = useFileBrowser();
  if (!browser) return null;
  const items = [
    ...(browser.onOpen
      ? [{ key: "open", label: t("OPEN"), onSelect: () => browser.onOpen?.(file) }]
      : []),
    ...browser.actions.map((action) => ({
      key: action,
      label: t(ACTION_TERM[action]),
      danger: action === "delete",
      onSelect: () => browser.onAction(action, file),
    })),
  ];
  return <VolaMenu label={t("ACTIONS_FOR", { name: file.filename })} items={items} />;
}

/**
 * The table of the file browser: the `files` view's columns as `@jsudc/react` draws them,
 * the thumbnail through `VolaThumb` (so an encrypted file's preview works under an unlock
 * too), the name as the "open" link, and a row-actions menu at the end. Sorting by header,
 * infinite paging by sentinel or button, pages by a pager.
 */
export function VolaFilesTable({
  describe,
  data,
  sort,
  onSort,
  mode,
  page,
  limit,
  onPage,
  filtered,
  onClearFilters,
}: RendererProps) {
  const { t } = useVolaT();
  const { locale, intlLocale } = useI18n();
  const browser = useFileBrowser();
  const root = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  useInfiniteSentinel(mode === "infinite", sentinel, data);

  const wanted = browser?.columns;
  const viewColumns = describe.view.columns;
  const columns: ColumnConfig[] = wanted
    ? wanted.flatMap((field) => {
        const known = viewColumns.find((c) => c.field === field);
        return known ? [known] : field in describe.schema.fields ? [{ field }] : [];
      })
    : viewColumns;
  const sortable = browser?.sortable ?? FILES_SORTABLE;
  const label = (field: string) => describe.schema.fields[field]?.label ?? field;
  const sortOf = (field: string) => sort.find((s) => s.field === field);
  const pages = data.total !== null ? Math.max(1, Math.ceil(data.total / limit)) : null;

  return (
    <div ref={root} className="vola-table-wrap">
      <table className="vola-table">
        <thead>
          <tr>
            {columns.map((column) => {
              const field = column.field;
              const current = sortOf(field);
              const name = typeof label(field) === "string" ? String(label(field)) : field;
              return (
                <th
                  key={column.id ?? field}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={
                    current ? (current.dir === "asc" ? "ascending" : "descending") : undefined
                  }
                  data-align={column.align}
                >
                  {sortable.includes(field) ? (
                    <button
                      type="button"
                      className="vola-table__sort"
                      onClick={(event) => onSort(field, event.shiftKey)}
                      aria-label={t("SORT_BY", { field: name })}
                    >
                      {name}
                      {current ? (
                        <span aria-hidden="true">{current.dir === "asc" ? " ▲" : " ▼"}</span>
                      ) : null}
                    </button>
                  ) : (
                    name
                  )}
                </th>
              );
            })}
            {browser ? (
              <th scope="col" className="vola-table__actions">
                <span className="vola-sr-only">{t("ACTIONS")}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <FileRow
              key={row.__meta.id}
              row={row}
              columns={columns}
              locale={locale}
              intlLocale={intlLocale}
            />
          ))}
        </tbody>
      </table>
      {data.error ? <ErrorState error={data.error} onRetry={data.refetch} /> : null}
      {!data.error && data.isLoading ? (
        <p className="vola-muted vola-table__state">{t("LOADING")}</p>
      ) : null}
      {!data.error && !data.isLoading && data.rows.length === 0 ? (
        <EmptyState filtered={filtered} onClear={onClearFilters} body={t("NO_FILES")} />
      ) : null}
      {mode === "infinite" ? (
        <div ref={sentinel} className="vola-table__sentinel">
          {data.hasNextPage ? (
            <button
              type="button"
              className="vola-btn"
              disabled={data.isFetchingNextPage}
              onClick={data.fetchNextPage}
            >
              {t("LOAD_MORE")}
            </button>
          ) : null}
        </div>
      ) : pages !== null && pages > 1 ? (
        <nav className="vola-pager" aria-label="pages">
          <button
            type="button"
            className="vola-btn"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            ‹
          </button>
          <span>
            {page} / {pages}
          </span>
          <button
            type="button"
            className="vola-btn"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            ›
          </button>
        </nav>
      ) : null}
    </div>
  );
}

function FileRow({
  row,
  columns,
  locale,
  intlLocale,
}: {
  row: Row;
  columns: ColumnConfig[];
  locale: string;
  intlLocale: string;
}) {
  const { t } = useVolaT();
  const browser = useFileBrowser();
  const file = rowToFile(row);
  const encrypted = file.encryption !== "none";
  const masked = file.filename === ENCRYPTED_FILENAME;
  return (
    <tr
      data-id={file.id}
      data-encryption={file.encryption}
      data-processing={file.processing_status ?? undefined}
    >
      {columns.map((column) => {
        const field = column.field;
        const value = row[field];
        let cell: React.ReactNode;
        if (field === "thumb_url") {
          cell = <VolaThumb file={file} size={64} alt={masked ? "" : file.filename} />;
        } else if (field === "filename") {
          cell = (
            <span className="vola-table__name">
              {encrypted ? (
                <span
                  className="vola-table__lock"
                  role="img"
                  title={t("ENCRYPTED")}
                  aria-label={t("ENCRYPTED")}
                >
                  🔒
                </span>
              ) : null}
              {browser?.onOpen && !masked ? (
                <button type="button" className="vola-link" onClick={() => browser.onOpen?.(file)}>
                  {file.filename}
                </button>
              ) : (
                <span>{file.filename}</span>
              )}
            </span>
          );
        } else {
          cell = (
            <CellValue
              value={value}
              column={column}
              def={undefined}
              locale={locale}
              intlLocale={intlLocale}
            />
          );
        }
        return (
          <td key={column.id ?? field} data-field={field} data-align={column.align}>
            {cell}
          </td>
        );
      })}
      {browser ? (
        <td className="vola-table__actions">
          <RowActions file={file} />
        </td>
      ) : null}
    </tr>
  );
}

/** The `table` renderer of the file browser, for `createRendererRegistry`. */
export const volaTableRenderer: RendererDefinition = {
  name: "table",
  component: VolaFilesTable,
  icon: resolveIcon("table") ?? FALLBACK_ICON,
  labelKey: "RENDERER_TABLE",
  paging: true,
  editMode: false,
};

/** The registry `VolaProvider` installs by default: the file browser's table. */
export const VOLA_RENDERERS = createRendererRegistry(volaTableRenderer);

export { ROW_ACTIONS };
