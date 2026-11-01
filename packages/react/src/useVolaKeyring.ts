import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useVolaContext } from "./context.js";
import type { KeyringState, KeyringStore } from "./keyring.js";

export interface VolaKeyring extends KeyringState {
  /** `GET /keyrings/me/status` again. */
  refresh: KeyringStore["refresh"];
  /** `POST /keyrings/me {pin}` → the recovery key, shown this once. */
  setup: KeyringStore["setup"];
  unlock: KeyringStore["unlock"];
  /** Revokes every `blob:` URL, forgets the token, tells the server. */
  lock: KeyringStore["lock"];
  changePin: KeyringStore["changePin"];
  recover: KeyringStore["recover"];
  /** What a reset would shred, without decrypting anything. */
  deletePreview: KeyringStore["deletePreview"];
  /** The crypto-shred: every file under the keyring and the keyring itself. */
  reset: KeyringStore["reset"];
  /** "I am here": cancels a running auto-lock countdown. */
  stay: () => void;
  /** The store itself, for a host that wants to subscribe outside React. */
  store: KeyringStore;
}

/**
 * The keyring of the provider's principal: status, unlock state, the auto-lock phase and
 * every operation. Reads the status once on first use.
 */
export function useVolaKeyring(): VolaKeyring {
  const { keyring } = useVolaContext();
  const state = useSyncExternalStore(keyring.subscribe, keyring.getSnapshot, keyring.getSnapshot);

  useEffect(() => {
    if (state.status === null && !state.loading && state.error === null) void keyring.refresh();
  }, [keyring, state.status, state.loading, state.error]);

  const stay = useCallback(() => keyring.touch(), [keyring]);

  return useMemo<VolaKeyring>(
    () => ({
      ...state,
      refresh: () => keyring.refresh(),
      setup: (pin) => keyring.setup(pin),
      unlock: (pin) => keyring.unlock(pin),
      lock: () => keyring.lock(),
      changePin: (current, next) => keyring.changePin(current, next),
      recover: (key, pin) => keyring.recover(key, pin),
      deletePreview: () => keyring.deletePreview(),
      reset: () => keyring.reset(),
      stay,
      store: keyring,
    }),
    [state, keyring, stay],
  );
}
