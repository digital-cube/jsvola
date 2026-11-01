import { useI18n, useUdcCollections } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { useSettings } from "../connection.js";
import { MenuTree, RemoteMenu } from "./MenuTree.js";
import { BUILTIN_MENU_ROWS } from "./menu.js";
import { ConnectionForm, KeyBadge, SettingsPopover } from "./Settings.js";
import { TopBar } from "./TopBar.js";

/** The collection the sidebar is drawn from (`menu.yaml` served by `@vola/server`). */
export const MENU_COLLECTION = "menu";

/** Header, sidebar (the menu collection), and the page of the route. */
export function AppShell() {
  const { connection } = useSettings();
  return (
    <div className="app">
      <TopBar end={<SettingsPopover />}>
        <KeyBadge connection={connection} />
      </TopBar>
      <div className="app__body">
        <Sidebar />
        <main className="app__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * The sidebar: the `menu` collection drawn as a tree when the server serves one; the built-in
 * EXAMPLES entries without a key, without the collection or when the server cannot be asked.
 */
function Sidebar() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <nav aria-label={t("APP", "NAV_MENU")} data-testid="sidebar" className="sidebar">
      {connection.apiKey ? <ServedMenu /> : <MenuTree rows={BUILTIN_MENU_ROWS} source="builtin" />}
    </nav>
  );
}

function ServedMenu() {
  const collections = useUdcCollections();
  const menu = collections.data?.collections.find((c) => c.name === MENU_COLLECTION);
  if (menu) return <RemoteMenu listing={menu} fallback={BUILTIN_MENU_ROWS} />;
  if (collections.isLoading) return <div className="menu__loading" data-testid="menu-loading" />;
  return <MenuTree rows={BUILTIN_MENU_ROWS} source="builtin" />;
}

/**
 * A page that talks to the server: its content once there is a key (the visitor's own or
 * the demo key), a spinner while the configuration is being asked for, the connection form
 * and the "paste a key" hint when there is neither.
 */
export function Connected({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { connection } = useSettings();
  if (connection.apiKey) return <>{children}</>;
  if (connection.source === "pending") {
    return (
      <div className="page__center" data-testid="connecting">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="hint" data-testid="no-key">
      <p>{t("APP", "NO_KEY")}</p>
      <ConnectionForm />
    </div>
  );
}
