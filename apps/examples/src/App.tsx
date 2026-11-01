import { UdcDataView } from "@jsudc/react";
import { UdcReactRouterUrlState } from "@jsudc/react/react-router";
import { VolaClient } from "@vola/client";
import { VolaProvider } from "@vola/react";
import { useCallback, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import {
  connectionOf,
  demoFetch,
  SettingsProvider,
  useExamplesConfig,
  useSettings,
} from "./connection.js";
import { ApiPage } from "./examples/api/Api.js";
import { BrowsePage } from "./examples/browse/Browse.js";
import { EncryptedPage } from "./examples/encrypted/Encrypted.js";
import { SharePage } from "./examples/share/Share.js";
import { StreamingPage } from "./examples/streaming/Streaming.js";
import { ThumbnailsPage } from "./examples/thumbnails/Thumbnails.js";
import { UploadPage } from "./examples/upload/Upload.js";
import { EXAMPLES_MESSAGES } from "./i18n/messages.js";
import {
  defaultSettings,
  loadSettings,
  resetVisitorId,
  type Settings,
  saveSettings,
  visitorId,
} from "./settings.js";
import { AppShell, Connected } from "./shell/AppShell.js";
import { routerBasename } from "./shell/locale.js";

/** The first example: where `/` leads. */
export const FIRST_EXAMPLE = "/examples/browse";

/** Bytes from which the site uploads resumably: 1 MiB (the demo caps uploads at 5 MiB, so the resumable path has room). */
export const RESUMABLE_THRESHOLD = 1024 * 1024;
/** Bytes per `PATCH` of a resumable upload here: small, so the progress bar moves. */
export const CHUNK_SIZE = 256 * 1024;

export { routerBasename };

/** `/udc/:collection`: any collection the server lists, as a plain data view. */
function CollectionPage() {
  const { collection = "" } = useParams();
  return (
    <div className="page">
      <Connected>
        <section className="view">
          <UdcDataView key={collection} collection={collection} />
        </section>
      </Connected>
    </div>
  );
}

export interface AppProps {
  /** `fetch` the configuration and the client use (tests). Default: the global one. */
  fetch?: typeof fetch | undefined;
}

export function App({ fetch: doFetch }: AppProps = {}) {
  const [settings, setSettings] = useState<Settings>(() =>
    loadSettings(localStorage, defaultSettings()),
  );
  const [visitor, setVisitor] = useState(() => visitorId(sessionStorage));
  const demo = useExamplesConfig(settings.baseUrl, doFetch);
  const connection = connectionOf(settings, demo, visitor);
  const apply = useCallback((next: Settings) => {
    saveSettings(localStorage, next);
    setSettings(next);
  }, []);
  const newVisitor = useCallback(() => setVisitor(resetVisitorId(sessionStorage)), []);

  const { baseUrl, apiKey, proxied } = connection;
  const writePath = connection.demo?.write_path ?? `${baseUrl}/examples/write/`;
  const client = useMemo(
    () =>
      new VolaClient({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        userId: visitor,
        fetch: demoFetch({ baseUrl, writePath, enabled: proxied, fetch: doFetch }),
      }),
    [baseUrl, apiKey, visitor, writePath, proxied, doFetch],
  );
  const [basename] = useState(() => routerBasename(location.pathname));

  return (
    <SettingsProvider value={{ settings, connection, apply, newVisitor }}>
      <VolaProvider
        key={`${baseUrl}|${apiKey}|${visitor}`}
        client={client}
        messages={EXAMPLES_MESSAGES}
        resumableThreshold={RESUMABLE_THRESHOLD}
      >
        <BrowserRouter basename={basename}>
          <UdcReactRouterUrlState>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Navigate to={FIRST_EXAMPLE} replace />} />
                <Route path="examples/browse" element={<BrowsePage />} />
                <Route path="examples/upload" element={<UploadPage />} />
                <Route path="examples/thumbnails" element={<ThumbnailsPage />} />
                <Route path="examples/streaming" element={<StreamingPage />} />
                <Route path="examples/share" element={<SharePage />} />
                <Route path="examples/encrypted" element={<EncryptedPage />} />
                <Route path="examples/api" element={<ApiPage />} />
                <Route path="udc/:collection" element={<CollectionPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </UdcReactRouterUrlState>
        </BrowserRouter>
      </VolaProvider>
    </SettingsProvider>
  );
}

/** The connection, for a page outside the router (tests). */
export { useSettings };
