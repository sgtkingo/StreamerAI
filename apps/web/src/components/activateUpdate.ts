import { UpdateSaveError } from "./updateSave";

/** Wait for the worker to activate before finishing the update. */
export async function activateUpdate(trigger: () => Promise<void>) {
  const registration = await navigator.serviceWorker?.getRegistration();
  const worker = registration?.waiting;
  if (!worker) return trigger();
  await new Promise<void>((resolve, reject) => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(retry);
      worker.removeEventListener("statechange", changed);
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const changed = () => {
      if (worker.state === "activated") {
        cleanup();
        resolve();
      } else if (worker.state === "redundant")
        fail(
          new UpdateSaveError(
            "The new version could not be activated. Reload this page and try again.",
          ),
        );
    };
    const poke = () => {
      changed();
      if (worker.state === "activated" || worker.state === "redundant") return;
      if (worker.state === "installed") {
        try {
          worker.postMessage({ type: "SKIP_WAITING" });
        } catch (reason) {
          fail(reason);
          return;
        }
      }
      retry = setTimeout(poke, 1000);
    };
    worker.addEventListener("statechange", changed);
    poke();
  });
}
