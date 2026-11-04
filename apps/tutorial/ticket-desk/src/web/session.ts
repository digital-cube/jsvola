import { createContext, useContext } from "react";
import type { Config } from "./api.ts";

export interface Session extends Config {
  /** Who is "signed in": the pick in the header. Everything they do carries this as X-User-Id. */
  user: string;
  locale: "en" | "sr";
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside of <SessionContext>");
  return session;
}
