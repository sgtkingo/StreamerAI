import { useCallback, useEffect, useState } from "react";
import type { StreamerApi } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { DigitSlotsInput } from "./DigitSlotsInput";
import { ClientPairing } from "./ClientPairing";
import { AdminIcon, AdminStatus } from "./AdminUI";
import { AdminHelp as InfoTip } from "./AdminUI";
import { Brand } from "./Brand";

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
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: { code?: unknown };
    } | null;
    const error = new Error(
      response.status === 429
        ? "Too many attempts. Wait a few minutes before trying again."
        : "The request could not be completed. Check the code and try again.",
    );
    Object.assign(error, {
      code:
        typeof result?.error?.code === "string" ? result.error.code : undefined,
    });
    throw error;
  }
  return response.json() as Promise<T>;
}
export const getInstallationStatus = () => call<InstallationStatus>("status");
export const beginHouseholdSetup = () =>
  call<{ setupAuthorized: boolean }>("setup", {});
interface InstallationAccessProps {
  status: InstallationStatus;
  onConnected(): void;
  api?: StreamerApi;
  administration?: boolean;
}

export function InstallationAccess(props: InstallationAccessProps) {
  return props.administration ? (
    <AdministrationAccess {...props} />
  ) : (
    <ClientPairing {...props} requestInstallation={call} />
  );
}

function AdministrationAccess({
  status,
  onConnected,
  api,
}: InstallationAccessProps) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cloudLogin, setCloudLogin] = useState(false);
  const authorize = async () => {
    if (busy || !/^\d{8}$/.test(pin)) return;
    setBusy(true);
    setError("");
    try {
      const input = { masterPin: pin, deviceName: "Home browser", admin: true };
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
  return (
    <main className="installation-screen admin-login">
      <div className="admin-login__brand">
        <Brand />
        <AdminStatus>Home server</AdminStatus>
      </div>
      <div className="admin-login__icon">
        <AdminIcon name="lock" />
      </div>
      <p className="eyebrow">StreamerAI home server</p>
      <h1>Sign in to administration</h1>
      <p>Enter this household's Master PIN to administer this server.</p>
      <div className="admin-login__household">
        <AdminIcon name="household" />
        <strong>{status.householdName ?? "Your household"}</strong>
        <AdminStatus tone={status.householdReady ? "success" : "neutral"}>
          {status.householdReady ? "Ready" : "Home server"}
        </AdminStatus>
      </div>
      {!status.claimed && status.householdReady !== true ? (
        <a className="button button--primary" href="/admin">
          Set up your household
        </a>
      ) : (
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
          <div className="admin-login__pin-help">
            <span>8-digit household PIN</span>
            {status.cloudLinked && status.cloudConfigured && (
              <a href="/admin/recover">Forgot PIN?</a>
            )}
          </div>
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || !/^\d{8}$/.test(pin)}
          >
            {busy ? "Authorizing..." : "Open administration"}
          </button>
        </form>
      )}
      {status.claimed &&
        status.cloudConfigured &&
        status.cloudLinked !== false &&
        api?.startDeviceAuthorization && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setCloudLogin(true)}
          >
            <AdminIcon name="cloud" />
            Sign in with cloud account
          </button>
        )}
      <p className="admin-login__help">
        <AdminIcon name="security" />
        This browser connects directly to your home server.{" "}
        <InfoTip label="About administration access">
          Each browser signs in independently. Your Master PIN grants
          administration on this server. Your profiles and paired devices stay
          connected when another browser signs in.
        </InfoTip>
      </p>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

