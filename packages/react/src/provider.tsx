import { VolaClient, type VolaClientOptions } from "@vola/client";
import { createContext, type ReactNode, useContext, useMemo } from "react";

const VolaContext = createContext<VolaClient | null>(null);

export interface VolaProviderProps extends VolaClientOptions {
  children?: ReactNode;
}

/** Makes one `VolaClient` available to every `useVola()` below it. */
export function VolaProvider({ children, baseUrl, apiKey, fetch }: VolaProviderProps) {
  const client = useMemo(
    () => new VolaClient({ baseUrl, ...(apiKey ? { apiKey } : {}), ...(fetch ? { fetch } : {}) }),
    [baseUrl, apiKey, fetch],
  );
  return <VolaContext.Provider value={client}>{children}</VolaContext.Provider>;
}

/** The client of the nearest `VolaProvider`. Throws outside one. */
export function useVola(): VolaClient {
  const client = useContext(VolaContext);
  if (!client) throw new Error("useVola() must be used inside <VolaProvider>");
  return client;
}
