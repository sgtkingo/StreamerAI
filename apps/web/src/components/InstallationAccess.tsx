import { useCallback, useEffect, useRef, useState } from "react";

export interface InstallationStatus {
  enabled: boolean;
  claimed: boolean;
  paired: boolean;
  role: "owner" | "viewer" | null;
}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/installation/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Too many attempts. Wait a few minutes before trying again."
        : "The request could not be completed. Check the code and try again.",
    );
  return response.json() as Promise<T>;
}
export const getInstallationStatus = () => call<InstallationStatus>("status");
export function InstallationAccess({
  status,
  onConnected,
}: {
  status: InstallationStatus;
  onConnected(): void;
}) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("Home browser");
  const [request, setRequest] = useState<{
    requestId: string;
    code: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setupHandoff = useRef<{ token: string; job?: Promise<unknown> } | null>(
    null,
  );
  useEffect(() => {
    if (status.claimed) return;
    if (!setupHandoff.current) {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const setup = fragment.get("setup");
      if (setup === null) return;
      fragment.delete("setup");
      const rest = fragment.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`,
      );
      if (!/^[a-f0-9]{64}$/.test(setup)) {
        setError(
          "The installation setup link is invalid. Reopen StreamerAI from its installer.",
        );
        return;
      }
      setupHandoff.current = { token: setup };
    }
    const handoff = setupHandoff.current;
    if (!handoff) return;
    // The ref also deduplicates React StrictMode's effect replay. Nothing is
    // stored in browser storage, query parameters, or logging.
    handoff.job ??= call("claim", { token: handoff.token });
    handoff.token = "";
    setBusy(true);
    let active = true;
    void handoff.job
      .then(() => {
        if (active) onConnected();
      })
      .catch(() => {
        if (active)
          setError(
            "Server setup could not be completed. Reopen StreamerAI from its installer or enter your one-time key.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [status.claimed, onConnected]);
  useEffect(() => {
    if (!request) return;
    let active = true;
    const timer = setInterval(() => {
      void call<{ status: string }>("poll", { requestId: request.requestId })
        .then((result) => {
          if (!active) return;
          if (result.status === "approved") onConnected();
          if (["expired", "denied"].includes(result.status)) {
            setError(`Access request ${result.status}. Start a new request.`);
            setRequest(null);
          }
        })
        .catch((reason: unknown) => {
          if (active)
            setError(
              reason instanceof Error ? reason.message : "Access unavailable.",
            );
        });
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [request, onConnected]);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (!status.claimed) {
        await call("claim", { token: token.trim() });
        setToken("");
        onConnected();
      } else setRequest(await call("pair", { name }));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Access unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="installation-screen">
      <p className="eyebrow">StreamerAI · Home server</p>
      <h1>
        {status.claimed ? "Connect this device" : "Set up the server owner"}
      </h1>
      <p>
        {status.claimed
          ? "Request access, then ask the server owner to compare your code and approve this device in Settings."
          : "The StreamerAI installer prepares your owner access automatically. You can also enter a one-time setup key from your server administrator."}
      </p>
      {!request && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>{status.claimed ? "Device name" : "One-time setup key"}</span>
            {status.claimed ? (
              <input
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
            ) : (
              <input
                type="password"
                value={token}
                autoComplete="off"
                required
                onChange={(event) => setToken(event.target.value)}
              />
            )}
          </label>
          <button
            className="button button--primary"
            type="submit"
            disabled={busy}
          >
            {busy
              ? "Connecting…"
              : status.claimed
                ? "Request access"
                : "Claim server"}
          </button>
        </form>
      )}
      {request && (
        <div role="status">
          <p>Compare this code with the server owner:</p>
          <p className="installation-code">{request.code}</p>
          <p>Waiting for approval. This code expires in five minutes.</p>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setRequest(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

export function InstallationDevices() {
  const [data, setData] = useState<{
    devices: { id: string; name: string; role: string; current: boolean }[];
    pending: { id: string; name: string }[];
  } | null>(null);
  const [owner, setOwner] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const refresh = useCallback(
    () => call<NonNullable<typeof data>>("devices").then(setData),
    [],
  );
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void getInstallationStatus()
      .then((status) => {
        if (!active || status.role !== "owner") return;
        setOwner(true);
        void refresh().catch(() => undefined);
        timer = setInterval(() => {
          void refresh().catch(() => undefined);
        }, 5000);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  if (!owner) return null;
  const action = async (path: string, input: unknown) => {
    setError("");
    try {
      await call(path, input);
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Device action failed.",
      );
    }
  };
  return (
    <section className="profile-page__section">
      <p className="eyebrow">Server access</p>
      <h2>Approved devices</h2>
      <p>
        Devices need approval before they can use this home server. Cloud
        account sign-in is separate.
      </p>
      {data?.pending.map((item) => (
        <div className="deployment-card" key={item.id}>
          <strong>{item.name}</strong>
          <label className="field">
            <span>Code shown on the requesting device</span>
            <input
              value={codes[item.id] ?? ""}
              maxLength={8}
              onChange={(event) =>
                setCodes({
                  ...codes,
                  [item.id]: event.target.value.toUpperCase(),
                })
              }
            />
          </label>
          <div className="deployment-actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={() =>
                void action("decision", {
                  requestId: item.id,
                  code: codes[item.id],
                  approve: true,
                })
              }
            >
              Approve
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() =>
                void action("decision", { requestId: item.id, approve: false })
              }
            >
              Deny
            </button>
          </div>
        </div>
      ))}
      {data?.devices.map((device) => (
        <div className="deployment-card" key={device.id}>
          <span>
            {device.name} · {device.role}
            {device.current ? " · This device" : ""}
          </span>
          {device.role !== "owner" && (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void action("revoke", { deviceId: device.id })}
            >
              Revoke access
            </button>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
