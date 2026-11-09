import { useEffect, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type {
  AccountConnections,
  AccountOverview,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { AccountId } from "./AccountId";
import { useToasts } from "./ToastProvider";

export function AccountSettings({
  api,
  section = "all",
}: {
  api: StreamerApi;
  profile?: ViewerProfile;
  section?: "account" | "cloud" | "all";
}) {
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [linking, setLinking] = useState(false);
  const [connections, setConnections] = useState<AccountConnections | null>(
    null,
  );
  const [connectionsError, setConnectionsError] = useState("");
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsRetry, setConnectionsRetry] = useState(0);
  useEffect(() => {
    if (
      section === "account" ||
      !overview?.manageUrl ||
      !api.getAccountConnections
    )
      return;
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
  }, [
    api,
    overview?.account.id,
    overview?.manageUrl,
    connectionsRetry,
    section,
  ]);
  useEffect(() => {
    if (!api.getAccount) return;
    let active = true;
    const refresh = () =>
      void api.getAccount!()
        .then((result) => {
          if (active) {
            setOverview(result);
            setError("");
          }
        })
        .catch((reason: unknown) => {
          if (active) setError(safeErrorMessage(reason));
        });
    refresh();
    window.addEventListener("streamer:household-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("streamer:household-changed", refresh);
    };
  }, [api, retry]);
  const run = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError("");
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
      {section !== "cloud" && (
        <section className="profile-page__section">
          <p className="eyebrow">Account</p>
          <h2>{overview?.account.name || "Your StreamerAI account"}</h2>
          {overview ? (
            <>
              <p>{overview.account.email}</p>
              <AccountId
                value={
                  overview.account.cloudLinked
                    ? (overview.account.cloudAccountId ?? null)
                    : overview.account.id
                }
              />
              <p>
                Connected services are shared by this household's profiles.
                Viewing history and preferences stay with each profile.
              </p>
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
        </section>
      )}
      {section === "cloud" && !overview && (
        <section className="profile-page__section">
          {error ? (
            <p role="alert">
              {error}{" "}
              <button
                className="text-button"
                type="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Try again
              </button>
            </p>
          ) : (
            <p role="status">Loading cloud settings…</p>
          )}
        </section>
      )}
      {section !== "account" && overview && (
        <section className="profile-page__section">
          <h2>Cloud management</h2>
          {section === "cloud" && error && <p role="alert">{error}</p>}
          <h3>Cloud connection</h3>
          <p>
            Your household, profiles and Master PIN stay on this server. Cloud
            services add remote management, synchronization and automatic
            backups.
          </p>
          {overview.account.cloudLinked ? (
            <>
              <p>Cloud services are connected.</p>
              {api.disconnectCloud && (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await api.disconnectCloud!();
                      setOverview(await api.getAccount!());
                      showToast(
                        "Cloud disconnected. Your household and profiles are still available on this server.",
                        "success",
                      );
                      window.dispatchEvent(
                        new Event("streamer:household-changed"),
                      );
                    })
                  }
                >
                  Disconnect cloud
                </button>
              )}
            </>
          ) : !linking &&
            overview.cloudConfigured !== false &&
            api.startDeviceAuthorization ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setLinking(true)}
            >
              Connect cloud
            </button>
          ) : null}
          {linking && (
            <AccountLogin
              api={api}
              compact
              adoptLocalAccount
              onCancel={() => setLinking(false)}
              onAuthenticated={() => {
                setLinking(false);
                window.dispatchEvent(new Event("streamer:household-changed"));
              }}
            />
          )}
          <h3>Connected accounts</h3>
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
              This household is local. Connect it to StreamerAI to add online
              sign-in methods.
            </p>
          )}
          {overview.manageUrl && (
            <>
              <h3>Manage your households</h3>
              <p>
                Manage household ownership, profile transfers between households
                and merge requests in the cloud account portal. The receiving
                owner confirms each transfer. Local service credentials stay on
                this server.
              </p>
              <a
                className="button button--secondary"
                href={overview.manageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open account portal
              </a>
            </>
          )}
        </section>
      )}
    </>
  );
}