export function InstallationDevices({
  initialCode = "",
  onPairingResolved,
}: {
  initialCode?: string;
  onPairingResolved?(code: string): void;
}) {
  const [data, setData] = useState<{
    devices: {
      id: string;
      name: string;
      role: string;
      current: boolean;
      lastSeenAt?: number;
    }[];
    pending: { id: string; name: string; code?: string }[];
  } | null>(null);
  const [owner, setOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
        void refresh().catch(() =>
          setError("Devices could not be loaded. Try refreshing this page."),
        );
        timer = setInterval(() => {
          void refresh().catch(() => undefined);
        }, 5000);
      })
      .catch(() =>
        setError(
          "Server access could not be checked. Try refreshing this page.",
        ),
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !data ||
      !initialCode ||
      data.pending.some((item) => item.code === initialCode)
    )
      return;
    setNotice("This pairing request is no longer waiting for approval.");
    onPairingResolved?.(initialCode);
  }, [data, initialCode, onPairingResolved]);
  if (!owner && !loading && !error) return null;
  const action = async (
    path: string,
    input: unknown,
    onSuccess?: () => void,
  ) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await call(path, input);
      onSuccess?.();
      await refresh();
      setRevokeId(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Device action failed.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="profile-page__section">
      <div className="admin-card-heading">
        <h2>
          Approved devices{" "}
          <InfoTip label="How device access works">
            Each approved browser or client receives independent access.
            Household administrators can manage settings; viewers can use the
            player. Removing one device does not disconnect the others.
          </InfoTip>
        </h2>
        <AdminStatus>
          {data ? `${data.devices.length} connected` : "Loading…"}
        </AdminStatus>
      </div>
      <p>
        Devices need approval before they can use this home server. Each paired
        device receives its own revocable access to this household.
      </p>
      {!data && !error && <p role="status">Loading device access…</p>}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <section
          className="admin-subsection"
          aria-labelledby="pairing-requests-title"
        >
          <div className="admin-card-heading">
            <h3 id="pairing-requests-title">Pairing requests</h3>
            <AdminStatus tone={data.pending.length ? "warning" : "neutral"}>
              {data.pending.length
                ? `${data.pending.length} awaiting approval`
                : "None pending"}
            </AdminStatus>
          </div>
          {data.pending.length === 0 && (
            <p className="settings-note">
              New device requests appear here. Approve only a code you
              recognize.
            </p>
          )}
          {data.pending.map((item) => (
            <div
              className="deployment-card admin-pairing-request"
              key={item.id}
            >
              <div className="admin-device__identity">
                <AdminIcon name="devices" />
                <strong>{item.name}</strong>
              </div>
              <p className="settings-note">
                Compare the code with the requesting device before approving.
              </p>
              <label className="field">
                <span>Code shown on the requesting device</span>
                <input
                  value={
                    codes[item.id] ??
                    (item.code === initialCode ? initialCode : "")
                  }
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  disabled={pending}
                  onChange={(event) =>
                    setCodes({
                      ...codes,
                      [item.id]: event.target.value
                        .replace(/\D/g, "")
                        .slice(0, 6),
                    })
                  }
                />
              </label>
              <div className="deployment-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={
                    pending ||
                    (
                      codes[item.id] ??
                      (item.code === initialCode ? initialCode : "")
                    ).length !== 6
                  }
                  onClick={() =>
                    void action(
                      "decision",
                      {
                        requestId: item.id,
                        code:
                          codes[item.id] ??
                          (item.code === initialCode ? initialCode : ""),
                        approve: true,
                      },
                      () => {
                        if (item.code && item.code === initialCode)
                          onPairingResolved?.(item.code);
                      },
                    )
                  }
                >
                  Approve
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void action(
                      "decision",
                      {
                        requestId: item.id,
                        approve: false,
                      },
                      () => {
                        if (item.code && item.code === initialCode)
                          onPairingResolved?.(item.code);
                      },
                    )
                  }
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="admin-device-list">
        {data?.devices.map((device) => (
          <article className="admin-device" key={device.id}>
            <div className="admin-device__identity">
              <span className="admin-device__icon">
                <AdminIcon name="devices" />
              </span>
              <div>
                <strong>{device.name}</strong>
                <div className="admin-device__meta">
                  <AdminStatus>
                    {device.role === "owner" ? "Administrator" : "Viewer"}
                  </AdminStatus>
                  {device.current && (
                    <AdminStatus tone="success">This device</AdminStatus>
                  )}
                </div>
                {device.lastSeenAt && (
                  <p className="settings-note">
                    Last seen {new Date(device.lastSeenAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
            {!device.current &&
              (device.role !== "owner" ||
                (data?.devices.filter((item) => item.role === "owner").length ??
                  0) > 1) && (
                <button
                  className="button button--ghost admin-danger-button"
                  type="button"
                  disabled={pending}
                  onClick={() => setRevokeId(device.id)}
                >
                  <AdminIcon name="trash" />
                  Revoke access
                </button>
              )}
            {revokeId === device.id && (
              <div
                className="admin-confirmation"
                role="alertdialog"
                aria-label={`Revoke access for ${device.name}?`}
              >
                <p>
                  Remove <strong>{device.name}</strong> from this server? It
                  will need to pair again.
                </p>
                <div className="deployment-actions">
                  <button
                    className="button button--secondary admin-danger-button"
                    disabled={pending}
                    onClick={() =>
                      void action("revoke", { deviceId: device.id })
                    }
                  >
                    {pending ? "Removing…" : "Confirm removal"}
                  </button>
                  <button
                    className="button button--ghost"
                    disabled={pending}
                    onClick={() => setRevokeId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
