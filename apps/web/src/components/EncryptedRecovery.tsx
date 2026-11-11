import { useEffect, useState } from "react";
import { getInstallationStatus } from "./InstallationAccess";
import { useToasts } from "./ToastProvider";
import { DigitSlotsInput } from "./DigitSlotsInput";
import { AdminHelp as InfoTip } from "./AdminUI";
import { MasterPinDialog } from "./MasterPinDialog";
import { AdminIcon, AdminNote, AdminStatus } from "./AdminUI";

const base = "/api/v1/account/encrypted-household";
async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    const code = data?.error?.code;
    throw new Error(
      code === "MASTER_PIN_REQUIRED"
        ? "Complete household setup before creating a backup."
        : code === "HOUSEHOLD_AUTHENTICATION_FAILED" ||
            code === "INVALID_MASTER_PIN"
          ? "The backup could not be unlocked. Check its 8-digit Master PIN."
          : code === "HOUSEHOLD_RESTORE_REQUIRES_EMPTY_ACCOUNT"
            ? "Restore requires a new household with no existing profile data."
            : "The operation could not be completed. Check your file and server connection.",
    );
  }
  return response.json() as Promise<T>;
}
function download(filename: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface Status {
  cloudConfigured: boolean;
  cloudBackup?: {
    status: "pending" | "saving" | "current" | "error";
    lastSavedAt: string | null;
    error: string | null;
  };
}
interface Preview {
  profiles: { name: string; pinEnabled?: boolean }[];
  credentials: string[];
  limitations: string[];
}

function BackupActionIcon({ restore = false }: { restore?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 16v4h16v-4" />
      {restore ? (
        <path d="M12 16V4m-5 5 5-5 5 5" />
      ) : (
        <path d="M12 4v12m-5-5 5 5 5-5" />
      )}
    </svg>
  );
}

export function EncryptedRecovery({
  restoreOnly = false,
  autoLoadCloud = false,
  clientMasterPinDialog = false,
  onRestored,
}: {
  restoreOnly?: boolean;
  autoLoadCloud?: boolean;
  clientMasterPinDialog?: boolean;
  onRestored?: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pin, setPin] = useState("");
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [envelope, setEnvelope] = useState<unknown>(null);
  const [cloudRevision, setCloudRevision] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(restoreOnly);
  const { showToast } = useToasts();
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const installation = await getInstallationStatus();
        if (
          installation.enabled &&
          installation.role !== "owner" &&
          !installation.setupAuthorized
        )
          return;
        const result = await call<Status>("");
        if (active) setStatus(result);
        if (autoLoadCloud) {
          const copy = await call<{
            revision: number;
            envelope: unknown | null;
          }>("/cloud");
          if (!copy.envelope)
            throw new Error("There is no cloud backup to restore.");
          if (active) {
            setEnvelope(copy.envelope);
            setCloudRevision(copy.revision);
          }
        }
      } catch {
        if (active && restoreOnly)
          setError(
            "Backup recovery is temporarily unavailable. Check the home server connection.",
          );
      }
    };
    void refresh();
    const timer = restoreOnly
      ? null
      : setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [restoreOnly, autoLoadCloud]);
  if (!status)
    return restoreOnly ? (
      <p role={error ? "alert" : "status"}>
        {error || "Loading backup recoveryâ€¦"}
      </p>
    ) : null;
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Recovery unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={
        restoreOnly ? "profile-page__section" : "account-security__subsection"
      }
      id="account-encrypted-recovery"
    >
      {!restoreOnly && (
        <>
          <div className="admin-card-heading">
            <h2>
              Household backups{" "}
              <InfoTip label="What a household backup includes">
                An encrypted household file contains profiles, viewing data and
                portable service credentials. It can be restored with its
                original Master PIN on an empty household.
              </InfoTip>
            </h2>
            <AdminStatus>
              <AdminIcon name="lock" />
              Encrypted
            </AdminStatus>
          </div>
          <p>
            Keep a portable copy of your profiles and viewing data, encrypted
            with your Master PIN. Restore it on a new server using the PIN that
            protected the backup.
          </p>
          <div className="deployment-card household-backup-cloud admin-subsection">
            <div className="admin-card-heading">
              <h3>
                <AdminIcon name="cloud" />
                Automatic cloud backup
              </h3>
              <AdminStatus
                tone={
                  !status.cloudConfigured
                    ? "neutral"
                    : status.cloudBackup?.status === "current"
                      ? "success"
                      : status.cloudBackup?.status === "error"
                        ? "danger"
                        : "warning"
                }
              >
                {!status.cloudConfigured
                  ? "Not connected"
                  : status.cloudBackup?.status === "current"
                    ? "Current"
                    : status.cloudBackup?.status === "saving"
                      ? "Saving"
                      : status.cloudBackup?.status === "error"
                        ? "Needs attention"
                        : "Waiting"}
              </AdminStatus>
            </div>
            <p
              role="status"
              className={
                status.cloudBackup?.status === "current"
                  ? "cloud-backup-current"
                  : undefined
              }
            >
              {!status.cloudConfigured
                ? "Connect an online account to enable automatic cloud backups."
                : status.cloudBackup?.status === "current"
                  ? `âś“ Encrypted backup is current. Last saved ${new Date(status.cloudBackup.lastSavedAt!).toLocaleString()}.`
                  : status.cloudBackup?.status === "saving"
                    ? "Saving encrypted backup to cloudâ€¦"
                    : status.cloudBackup?.status === "error"
                      ? `Cloud backup needs attention: ${status.cloudBackup.error}`
                      : "Encrypted cloud backup is waiting for the next automatic save."}
            </p>
          </div>
          <div className="household-backup-actions">
            <button
              className="household-backup-action"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const data = await call<unknown>("/export", "POST", {});
                  download("streamerai-household.json", JSON.stringify(data));
                  showToast("Encrypted file ready to download.", "success");
                  setNotice("This file is protected with your Master PIN.");
                })
              }
            >
              <BackupActionIcon />
              <span>Create</span>
              <small aria-hidden="true">
                Download an encrypted household file
              </small>
            </button>
            <button
              className="household-backup-action"
              type="button"
              disabled={busy}
              aria-expanded={restoreOpen}
              aria-controls="account-household-restore"
              onClick={() => setRestoreOpen((open) => !open)}
            >
              <BackupActionIcon restore />
              <span>Restore</span>
              <small aria-hidden="true">
                Review a saved file or cloud backup
              </small>
            </button>
          </div>
        </>
      )}
      {restoreOpen && (
        <div
          id="account-household-restore"
          className="household-backup-restore"
        >
          {restoreOnly ? (
            <p>
              Import your saved household using the Master PIN that protected
              the backup.{" "}
              <InfoTip label="What is a Master PIN?">
                Your 8-digit code unlocks any profile and protects local
                backups.
              </InfoTip>
            </p>
          ) : (
            <h3>Restore into an empty household</h3>
          )}
          {!restoreOnly && (
            <AdminNote tone="warning">
              Restore is available for an <strong>empty household</strong>.
              Review the backup contents before confirming. Use the Master PIN
              that protected that backup.
            </AdminNote>
          )}
          {status.cloudConfigured && !autoLoadCloud && (
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const copy = await call<{
                    revision: number;
                    envelope: unknown | null;
                  }>("/cloud");
                  if (!copy.envelope)
                    throw new Error("There is no cloud backup to restore yet.");
                  setEnvelope(copy.envelope);
                  setCloudRevision(copy.revision);
                  setPreview(null);
                  setPin("");
                  setNotice(
                    "Encrypted cloud backup loaded. Enter its Master PIN to review it.",
                  );
                })
              }
            >
              Restore from cloud backup
            </button>
          )}
          {!autoLoadCloud && (
            <label className="field">
              <span>Encrypted household file</span>
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  setPreview(null);
                  setEnvelope(null);
                  setCloudRevision(null);
                  setPin("");
                  setError("");
                  if (!file) return;
                  if (file.size > 16 * 1024 * 1024) {
                    setError("The household file is too large.");
                    return;
                  }
                  void file
                    .text()
                    .then((text) => setEnvelope(JSON.parse(text) as unknown))
                    .catch(() =>
                      setError("This is not a readable household file."),
                    );
                }}
              />
            </label>
          )}
          {clientMasterPinDialog ? (
            <>
              <button
                className="button button--secondary"
                type="button"
                disabled={busy}
                onClick={() => setPinDialogOpen(true)}
              >
                {pin ? "Change backup Master PIN" : "Enter backup Master PIN"}
              </button>
              {pin && <p role="status">Backup Master PIN entered.</p>}
              {pinDialogOpen && (
                <MasterPinDialog
                  title="Enter the backup Master PIN"
                  description="Enter the Master PIN that encrypted this backup."
                  onSubmit={(value) => {
                    setPin(value);
                    setPreview(null);
                    setPinDialogOpen(false);
                  }}
                  onCancel={() => setPinDialogOpen(false)}
                />
              )}
            </>
          ) : (
            <DigitSlotsInput
              label="Master PIN for this backup"
              value={pin}
              onChange={(value) => {
                setPin(value);
                setPreview(null);
              }}
            />
          )}
          <button
            className="button button--secondary"
            type="button"
            disabled={busy || !envelope || !/^\d{8}$/.test(pin)}
            onClick={() =>
              void run(async () =>
                setPreview(
                  await call<Preview>("/preview", "POST", {
                    envelope,
                    recoveryKey: pin,
                  }),
                ),
              )
            }
          >
            Review contents
          </button>
          {preview && (
            <div className="deployment-card">
              <h3>Review recovery</h3>
              <p>
                Profiles:{" "}
                {preview.profiles.map((profile) => profile.name).join(", ")}
              </p>
              <p>{preview.credentials.length} portable service credentials.</p>
              <ul>
                {preview.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>Existing household data will not be merged or overwritten.</p>
              <button
                className="button button--secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call("/restore", "POST", {
                      envelope,
                      recoveryKey: pin,
                      ...(cloudRevision === null ? {} : { cloudRevision }),
                      confirm: "restore-into-empty-household",
                    });
                    setPin("");
                    setEnvelope(null);
                    setCloudRevision(null);
                    setPreview(null);
                    setNotice(
                      "Household restored. Reload the application to choose a recovered profile.",
                    );
                    await onRestored?.();
                  })
                }
              >
                Confirm restore into empty household
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
