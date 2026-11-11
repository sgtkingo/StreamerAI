import { useCallback, useEffect, useRef, useState } from "react";
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
import { AdminHelp as InfoTip } from "./AdminUI";
import { SupportFaq } from "./SupportFaq";
import { AdminIcon, AdminNote, AdminStatus } from "./AdminUI";

type AdminSection =
  | "household"
  | "cloud"
  | "profiles"
  | "devices"
  | "services"
  | "backups"
  | "security"
  | "support";

const sectionCopy: Record<AdminSection, string> = {
  household: "The home for your profiles, preferences and shared services.",
  cloud:
    "Connect your household, check synchronization and manage your online account.",
  profiles: "Manage personal spaces, profile access and viewing data.",
  devices: "Approve new connections and manage who can use this home server.",
  services: "",
  backups:
    "Keep an encrypted copy of your household and choose when it is saved.",
  security:
    "Protect administration, profile access and your household backups.",
  support: "Find an answer, collect diagnostics or report a problem.",
};
const navGroups: { label: string; items: AdminSection[] }[] = [
  {
    label: "Your household",
    items: ["household", "cloud", "profiles", "devices"],
  },
  { label: "Configuration", items: ["services", "backups", "security"] },
  { label: "Help", items: ["support"] },
];

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
  const [pairingCode, setPairingCode] = useState(
    () => new URLSearchParams(window.location.search).get("code") ?? "",
  );
  const [section, setSection] = useState<AdminSection>(
    window.location.pathname.startsWith("/admin/pair")
      ? "devices"
      : Object.hasOwn(
            sectionCopy,
            new URLSearchParams(window.location.search).get("tab") ?? "",
          )
        ? (new URLSearchParams(window.location.search).get(
            "tab",
          ) as AdminSection)
        : window.location.hash === "#support"
          ? "support"
          : "household",
  );
  const selectSection = (next: AdminSection) => {
    setSection(next);
    const url = new URL(window.location.href);
    if (/^\/admin\/pair\/?$/.test(url.pathname)) {
      url.pathname = "/admin";
      url.searchParams.delete("code");
      setPairingCode("");
    }
    url.searchParams.set("tab", next);
    url.hash = "";
    window.history.replaceState({}, "", url);
  };
  const clearPairingLink = useCallback((code: string) => {
    const url = new URL(window.location.href);
    if (
      !/^\/admin\/pair\/?$/.test(url.pathname) ||
      url.searchParams.get("code") !== code
    )
      return;
    url.pathname = "/admin";
    url.searchParams.delete("code");
    url.searchParams.set("tab", "devices");
    window.history.replaceState(window.history.state, "", url);
    setPairingCode("");
  }, []);
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
    window.addEventListener("streamer:auth-required", reload);
    return () => {
      active = false;
      window.removeEventListener("streamer:household-changed", reload);
      window.removeEventListener("streamer:auth-required", reload);
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
      <main className="installation-screen admin-state">
        <h1>Your household, fully under your control</h1>
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
      <main className="installation-screen admin-state">
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
      <main className="installation-screen admin-state">
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
      <main className="installation-screen admin-state">
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
      <main className="installation-screen admin-state">
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
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <Brand />
        <span className="admin-header__context">
          <span>Household administration</span>
          <strong>
            {installation.householdName ??
              auth.account?.name ??
              "Your household"}
          </strong>
        </span>
        <button
          className="admin-header__report"
          type="button"
          onClick={() => {
            selectSection("support");
            requestAnimationFrame(() =>
              document
                .getElementById("settings-support")
                ?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
            );
          }}
        >
          <svg
            aria-hidden="true"
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 8V6a4 4 0 0 1 8 0v2M12 8v13M5 11H3m18 0h-2M5 16H3m18 0h-2M6 7 4 5m14 2 2-2" />
            <rect x="5" y="8" width="14" height="13" rx="6" />
          </svg>
          Report a bug
        </button>
        <a className="admin-header__player" href="/">
          Open player <AdminIcon name="arrow" />
        </a>
      </header>
      <div className="admin-layout">
        <nav className="admin-nav" aria-label="Household administration">
          {navGroups.map((group) => (
            <div className="admin-nav__group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-current={section === item ? "page" : undefined}
                  onClick={() => selectSection(item)}
                >
                  <AdminIcon name={item} />
                  <span>{item[0]!.toUpperCase() + item.slice(1)}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="admin-nav__footer">
            <AdminStatus
              tone={installation.householdReady ? "success" : "warning"}
            >
              {installation.householdReady
                ? "Household ready"
                : "Setup pending"}
            </AdminStatus>
            <span>Managed on this server</span>
          </div>
        </nav>
        <main className="admin-content" data-admin-section={section}>
          <div className="admin-page-heading">
            <p className="eyebrow">
              Administration <span aria-hidden="true">/</span> {section}
            </p>
            <h1>{section[0]!.toUpperCase() + section.slice(1)}</h1>
            {sectionCopy[section] && <p>{sectionCopy[section]}</p>}
          </div>
          {section === "household" && (
            <>
              <div className="admin-overview" aria-label="Household overview">
                <div>
                  <AdminIcon name="profiles" />
                  <span>
                    Profiles
                    <strong>
                      {profiles.length}
                      <small> / 5</small>
                    </strong>
                  </span>
                </div>
                <div>
                  <AdminIcon name="security" />
                  <span>
                    Master PIN
                    <strong>
                      {installation.masterPinEnabled
                        ? "Enabled"
                        : "Not configured"}
                    </strong>
                  </span>
                </div>
                <div>
                  <AdminIcon name="cloud" />
                  <span>
                    Cloud management
                    <strong>
                      {auth.account?.cloudLinked ? "Connected" : "Local only"}
                    </strong>
                  </span>
                </div>
              </div>
              <HouseholdName
                api={api}
                name={
                  installation.householdName ??
                  auth.account?.name ??
                  "Household"
                }
                onSaved={reload}
              />
              <AccountSettings api={api} section="account" />
              <HouseholdMerges api={api} onCompleted={reload} />
              <AdminNote>
                <strong>Your household lives here.</strong> Profiles, settings
                and services stay on this server. Paired clients can keep using
                it when the cloud is unavailable.
              </AdminNote>
            </>
          )}
          {section === "cloud" && <AccountSettings api={api} section="cloud" />}
          {section === "profiles" && (
            <>
              <AdminPinResetRequests api={api} />
              <AdminProfiles api={api} profiles={profiles} onChanged={reload} />
            </>
          )}
          {section === "devices" && (
            <InstallationDevices
              initialCode={/^\d{6}$/.test(pairingCode) ? pairingCode : ""}
              onPairingResolved={clearPairingLink}
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
            <AccountSecurity
              api={api}
              masterPinEnabled={installation.masterPinEnabled}
            />
          )}
          {section === "backups" && (
            <>
              <div className="profile-page__section">
                <EncryptedRecovery />
              </div>
              <AdminBackupSchedule api={api} />
            </>
          )}
          {section === "support" && (
            <>
              <SupportFaq />
              <SupportPanel />
            </>
          )}
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
        <div className="deployment-actions">
          <button
            className="button button--primary"
            disabled={pending || !value.trim() || value.trim() === name}
          >
            <AdminIcon name="check" />
            {pending ? "Saving name…" : "Save household name"}
          </button>
          <span className="settings-note">
            Visible to your household and connected cloud account.
          </span>
        </div>
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
    <main className="installation-screen admin-state admin-household-selection">
      <h1>Choose your household</h1>
      <p>Select the household to restore on this server.</p>
      {!data && !error && <p role="status">Loading households…</p>}
      <div className="admin-household-options">
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
      </div>
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
    <main className="installation-screen admin-state">
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
      <div className="admin-card-heading">
        <h2>Household profiles</h2>
        <AdminStatus>{profiles.length} of 5 profiles</AdminStatus>
      </div>
      <p>Every profile and its viewing data belongs to this household.</p>
      {profiles.map((profile) => (
        <article className="admin-profile" key={profile.id}>
          <div className="admin-profile__identity">
            <span className="admin-avatar" aria-hidden="true">
              {profile.name.trim().slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{profile.name}</strong>
              <div className="admin-profile__meta">
                <AdminStatus tone={profile.pinEnabled ? "success" : "neutral"}>
                  {profile.pinEnabled
                    ? "Profile PIN enabled"
                    : "No profile PIN"}
                </AdminStatus>
                <InfoTip label={`Profile access for ${profile.name}`}>
                  A profile PIN protects this person's viewing space. The
                  household Master PIN can also unlock it.
                </InfoTip>
              </div>
            </div>
          </div>
          <div className="deployment-actions">
            {profile.pinEnabled && api.resetProfilePin && (
              <button
                className="button button--secondary"
                disabled={pending}
                onClick={() => setConfirm({ id: profile.id, action: "reset" })}
              >
                <AdminIcon name="lock" />
                Reset profile PIN
              </button>
            )}
            <button
              className="button button--ghost admin-danger-button"
              disabled={pending}
              onClick={() => setConfirm({ id: profile.id, action: "delete" })}
            >
              <AdminIcon name="trash" />
              Delete profile
            </button>
          </div>
          {confirm?.id === profile.id && (
            <div
              className="deployment-card admin-confirmation"
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
                  className={`button button--primary${confirm.action === "delete" ? " admin-danger-button" : ""}`}
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
                  {pending ? "Working…" : "Confirm"}
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
  const [saved, setSaved] = useState<typeof schedule | null>(null);
  const dirty =
    saved !== null &&
    (saved.enabled !== schedule.enabled ||
      saved.cloudEnabled !== schedule.cloudEnabled ||
      saved.intervalMinutes !== schedule.intervalMinutes);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  useEffect(() => {
    if (!api.getBackupSchedule) return;
    void api
      .getBackupSchedule()
      .then((value) => {
        setSchedule(value);
        setSaved(value);
        setReady(true);
      })
      .catch((reason) => setError(safeErrorMessage(reason)));
  }, [api]);
  if (!api.getBackupSchedule) return null;
  return (
    <section className="profile-page__section">
      <div className="admin-card-heading">
        <h2>
          Automatic backup schedule{" "}
          <InfoTip label="About automatic backups">
            Local and cloud copies use your household's Master PIN. The interval
            applies to automatic saves; you can also download a copy at any
            time.
          </InfoTip>
        </h2>
        <AdminStatus
          tone={!ready ? "neutral" : saved?.enabled ? "success" : "warning"}
        >
          {!ready
            ? "Loading…"
            : saved?.enabled
              ? "Scheduled"
              : "Local backups paused"}
        </AdminStatus>
      </div>
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
            !dirty ||
            schedule.intervalMinutes < 15 ||
            schedule.intervalMinutes > 10080
          )
            return;
          setPending(true);
          setError("");
          void api.saveBackupSchedule!(schedule)
            .then((value) => {
              setSchedule(value);
              setSaved(value);
              showToast("Backup schedule saved.", "success");
            })
            .catch((reason) => setError(safeErrorMessage(reason)))
            .finally(() => setPending(false));
        }}
      >
        <fieldset className="admin-subsection">
          <legend>On this server</legend>
          <label className="admin-toggle">
            <input
              type="checkbox"
              checked={schedule.enabled}
              disabled={!ready || pending}
              onChange={(event) =>
                setSchedule({ ...schedule, enabled: event.target.checked })
              }
            />{" "}
            <span>
              <strong>Create automatic local backups</strong>
              <small>
                Save encrypted files on this server at the interval below.
              </small>
            </span>
          </label>
          <label className="field">
            <span>Backup interval (minutes)</span>
            <input
              type="number"
              aria-label="Backup interval (minutes)"
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
          <p className="settings-note">
            Choose between 15 minutes and 7 days (10,080 minutes).
          </p>
        </fieldset>
        <fieldset className="admin-subsection">
          <legend>In the cloud</legend>
          <label className="admin-toggle">
            <input
              type="checkbox"
              checked={schedule.cloudEnabled}
              disabled={!ready || pending}
              onChange={(event) =>
                setSchedule({ ...schedule, cloudEnabled: event.target.checked })
              }
            />{" "}
            <span>
              <strong>Keep an automatic cloud copy when connected</strong>
              <small>
                Requires a connected cloud account and internet access.
              </small>
            </span>
          </label>
        </fieldset>
        <div className="deployment-actions">
          <button
            className="button button--primary"
            disabled={
              !ready ||
              pending ||
              !dirty ||
              schedule.intervalMinutes < 15 ||
              schedule.intervalMinutes > 10080
            }
          >
            <AdminIcon name="check" />
            {pending ? "Saving schedule…" : "Save backup schedule"}
          </button>
          {dirty && <AdminStatus tone="warning">Unsaved changes</AdminStatus>}
        </div>
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
      <div className="admin-card-heading">
        <h2>Profile access requests</h2>
        <AdminStatus tone="warning">
          {requests.length} awaiting approval
        </AdminStatus>
      </div>
      <p>Approve only requests from someone in your household.</p>
      {requests.map((item) => (
        <div className="deployment-card" key={item.id}>
          <strong>{item.profileName}</strong>
          <p>
            {item.purpose === "unlock"
              ? "Unlock profile"
              : item.purpose === "change"
                ? "Change or remove profile PIN"
                : "Reset profile PIN"}{" "}
            · Requested from {item.deviceName}
          </p>
          <div className="deployment-actions">
            <button
              className="button button--primary"
              disabled={pending}
              onClick={() => void decide(item.id, true)}
            >
              Approve{" "}
              {item.purpose === "unlock"
                ? "profile access"
                : item.purpose === "change"
                  ? "PIN change or removal"
                  : "PIN reset"}
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
