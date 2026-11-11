import { useEffect, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type { AccountOverview, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { AccountId } from "./AccountId";
import { useToasts } from "./ToastProvider";
import { AdminIcon, AdminNote, AdminStatus } from "./AdminUI";
import { AdminHelp as InfoTip } from "./AdminUI";

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
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("streamer:household-changed", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
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
          <p className="eyebrow">Household identity</p>
          <h2>{overview?.account.name || "Your StreamerAI account"}</h2>
          {overview ? (
            <>
              <div className="admin-identity">
                <AdminStatus tone="success">Stored on this server</AdminStatus>
                {overview.account.email && (
                  <span>{overview.account.email}</span>
                )}
              </div>
              <AccountId
                label="Household ID"
                value={overview.householdId ?? null}
              />
              <AccountId
                value={
                  overview.account.cloudLinked
                    ? (overview.account.cloudAccountId ?? null)
                    : overview.account.id
                }
              />
              <div className="admin-facts">
                <div>
                  <AdminIcon name="services" />
                  <div>
                    <strong>Shared services</strong>
                    <p>
                      Connections are available to every profile in this
                      household.
                    </p>
                  </div>
                </div>
                <div>
                  <AdminIcon name="profiles" />
                  <div>
                    <strong>Personal viewing spaces</strong>
                    <p>
                      History, preferences and progress stay with each profile.
                    </p>
                  </div>
                </div>
              </div>
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
          <section
            className="admin-subsection"
            aria-labelledby="cloud-connection-title"
          >
            <div className="admin-card-heading">
              <h3 id="cloud-connection-title">
                <AdminIcon name="cloud" />
                Cloud connection{" "}
                <InfoTip label="What connecting to cloud changes">
                  Cloud management connects this existing household to your
                  online account. It does not create a new local household or
                  replace its Master PIN.
                </InfoTip>
              </h3>
              <AdminStatus
                tone={overview.account.cloudLinked ? "success" : "neutral"}
              >
                {overview.account.cloudLinked
                  ? "Connected"
                  : overview.cloudConfigured === false
                    ? "Unavailable"
                    : "Local only"}
              </AdminStatus>
            </div>
            <p>
              Your household, profiles and Master PIN stay on this server. Cloud
              services add remote management, synchronization and automatic
              backups.
            </p>
            {overview.account.cloudLinked ? (
              <>
                <p className="admin-connection-detail">
                  Cloud services are connected.
                  {overview.account.email && (
                    <>
                      {" "}
                      Signed in as <strong>{overview.account.email}</strong>.
                    </>
                  )}
                </p>
                {api.disconnectCloud && (
                  <div className="deployment-actions">
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
                    <span className="settings-note">
                      Your local household and paired devices stay available.
                    </span>
                  </div>
                )}
              </>
            ) : !linking &&
              overview.cloudConfigured !== false &&
              api.startDeviceAuthorization ? (
              <div className="deployment-actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setLinking(true)}
                >
                  <AdminIcon name="cloud" />
                  Connect cloud
                </button>
              </div>
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
            {overview.cloudConfigured === false &&
              !overview.account.cloudLinked && (
                <AdminNote>
                  Cloud services are not configured on this server. Your local
                  household remains available.
                </AdminNote>
              )}
          </section>
          {overview.account.cloudLinked && overview.sync?.configured && (
            <section
              className="admin-subsection"
              aria-labelledby="cloud-sync-title"
            >
              <div className="admin-card-heading">
                <h3 id="cloud-sync-title">
                  <AdminIcon name="backups" />
                  Profile synchronization{" "}
                  <InfoTip label="Synchronization and backups">
                    Synchronization keeps profiles and viewing changes in step.
                    Encrypted household backups are separate and can be managed
                    in Backups.
                  </InfoTip>
                </h3>
                <AdminStatus
                  tone={
                    overview.sync.error || overview.sync.status === "error"
                      ? "danger"
                      : overview.sync.status === "idle" &&
                          overview.sync.lastSyncedAt
                        ? "success"
                        : "warning"
                  }
                >
                  {overview.sync.error || overview.sync.status === "error"
                    ? "Needs attention"
                    : overview.sync.status === "idle"
                      ? overview.sync.lastSyncedAt
                        ? "Up to date"
                        : "Ready to sync"
                      : overview.sync.status === "syncing"
                        ? "Syncing"
                        : overview.sync.status === "pending"
                          ? "Changes queued"
                          : "Paused"}
                </AdminStatus>
              </div>
              <p>
                Profiles, library and viewing progress synchronize with this
                household's cloud copy.
              </p>
              <p className="settings-note">
                {overview.sync.lastSyncedAt
                  ? `Last synchronized ${new Date(overview.sync.lastSyncedAt).toLocaleString()}.`
                  : "Waiting for the first successful synchronization."}
              </p>
              {overview.sync.error && (
                <AdminNote tone="warning">
                  Synchronization needs attention. Your local viewing data
                  remains on this server.
                </AdminNote>
              )}
            </section>
          )}
          {overview.manageUrl && (
            <section
              className="admin-subsection"
              aria-labelledby="cloud-portal-title"
            >
              <h3 id="cloud-portal-title">
                <AdminIcon name="household" />
                Manage your households{" "}
                <InfoTip label="What is managed in the account portal?">
                  The account portal manages cloud ownership, sign-in methods
                  and transfers. Profiles, devices and service connections on
                  this server are managed here.
                </InfoTip>
              </h3>
              <p>
                Manage household ownership, profile transfers between households
                and merge requests in the cloud account portal. The receiving
                owner confirms each transfer. Local service credentials stay on
                this server.
              </p>
              <div className="deployment-actions">
                <a
                  className="button button--secondary"
                  href={overview.manageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open account portal <AdminIcon name="arrow" />
                </a>
                <span className="settings-note">Opens in a new tab</span>
              </div>
            </section>
          )}
        </section>
      )}
    </>
  );
}
