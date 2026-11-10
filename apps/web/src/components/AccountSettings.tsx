import { useEffect, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type { AccountOverview, StreamerApi } from "../api/client";
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
