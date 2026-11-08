import { useCallback, useEffect, useState } from "react";
import type { StreamerApi } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { DigitSlotsInput } from "./DigitSlotsInput";

export interface InstallationStatus {
  enabled: boolean;
  claimed: boolean;
  paired: boolean;
  role: "owner" | "viewer" | null;
  serverId?: string;
  clientId?: string;
  householdId?: string;
  householdReady?: boolean;
  householdName?: string;
  masterPinEnabled?: boolean;
  cloudConfigured?: boolean;
  cloudLinked?: boolean;
  cloudRecoveryAuthorized?: boolean;
  setupAvailable?: boolean;
  setupAuthorized?: boolean;
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
export const beginHouseholdSetup = () =>
  call<{ setupAuthorized: boolean }>("setup", {});
export function InstallationAccess({
  status,
  onConnected,
  api,
  administration = false,
}: {
  status: InstallationStatus;
  onConnected(): void;
  api?: StreamerApi;
  administration?: boolean;
}) {
  const [name, setName] = useState("Home browser");
  const [request, setRequest] = useState<{
    requestId: string;
    code: string;
    expiresAt: string;
    qrCodeDataUrl?: string;
    verificationUriComplete?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [cloudLogin, setCloudLogin] = useState(false);
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
      setRequest(await call("pair", { name }));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Access unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  const authorize = async () => {
    if (busy || !/^\d{8}$/.test(pin)) return;
    setBusy(true);
    setError("");
    try {
      const input = {
        masterPin: pin,
        deviceName: name.trim() || "Home browser",
        admin: administration,
      };
      if (api?.authorizeInstallation) await api.authorizeInstallation(input);
      else await call("authorize", input);
      setPin("");
      onConnected();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Authorization failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (
    !administration &&
    (status.householdReady === false ||
      (!status.claimed && status.householdReady !== true))
  )
    return (
      <main className="installation-screen">
        <p className="eyebrow">StreamerAI home server</p>
        <h1>
          {status.claimed
            ? "Your household is not ready yet"
            : "Set up your household first"}
        </h1>
        <p>
          The server owner can create a household or import a backup in
          household administration.
        </p>
        <a className="button button--primary" href="/admin">
          Open household administration
        </a>
      </main>
    );
  if (cloudLogin && api)
    return (
      <AccountLogin
        api={api}
        compact
        adminLogin
        onCancel={() => setCloudLogin(false)}
        onAuthenticated={onConnected}
      />
    );
  const localPairUrl =
    request?.verificationUriComplete ??
    (request
      ? new URL(
          `/admin/pair?code=${encodeURIComponent(request.code)}`,
          window.location.origin,
        ).href
      : "");
  return (
    <main className="installation-screen">
      <p className="eyebrow">StreamerAI home server</p>
      <h1>
        {administration ? "Household administration" : "Connect this device"}
      </h1>
      <p>
        {administration
          ? "Enter this household's Master PIN to administer this server."
          : "Pair this browser with your home server. Your device stays connected when the cloud is unavailable."}
      </p>
      {administration && !status.claimed && status.householdReady !== true ? (
        <a className="button button--primary" href="/admin">
          Set up your household
        </a>
      ) : administration || signIn ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void authorize();
          }}
        >
          <DigitSlotsInput
            label="Household Master PIN"
            value={pin}
            onChange={setPin}
            disabled={busy}
          />
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || !/^\d{8}$/.test(pin)}
          >
            {busy
              ? "Authorizing?"
              : administration
                ? "Open administration"
                : "Connect this device"}
          </button>
          {!administration && (
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                setSignIn(false);
                setPin("");
              }}
            >
              Use a pairing code instead
            </button>
          )}
        </form>
      ) : (
        <>
          {!request && (
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="field">
                <span>Device name</span>
                <input
                  value={name}
                  maxLength={80}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy}
              >
                {busy ? "Preparing code?" : "Show pairing code"}
              </button>
            </form>
          )}
          {request && (
            <div className="local-device-pairing" role="status">
              {request.qrCodeDataUrl && (
                <img
                  src={request.qrCodeDataUrl}
                  width={208}
                  height={208}
                  alt="Scan to approve this device on your home server"
                />
              )}
              <p>
                Open household administration on an approved device and compare
                this code:
              </p>
              <p
                className="installation-code"
                aria-label={`Pairing code ${request.code}`}
              >
                {request.code.replace(/(\d{3})(\d{3})/, "$1 $2")}
              </p>
              <a href={localPairUrl}>{localPairUrl}</a>
              <p>Waiting for approval. This code expires in five minutes.</p>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setRequest(null)}
              >
                Get a new code
              </button>
            </div>
          )}
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setSignIn(true)}
          >
            Sign in on this device
          </button>
        </>
      )}
      {administration &&
        status.claimed &&
        status.cloudConfigured &&
        status.cloudLinked !== false &&
        api?.startDeviceAuthorization && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setCloudLogin(true)}
          >
            Sign in with cloud account
          </button>
        )}
      {!administration && (
        <p>
          <a href="/admin">Open household administration</a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

export function InstallationDevices({
  initialCode = "",
}: {
  initialCode?: string;
}) {
  const [data, setData] = useState<{
    devices: { id: string; name: string; role: string; current: boolean }[];
    pending: { id: string; name: string; code?: string }[];
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
        Devices need approval before they can use this home server. Each paired
        device receives its own revocable access to this household.
      </p>
      {data?.pending.map((item) => (
        <div className="deployment-card" key={item.id}>
          <strong>{item.name}</strong>
          <label className="field">
            <span>Code shown on the requesting device</span>
            <input
              value={
                codes[item.id] ?? (item.code === initialCode ? initialCode : "")
              }
              maxLength={6}
              onChange={(event) =>
                setCodes({
                  ...codes,
                  [item.id]: event.target.value.replace(/\D/g, "").slice(0, 6),
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
                  code:
                    codes[item.id] ??
                    (item.code === initialCode ? initialCode : ""),
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
          {!device.current &&
            (device.role !== "owner" ||
              (data?.devices.filter((item) => item.role === "owner").length ??
                0) > 1) && (
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
