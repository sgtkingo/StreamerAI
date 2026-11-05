import { useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";

let updateWorker: ReturnType<typeof registerSW> | null = null;
let updateReady = false;
const readyListeners = new Set<() => void>();
const mediaPlaying = () =>
  Array.from(document.querySelectorAll("video, audio")).some(
    (element) =>
      !(element as HTMLMediaElement).paused &&
      !(element as HTMLMediaElement).ended,
  );

export function UpdateNotice() {
  const [ready, setReady] = useState(updateReady);
  const [applying, setApplying] = useState(false);
  const [blocked, setBlocked] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const peers = useRef(new Map<string, { busy: boolean; at: number }>());
  const identity = useRef(
    `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  );
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
    const connection =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("streamerai-update-readiness-v1");
    channel.current = connection;
    const publish = () =>
      connection?.postMessage({
        kind: "status",
        id: identity.current,
        busy: dirtyRef.current || mediaPlaying(),
      });
    if (connection)
      connection.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as {
          kind?: unknown;
          id?: unknown;
          busy?: unknown;
        } | null;
        if (
          !message ||
          typeof message.id !== "string" ||
          message.id === identity.current
        )
          return;
        if (message.kind === "query") publish();
        if (message.kind === "leave") peers.current.delete(message.id);
        if (
          message.kind === "status" &&
          typeof message.busy === "boolean" &&
          peers.current.size < 50
        )
          peers.current.set(message.id, { busy: message.busy, at: Date.now() });
      };
    const edited = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          "input:not([type=range]), textarea, select, [contenteditable=true]",
        ) &&
        !target.closest(".deployment-update")
      ) {
        dirtyRef.current = true;
        setDirty(true);
        publish();
      }
    };
    const leave = () =>
      connection?.postMessage({ kind: "leave", id: identity.current });
    document.addEventListener("input", edited, true);
    document.addEventListener("change", edited, true);
    window.addEventListener("pagehide", leave);
    publish();
    const heartbeat = setInterval(publish, 2000);
    return () => {
      leave();
      clearInterval(heartbeat);
      connection?.close();
      channel.current = null;
      document.removeEventListener("input", edited, true);
      document.removeEventListener("change", edited, true);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  if (!ready) return null;
  const activate = async () => {
    setApplying(true);
    setBlocked("");
    channel.current?.postMessage({ kind: "query", id: identity.current });
    await new Promise((done) => setTimeout(done, 500));
    if (
      mediaPlaying() ||
      dirtyRef.current ||
      [...peers.current.values()].some(
        (peer) => peer.busy || Date.now() - peer.at > 10_000,
      )
    ) {
      setBlocked(
        "Finish playback and save changes in every StreamerAI tab before updating. If a tab stopped responding, close it and reload this page.",
      );
      setApplying(false);
      return;
    }
    try {
      await updateWorker?.(true);
    } catch {
      setBlocked("The update could not be applied. Try again later.");
      setApplying(false);
    }
  };
  return (
    <aside className="deployment-update" aria-label="Application update">
      <span>A new version is ready. Save your changes before updating.</span>
      {dirty && (
        <button
          type="button"
          onClick={() => {
            dirtyRef.current = false;
            setDirty(false);
          }}
        >
          I have saved my changes
        </button>
      )}
      {!channel.current && (
        <span>Close other StreamerAI tabs before updating.</span>
      )}
      <button
        type="button"
        disabled={applying}
        onClick={() => {
          void activate();
        }}
      >
        Update when ready
      </button>
      {blocked && <span role="status">{blocked}</span>}
    </aside>
  );
}
