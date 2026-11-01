/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API base URL the page starts with. Default `/vola`. */
  readonly VITE_VOLA_BASE_URL?: string;
  /** A key of the visitor's own, pre-filled (development). */
  readonly VITE_VOLA_API_KEY?: string;
}
