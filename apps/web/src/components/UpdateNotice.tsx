import { useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";
import {
  hasUpdateSaves,
  saveBeforeUpdate,
  UpdateSaveError,
} from "./updateSave";
import { UpdateCoordinator } from "./updateCoordinator";
import { activateUpdate } from "./activateUpdate";

let updateWorker: ReturnType<typeof registerSW> | null = null;
let updateReady = false;
const readyListeners = new Set<() => void>();
const updateError = (reason: unknown) =>
  reason instanceof UpdateSaveError
    ? reason.message
    : "Changes could not be saved or the update could not be applied. Check your settings and try again.";

export function UpdateNotice() {
  const [ready, setReady] = useState(updateReady);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const coordinator = useRef<UpdateCoordinator | null>(null);
  const notice = useRef<HTMLElement>(null);

  useEffect(() => {
    const notify = () => setReady(true);
    readyListeners.add(notify);
    updateWorker ??= registerSW({
      immediate: true,
      onNeedRefresh: () => {
        updateReady = true;
        for (const listener of readyListeners) listener();
      },
    });
    return () => {
      readyListeners.delete(notify);
    };
  }, []);

  useEffect(() => {
    const controller = new UpdateCoordinator({
      connection:
        typeof BroadcastChannel === "undefined"
          ? null
          : new BroadcastChannel("streamerai-update-readiness-v1"),
      prepare: saveBeforeUpdate,
      busy: hasUpdateSaves,
      onBusy: (busy) => {
        setApplying(busy);
        if (busy) setError("");
      },
      onError: (reason) => setError(updateError(reason)),
    });
    coordinator.current = controller;
    const leave = () => controller.dispose();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      controller.dispose();
      coordinator.current = null;
    };
  }, []);

  useEffect(() => {
    if (!applying) return;
    // Prevent edits while saves are in flight, in both the initiating tab and peers.
    const root = document.getElementById("root");
    const previous = new Map<HTMLElement, boolean>();
    const lock = () => {
      for (const element of Array.from(root?.children ?? [])) {
        if (
          !(element instanceof HTMLElement) ||
          element.contains(notice.current)
        )
          continue;
        if (!previous.has(element)) previous.set(element, element.inert);
        element.inert = true;
      }
    };
    lock();
    const observer = new MutationObserver(lock);
    if (root) observer.observe(root, { childList: true });
    return () => {
      observer.disconnect();
      for (const [element, inert] of previous) element.inert = inert;
    };
  }, [applying]);

  if (!ready && !applying && !error) return null;
  const activate = async () => {
    setError("");
    try {
      await coordinator.current?.apply(async () => {
        if (!updateWorker) throw new Error("Update is unavailable");
        await activateUpdate(() => updateWorker!(true));
      });
    } catch (reason) {
      setError(updateError(reason));
    }
  };

  return (
    <aside
      ref={notice}
      className="deployment-update"
      aria-label="Application update"
      aria-busy={applying}
    >
      <span role="status">
        {applying ? "Saving changes and updating…" : "A new version is ready."}
      </span>
      <button
        type="button"
        disabled={applying}
        onClick={() => {
          void activate();
        }}
      >
        {applying ? "Updating…" : "Update now"}
      </button>
      {error && <span role="alert">{error}</span>}
    </aside>
  );
}
