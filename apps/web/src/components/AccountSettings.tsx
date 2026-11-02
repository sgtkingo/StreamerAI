import { useEffect, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type {
  AccountConnections,
  AccountOverview,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
import { AccountLogin } from "./AccountLogin";

export function AccountSettings({
  api,
  profile,
  onSwitchProfile,
  onSignOut,
}: {
  api: StreamerApi;
  profile: ViewerProfile;
  onSwitchProfile: () => void;
  onSignOut?: () => Promise<void>;
}) {
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [localProfiles, setLocalProfiles] = useState<ViewerProfile[] | null>(
    null,
  );
  const [adoptConfirmed, setAdoptConfirmed] = useState(false);
  const [linking, setLinking] = useState(false);
  const [connections, setConnections] = useState<AccountConnections | null>(
    null,
  );
  const [connectionsError, setConnectionsError] = useState("");
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsRetry, setConnectionsRetry] = useState(0);
  useEffect(() => {
    if (!overview?.manageUrl || !api.getAccountConnections) return;
    let active = true;
    const refresh = async () => {
      setConnectionsLoading(true);
      try {
        const result = await api.getAccountConnections!();
        if (active) {
          if (result.accountId !== overview.account.id)
            throw new Error(
              "The connected accounts response does not match this account.",
            );
          setConnections(result);
          setConnectionsError("");
        }
      } catch {
        if (active)
          setConnectionsError(
            "Connected accounts cannot be checked right now. Try again or open the account portal.",
          );
      } finally {
        if (active) setConnectionsLoading(false);
      }
    };
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [api, overview?.account.id, overview?.manageUrl, connectionsRetry]);
  useEffect(() => {
    if (!api.getAccount) return;
    let active = true;
    void api
      .getAccount()
      .then((result) => {
        if (active) {
          setOverview(result);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(safeErrorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [api, retry]);
  const run = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <section className="profile-page__section">
        <p className="eyebrow">Account</p>
        <h2>{overview?.account.name || "Your StreamerAI account"}</h2>
        {overview ? (
          <>
            <p>{overview.account.email}</p>
            <p className="settings-note">
              Account ID{" "}
              <code className="account-id">{overview.account.id}</code>
            </p>
            <p>
              Connected services are shared by this account's profiles. Viewing
              history and preferences stay with each profile.
            </p>
            {overview.sync && (
              <>
                <h3>Cloud synchronization</h3>
                <p>
                  {overview.sync.configured
                    ? `Status: ${overview.sync.status}`
                    : "Synchronization is off. Your home server keeps your data locally."}
                </p>
                {overview.account.cloudLinked && api.setAccountSync && (
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        const sync = await api.setAccountSync!(
                          !overview.sync!.configured,
                        );
                        setOverview((current) =>
                          current ? { ...current, sync } : current,
                        );
                        setNotice(
                          sync.configured
                            ? "Cloud synchronization enabled. Your queued changes will be synchronized."
                            : "Synchronization disabled. Local data, pending changes and the online copy are preserved.",
                        );
                      })
                    }
                  >
                    {overview.sync.configured
                      ? "Disable synchronization"
                      : "Enable synchronization"}
                  </button>
                )}
                {overview.sync.lastSyncedAt && (
                  <p className="settings-note">
                    Last synchronized{" "}
                    {new Date(overview.sync.lastSyncedAt).toLocaleString()}
                  </p>
                )}
                {overview.sync.configured && api.syncAccount && (
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        const sync = await api.syncAccount!();
                        setOverview((current) =>
                          current ? { ...current, sync } : current,
                        );
                        if (sync?.status === "error")
                          setError(
                            "Cloud synchronization is temporarily unavailable. Your changes are saved on the home server.",
                          );
                        else
                          setNotice(
                            sync?.status === "pending"
                              ? "Your changes are queued for synchronization."
                              : "Synchronization completed.",
                          );
                      })
                    }
                  >
                    Sync now
                  </button>
                )}
              </>
            )}
          </>
        ) : (
          !error && <p role="status">Loading account…</p>
        )}
        {error && (
          <p className="account-inline-error" role="alert">
            {error}{" "}
            <button
              className="text-button"
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="profile-page__actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={onSwitchProfile}
          >
            Choose another profile
          </button>
          {onSignOut && (
            <button
              className="button button--ghost"
              type="button"
              disabled={pending}
              onClick={() => void run(onSignOut)}
            >
              Sign out of account
            </button>
          )}
        </div>
      </section>
      {overview && (
        <section className="profile-page__section">
          <h2>Connected accounts</h2>
          <p>
            Use StreamerAI e-mail or a linked Google account to sign in to the
            same account. Your profiles stay together.
          </p>
          {overview.manageUrl ? (
            <>
              {connectionsLoading && (
                <p role="status">Checking connected accounts…</p>
              )}
              {connectionsError && <p role="alert">{connectionsError}</p>}
              {connections && (
                <ul className="account-device-list">
                  {connections.connections.map((item) => (
                    <li key={item.provider}>
                      <div>
                        <strong>{item.name}</strong>
                        <p className="settings-note">
                          {item.connected
                            ? "Connected"
                            : item.available
                              ? "Not connected"
                              : "Coming later"}
                        </p>
                      </div>
                      {!item.connected && item.available && (
                        <a
                          className="button button--secondary"
                          href={overview.manageUrl + "#connections"}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {item.provider === "email"
                            ? "Enable e-mail login"
                            : `Connect ${item.name}`}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                Connect sign-in methods in the account portal. It may ask you to
                sign in again to confirm ownership.
              </p>
              <a
                className="button button--secondary"
                href={overview.manageUrl + "#connections"}
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage connected accounts
              </a>
              {api.getAccountConnections && (
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={connectionsLoading}
                  onClick={() => setConnectionsRetry((value) => value + 1)}
                >
                  Refresh connected accounts
                </button>
              )}
            </>
          ) : (
            <p>
              This household is local. Connect it to StreamerAI below to add
              online sign-in methods.
            </p>
          )}
        </section>
      )}
      {overview?.account.cloudLinked === false &&
        api.startDeviceAuthorization && (
          <section className="profile-page__section">
            <h2>Connect this household to StreamerAI</h2>
            <p>
              Choose an online owner for this household. Its profiles, library
              and shared service connections stay together. Other local sessions
              will be signed out.
            </p>
            {!localProfiles && (
              <button
                className="button button--secondary"
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    setLocalProfiles((await api.getProfiles()).items);
                  })
                }
              >
                Review local profiles
              </button>
            )}
            {localProfiles && !linking && (
              <>
                <p>
                  Profiles to connect:{" "}
                  {localProfiles.map((item) => item.name).join(", ") || "None"}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={adoptConfirmed}
                    onChange={(event) =>
                      setAdoptConfirmed(event.target.checked)
                    }
                  />{" "}
                  I want the online account I select to own these local profiles
                  and shared connections.
                </label>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={!adoptConfirmed}
                  onClick={() => setLinking(true)}
                >
                  Choose online owner
                </button>
              </>
            )}
            {linking && (
              <AccountLogin
                api={api}
                compact
                adoptLocalAccount
                onCancel={() => setLinking(false)}
                onAuthenticated={() => window.location.reload()}
              />
            )}
          </section>
        )}
      {overview && overview.devices.length > 0 && (
        <section className="profile-page__section">
          <p className="eyebrow">Devices</p>
          <h2>Connected devices</h2>
          <ul className="account-device-list">
            {overview.devices.map((device) => (
              <li key={device.id}>
                <div>
                  <strong>
                    {device.name}
                    {device.current ? " (this device)" : ""}
                  </strong>
                  <p className="settings-note">
                    Last active {new Date(device.lastSeenAt).toLocaleString()}
                  </p>
                </div>
                {api.revokeAccountDevice && (
                  <button
                    className="button button--ghost"
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        await api.revokeAccountDevice!(device.id);
                        if (device.current && onSignOut) {
                          await onSignOut();
                          return;
                        }
                        setOverview((current) =>
                          current
                            ? {
                                ...current,
                                devices: current.devices.filter(
                                  (item) => item.id !== device.id,
                                ),
                              }
                            : current,
                        );
                        setNotice("Device disconnected.");
                      })
                    }
                  >
                    Disconnect{device.current ? " this device" : ""}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {overview?.manageUrl && (
        <section className="profile-page__section">
          <p className="eyebrow">Profile ownership</p>
          <h2>Move {profile.name} to another account</h2>
          <p>
            The receiving account must confirm the transfer and have a free
            profile slot. Your library, history and preferences move with this
            profile. Connected services stay with this account and the receiving
            account will set a new PIN.
          </p>
          <p>
            Sign in to your StreamerAI account in the portal to start or accept
            a profile transfer and manage your devices.
          </p>
          <a
            className="button button--secondary"
            href={overview.manageUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open account portal
          </a>
        </section>
      )}
    </>
  );
}
