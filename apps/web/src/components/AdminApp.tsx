import { useEffect, useRef, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import {
  apiClient,
  safeErrorMessage,
  type AuthStatus,
  type StreamerApi,
} from "../api/client";
import { Brand } from "./Brand";
import { AccountLogin } from "./AccountLogin";
import { AccountSettings } from "./AccountSettings";
import { AccountSecurity } from "./AccountSecurity";
import { EncryptedRecovery } from "./EncryptedRecovery";
import { MasterPinSetup } from "./MasterPinSetup";
import { DigitSlotsInput } from "./DigitSlotsInput";
import {
  InstallationAccess,
  InstallationDevices,
  getInstallationStatus,
  beginHouseholdSetup,
  type InstallationStatus,
} from "./InstallationAccess";
import { IntegrationManager } from "./IntegrationManager";
import { AgentBackendSettings } from "./AgentBackendSettings";
import { SupportPanel } from "./SupportPanel";
import { useToasts } from "./ToastProvider";
import { HouseholdMerges } from "./HouseholdMerges";
import { InfoTip } from "./InfoTip";

type AdminSection =
  "household" | "profiles" | "devices" | "services" | "security" | "support";

export function AdminApp({ api = apiClient }: { api?: StreamerApi }) {
  const setupSession = useRef<Promise<unknown> | null>(null);
  const [installation, setInstallation] = useState<InstallationStatus | null>(
    null,
  );
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [profiles, setProfiles] = useState<ViewerProfile[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [section, setSection] = useState<AdminSection>(
    window.location.pathname.startsWith("/admin/pair")
      ? "devices"
      : new URLSearchParams(window.location.search).get("tab") === "profiles"
        ? "profiles"
        : window.location.hash === "#support"
          ? "support"
          : "household",
  );
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void (async () => {
      let status = await (api.getInstallationStatus?.() ??
        getInstallationStatus());
      if (
        status.enabled &&
        status.setupAvailable &&
        !status.setupAuthorized &&
        status.role !== "owner"
      ) {
        setupSession.current ??= (
          api.beginHouseholdSetup?.() ?? beginHouseholdSetup()
        ).finally(() => {
          setupSession.current = null;
        });
        await setupSession.current;
        status = await (api.getInstallationStatus?.() ??
          getInstallationStatus());
      }
      if (!active) return;
      setInstallation(status);
      if (status.enabled && status.role !== "owner" && !status.setupAuthorized)
        return;
      const account = await api.getAuthStatus?.();
      if (!active || !account) return;
      setAuth(account);
      if (
        account.authenticated &&
        account.householdReady !== false &&
        !account.householdRestoreRequired
      ) {
        const result = await api.getProfiles();
        if (active) setProfiles(result.items);
      }
    })()
      .catch((reason) => {
        if (active) setError(safeErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    window.addEventListener("streamer:household-changed", reload);
    return () => {
      active = false;
      window.removeEventListener("streamer:household-changed", reload);
    };
  }, [api, revision]);

  if (loading)
    return (
      <main className="startup-status">
        <Brand />
        <p role="status">Opening household administration…</p>
      </main>
    );
  if (error)
    return (
      <main className="installation-screen">
        <h1>Household administration</h1>
        <p role="alert">{error}</p>
        <button className="button button--primary" onClick={reload}>
          Try again
        </button>
      </main>
    );
  if (!installation) return null;
  const recovering = window.location.pathname.startsWith("/admin/recover");
  if (recovering && installation.cloudLinked === false)
    return (
      <main className="installation-screen">
        <h1>Master PIN recovery</h1>
        <p>
          This household has no connected cloud account. Its Master PIN can be
          changed only with the current PIN.
        </p>
        <a href="/admin">Back to administration</a>
      </main>
    );
  if (recovering && installation.cloudRecoveryAuthorized)
    return (
      <main className="installation-screen">
        <MasterPinSetup
          title="Reset your household Master PIN"
          description="Your cloud account has confirmed household ownership. Choose a new Master PIN for this server. Existing backup files keep their original PIN."
          onSave={async (pin) => {
            await api.resetMasterPin!(pin, pin);
            window.location.assign("/admin");
          }}
        />
      </main>
    );
  if (recovering && installation.claimed)
    return (
      <main className="admin-recovery">
        <AccountLogin
          api={api}
          compact
          adminLogin
          onAuthenticated={reload}
          onCancel={() => window.location.assign("/admin")}
        />
      </main>
    );
  if (
    installation.enabled &&
    installation.role !== "owner" &&
    !installation.setupAuthorized
  )
    return (
      <InstallationAccess
        api={api}
        status={installation}
        administration
        onConnected={reload}
      />
    );
  if (!auth)
    return (
      <main className="installation-screen">
        <p>Household status is unavailable.</p>
        <button onClick={reload}>Try again</button>
      </main>
    );
  if (auth.householdSelectionRequired)
    return <CloudHouseholdSelection api={api} onSelected={reload} />;
  const isNew =
    auth.householdReady === false &&
    !auth.householdSetupStarted &&
    !auth.householdRestoreRequired &&
    !auth.householdPinRequired;
  if (!auth.authenticated || isNew)
    return (
      <AccountLogin
        api={api}
        allowLocal
        allowCloud={auth.cloudConfigured}
        onAuthenticated={reload}
        onRestoreBackup={() => {
          setImporting(true);
          reload();
        }}
      />
    );
  if (importing || auth.householdRestoreRequired)
    return (
      <main className="installation-screen">
        <h1>
          {auth.householdRestoreRequired
            ? "Restore your cloud household"
            : "Import your household"}
        </h1>
        <p>
          Enter the Master PIN that protects your backup. All profiles are
          restored together.
        </p>
        <EncryptedRecovery
          restoreOnly
          autoLoadCloud={auth.householdRestoreRequired}
          onRestored={() => {
            setImporting(false);
            reload();
          }}
        />
        {!auth.householdRestoreRequired && (
          <button
            className="button button--ghost"
            onClick={() => setImporting(false)}
          >
            Create a new household instead
          </button>
        )}
      </main>
    );
  if (auth.masterPinSetupRequired && api.setupMasterPin)
    return (
      <main className="installation-screen">
        <MasterPinSetup
          onSave={async (pin) => {
            await api.setupMasterPin!(pin, pin);
            reload();
          }}
        />
      </main>
    );
  if (auth.householdPinRequired && api.verifyMasterPin)
    return (
      <LegacyHouseholdPin
        api={api}
        cloudLinked={auth.account?.cloudLinked === true}
        onVerified={reload}
      />
    );
  const first = profiles[0];
  const code = new URLSearchParams(window.location.search).get("code") ?? "";
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <Brand />
        <span>Household administration</span>
        <a href="/">Open player ↗</a>
      </header>
      <div className="admin-layout">
        <nav className="admin-nav" aria-label="Household administration">
          {(
            [
              "household",
              "profiles",
              "devices",
              "services",
              "security",
              "support",
            ] as AdminSection[]
          ).map((item) => (
            <button
              key={item}
              type="button"
              aria-current={section === item ? "page" : undefined}
              onClick={() => setSection(item)}
            >
              {item[0]!.toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <main className="admin-content">
          <h1>{section[0]!.toUpperCase() + section.slice(1)}</h1>
          {section === "household" && (
            <>
              <HouseholdName
                api={api}
                name={
                  installation.householdName ??
                  auth.account?.name ??
                  "Household"
                }
                onSaved={reload}
              />
              <AccountSettings api={api} />
              <HouseholdMerges api={api} onCompleted={reload} />
              <p className="settings-note">
                This server stores your household locally. Clients connect here
                and keep working when cloud services are unavailable.
              </p>
            </>
          )}
          {section === "profiles" && (
            <>
              <AdminPinResetRequests api={api} />
              <AdminProfiles api={api} profiles={profiles} onChanged={reload} />
            </>
          )}
          {section === "devices" && (
            <InstallationDevices
              initialCode={/^\d{6}$/.test(code) ? code : ""}
            />
          )}
          {section === "services" &&
            (first ? (
              <>
                <section className="profile-page__section">
                  <h2>Connected services</h2>
                  <IntegrationManager
                    api={api}
                    context="settings"
                    profileId={first.id}
                  />
                </section>
                <section className="profile-page__section">
                  <h2>AI agent</h2>
                  <AgentBackendSettings api={api} profileId={first.id} />
                </section>
              </>
            ) : (
              <p>Create a profile before connecting services.</p>
            ))}
          {section === "security" && (
            <>
              <AccountSecurity api={api} />
              <AdminBackupSchedule api={api} />
            </>
          )}
          {section === "support" && <SupportPanel />}
        </main>
      </div>
    </div>
  );
}

function HouseholdName({
  api,
  name,
  onSaved,
}: {
  api: StreamerApi;
  name: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  if (!api.renameHousehold) return null;
  return (
    <section className="profile-page__section">
      <h2>Household name</h2>
      <p>
        Use a name that distinguishes this server from your other households.
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending || !value.trim()) return;
          setPending(true);
          setError("");
          void api.renameHousehold!(value.trim())
            .then(() => {
              showToast("Household renamed.", "success");
              onSaved();
            })
            .catch((reason) => setError(safeErrorMessage(reason)))
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span>Household name</span>
          <input
            value={value}
            maxLength={80}
            required
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button
          className="button button--primary"
          disabled={pending || !value.trim() || value.trim() === name}
        >
          Save household name
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}

function CloudHouseholdSelection({
  api,
  onSelected,
}: {
  api: StreamerApi;
  onSelected: () => void;
}) {
  const [data, setData] = useState<Awaited<
    ReturnType<NonNullable<StreamerApi["getCloudHouseholds"]>>
  > | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api
      .getCloudHouseholds?.()
      .then(setData)
      .catch((reason) => setError(safeErrorMessage(reason)));
  }, [api]);
  const choose = (input: { householdId: string } | { create: true }) => {
    setPending(true);
    setError("");
    void api.selectCloudHousehold!(input)
      .then(onSelected)
      .catch((reason) => setError(safeErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  return (
    <main className="installation-screen">
      <h1>Choose your household</h1>
      <p>Select the household to restore on this server.</p>
      {!data && !error && <p role="status">Loading households…</p>}
      {data?.households.map((item) => (
        <button
          className="button button--secondary"
          key={item.id}
          disabled={pending}
          onClick={() => choose({ householdId: item.id })}
        >
          {item.name}
        </button>
      ))}
      {data?.canCreate && (
        <button
          className="button button--primary"
          disabled={pending}
          onClick={() => choose({ create: true })}
        >
          Create a new household
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

function LegacyHouseholdPin({
  api,
  onVerified,
  cloudLinked,
}: {
  api: StreamerApi;
  onVerified: () => void;
  cloudLinked: boolean;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <main className="installation-screen">
      <h1>Finish household setup</h1>
      <p>
        Enter this household's current Master PIN once to enable automatic
        encrypted backups.
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending || !/^\d{8}$/.test(pin)) return;
          setPending(true);
          void api.verifyMasterPin!(pin)
            .then(onVerified)
            .catch((reason) => setError(safeErrorMessage(reason)))
            .finally(() => setPending(false));
        }}
      >
        <DigitSlotsInput
          label="Current Master PIN"
          value={pin}
          onChange={setPin}
          disabled={pending}
        />
        <button
          className="button button--primary"
          disabled={pending || !/^\d{8}$/.test(pin)}
        >
          Continue
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      {cloudLinked && (
        <p>
          <a href="/admin/recover">Forgot PIN?</a>{" "}
          <InfoTip label="How to recover your Master PIN">
            Confirm ownership with your connected cloud account to reset the
            Master PIN on this server. Existing backup files keep their original
            PIN.
          </InfoTip>
        </p>
      )}
    </main>
  );
}

function AdminProfiles({
  api,
  profiles,
  onChanged,
}: {
  api: StreamerApi;
  profiles: ViewerProfile[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{
    id: string;
    action: "reset" | "delete";
  } | null>(null);
  const { showToast } = useToasts();
  const run = async (action: () => Promise<unknown>, message: string) => {
    setPending(true);
    setError("");
    try {
      await action();
      setConfirm(null);
      setName("");
      showToast(message, "success");
      onChanged();
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="profile-page__section">
      <h2>Household profiles</h2>
      <p>Every profile and its viewing data belongs to this household.</p>
      {profiles.map((profile) => (
        <article className="admin-profile" key={profile.id}>
          <div>
            <strong>{profile.name}</strong>
            <p className="settings-note">
              {profile.pinEnabled ? "Profile PIN enabled" : "No profile PIN"}
            </p>
          </div>
          <div className="deployment-actions">
            {profile.pinEnabled && api.resetProfilePin && (
              <button
                className="button button--secondary"
                disabled={pending}
                onClick={() => setConfirm({ id: profile.id, action: "reset" })}
              >
                Reset profile PIN
              </button>
            )}
            <button
              className="button button--ghost"
              disabled={pending}
              onClick={() => setConfirm({ id: profile.id, action: "delete" })}
            >
              Delete profile
            </button>
          </div>
          {confirm?.id === profile.id && (
            <div
              className="deployment-card"
              role="alertdialog"
              aria-label={
                confirm.action === "reset"
                  ? "Reset profile PIN?"
                  : "Delete profile?"
              }
            >
              <p>
                {confirm.action === "reset"
                  ? `Remove the PIN for ${profile.name}? Their viewing data will be kept.`
                  : `Delete ${profile.name} and this profile's viewing data?`}
              </p>
              <div className="deployment-actions">
                <button
                  className="button button--primary"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () =>
                        confirm.action === "reset"
                          ? api.resetProfilePin!(profile.id)
                          : api.deleteProfile(profile.id),
                      confirm.action === "reset"
                        ? "Profile PIN reset."
                        : "Profile deleted.",
                    )
                  }
                >
                  Confirm
                </button>
                <button
                  className="button button--ghost"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || pending) return;
          void run(
            () => api.createProfile({ name: name.trim(), locale: "en" }),
            "Profile created. Open the player to set its viewing preferences.",
          );
        }}
      >
        <label className="field">
          <span>New profile name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
          />
        </label>
        <button
          className="button button--primary"
          disabled={pending || !name.trim() || profiles.length >= 5}
        >
          Add profile
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function AdminBackupSchedule({ api }: { api: StreamerApi }) {
  const [schedule, setSchedule] = useState({
    enabled: true,
    intervalMinutes: 1440,
    cloudEnabled: true,
  });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  useEffect(() => {
    if (!api.getBackupSchedule) return;
    void api
      .getBackupSchedule()
      .then((value) => {
        setSchedule(value);
        setReady(true);
      })
      .catch((reason) => setError(safeErrorMessage(reason)));
  }, [api]);
  if (!api.getBackupSchedule) return null;
  return (
    <section className="profile-page__section">
      <h2>Automatic backup schedule</h2>
      <p>
        Encrypted local backups run on this server. Cloud copies are sent when
        the household has a connected online account.
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !ready ||
            pending ||
            schedule.intervalMinutes < 15 ||
            schedule.intervalMinutes > 10080
          )
            return;
          setPending(true);
          setError("");
          void api.saveBackupSchedule!(schedule)
            .then((value) => {
              setSchedule(value);
              showToast("Backup schedule saved.", "success");
            })
            .catch((reason) => setError(safeErrorMessage(reason)))
            .finally(() => setPending(false));
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={schedule.enabled}
            disabled={!ready || pending}
            onChange={(event) =>
              setSchedule({ ...schedule, enabled: event.target.checked })
            }
          />{" "}
          Create automatic local backups
        </label>
        <label className="field">
          <span>Backup interval (minutes)</span>
          <input
            type="number"
            min={15}
            max={10080}
            value={schedule.intervalMinutes}
            disabled={!ready || pending}
            onChange={(event) =>
              setSchedule({
                ...schedule,
                intervalMinutes: Number(event.target.value),
              })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={schedule.cloudEnabled}
            disabled={!ready || pending}
            onChange={(event) =>
              setSchedule({ ...schedule, cloudEnabled: event.target.checked })
            }
          />{" "}
          Keep an automatic cloud copy when connected
        </label>
        <button
          className="button button--primary"
          disabled={
            !ready ||
            pending ||
            schedule.intervalMinutes < 15 ||
            schedule.intervalMinutes > 10080
          }
        >
          Save backup schedule
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function AdminPinResetRequests({ api }: { api: StreamerApi }) {
  const [requests, setRequests] = useState<
    Awaited<
      ReturnType<NonNullable<StreamerApi["getProfilePinResetRequests"]>>
    >["requests"]
  >([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!api.getProfilePinResetRequests) return;
    let active = true;
    const refresh = () =>
      void api.getProfilePinResetRequests!()
        .then((value) => {
          if (active) setRequests(value.requests);
        })
        .catch((reason) => {
          if (active) setError(safeErrorMessage(reason));
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  if (!requests.length && !error) return null;
  const decide = async (id: string, approve: boolean) => {
    setPending(true);
    setError("");
    try {
      await api.decideProfilePinReset!(id, approve);
      setRequests((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="profile-page__section">
      <h2>Profile PIN reset requests</h2>
      <p>Approve only a reset requested by someone in your household.</p>
      {requests.map((item) => (
        <div className="deployment-card" key={item.id}>
          <strong>{item.profileName}</strong>
          <p>Requested from {item.deviceName}</p>
          <div className="deployment-actions">
            <button
              className="button button--primary"
              disabled={pending}
              onClick={() => void decide(item.id, true)}
            >
              Approve PIN reset
            </button>
            <button
              className="button button--secondary"
              disabled={pending}
              onClick={() => void decide(item.id, false)}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
