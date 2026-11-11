import { useEffect, useRef } from "react";
import { UpdateSaveError, useUpdateSave } from "./updateSave";

const TAB_KEY = "streamer.update-draft-tab.v1";
const TTL = 30 * 60_000;
type Draft = { key: string; value: unknown; expires: number };

function draftKey(scope: string) {
  let tab = sessionStorage.getItem(TAB_KEY);
  if (!tab) {
    tab = crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, tab);
  }
  return `${tab}:${scope}`;
}

export async function discardUpdateDraft(scope: string) {
  try {
    await transaction((store) => store.delete(draftKey(scope)), true);
  } catch {
    /* A completed form must not be blocked by unavailable draft storage. */
  }
}

async function transaction<T>(
  run: (store: IDBObjectStore) => IDBRequest<T>,
  write = false,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("streamer-update-drafts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(
        "drafts",
        write ? "readwrite" : "readonly",
      );
      const store = tx.objectStore("drafts");
      const request = run(store);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      if (write) {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          if ((entry.value as Draft).expires < Date.now()) entry.delete();
          entry.continue();
        };
      }
    });
  } finally {
    database.close();
  }
}

/** Explicitly opted-in, non-credential drafts only. Never snapshot arbitrary DOM fields. */
export function useUpdateDraft<T>(
  scope: string,
  value: T,
  dirty: boolean,
  restore: (value: unknown) => void,
  restoreReady = true,
) {
  const current = useRef({ value, dirty, restore });
  current.current = { value, dirty, restore };
  const restoring = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!restoreReady) return;
    let active = true;
    const original = JSON.stringify(current.current.value);
    restoring.current = (async () => {
      const key = draftKey(scope);
      const draft = await transaction<Draft | undefined>((store) =>
        store.get(key),
      );
      if (!active || !draft) return;
      // A user who already started typing takes precedence over a recovered draft.
      if (
        draft.expires > Date.now() &&
        (!current.current.dirty ||
          JSON.stringify(current.current.value) === original)
      )
        current.current.restore(draft.value);
      if (active) await transaction((store) => store.delete(key), true);
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [scope, restoreReady]);
  useUpdateSave(dirty, async () => {
    await restoring.current;
    try {
      const key = draftKey(scope);
      await transaction(
        (store) =>
          store.put({
            key,
            value: current.current.value,
            expires: Date.now() + TTL,
          } satisfies Draft),
        true,
      );
    } catch {
      throw new UpdateSaveError(
        "Your unfinished draft could not be saved on this device. Check that browser storage is available, then try again.",
      );
    }
  });
}
