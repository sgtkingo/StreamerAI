import { useEffect, useState } from "react";
import { getInstallationStatus } from "./InstallationAccess";

const base = "/api/v1/account/encrypted-household";
async function call<T>(
  suffix: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + suffix, {
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
      code === "ENCRYPTED_CHECKPOINT_CONFLICT"
        ? "The cloud copy changed on another server. Check it again before replacing it."
        : code === "HOUSEHOLD_RESTORE_REQUIRES_EMPTY_ACCOUNT"
          ? "Restore requires a new household with no existing profile data."
          : "The operation could not be completed. Check your recovery key, file and server connection.",
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
  enabled: boolean;
  cloudConfigured: boolean;
  mode: string;
}
interface Preview {
  profiles: { name: string; pinEnabled?: boolean }[];
  credentials: string[];
  limitations: string[];
}
export function EncryptedRecovery() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [envelope, setEnvelope] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let active = true;
    void getInstallationStatus()
      .then(async (installation) => {
        if (installation.role !== "owner") return;
        const result = await call<Status>("");
        if (active) setStatus(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!status) return null;
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
    <section className="profile-page__section" id="settings-encrypted-recovery">
      <p className="eyebrow">Encrypted recovery · preview</p>
      <h2>Profiles and service access</h2>
      <p>
        Save an encrypted household file and restore it on a new server. Keep
        the recovery key separately. Full server backups include additional
        data; use the offline backup command while the server is stopped.
      </p>
      <p className="settings-note">
        This preview uses encrypted snapshots. Automatic merging between servers
        and approval without a recovery key are still being developed. Enabling
        encrypted recovery pauses the older profile synchronization.
      </p>
      {!status.enabled && (
        <button
          className="button button--secondary"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await call<{
                recoveryKey: string;
                status: Status;
              }>("/activate", "POST", {
                confirm: "enable-encrypted-household",
              });
              setNewKey(result.recoveryKey);
              setStatus({ ...status, ...result.status });
            })
          }
        >
          Enable encrypted recovery
        </button>
      )}
      {newKey && (
        <div className="deployment-card">
          <h3>Save your recovery key</h3>
          <p>
            Store it safely and separately from exported files. Anyone with both
            can read your saved profiles and service credentials.
          </p>
          <code className="recovery-key">{newKey}</code>
          <div className="deployment-actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => download("streamerai-recovery-key.txt", newKey)}
            >
              Save key separately
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setNewKey("")}
            >
              I have saved the key · Hide
            </button>
          </div>
        </div>
      )}
      {status.enabled && (
        <div className="deployment-actions">
          <button
            className="button button--secondary"
            type="button"
            disabled={busy || !!newKey}
            onClick={() =>
              void run(async () => {
                const data = await call<unknown>("/export", "POST", {});
                download("streamerai-household.json", JSON.stringify(data));
                setNotice(
                  "Encrypted file saved. Store your recovery key separately.",
                );
              })
            }
          >
            Save encrypted household file
          </button>
          <button
            className="button button--secondary"
            type="button"
            disabled={busy || !!newKey}
            onClick={() => setConfirmed(!confirmed)}
          >
            Replace recovery key…
          </button>
        </div>
      )}
      {confirmed && (
        <div className="deployment-card">
          <p>
            This creates a new recovery key. Previously saved files still need
            their original key. Save the new key before replacing future cloud
            copies.
          </p>
          <button
            className="button button--secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await call<{
                  recoveryKey: string;
                  status: Status;
                }>("/rotate-recovery", "POST", {
                  confirm: "rotate-recovery-key",
                });
                setNewKey(result.recoveryKey);
                setConfirmed(false);
              })
            }
          >
            Confirm key replacement
          </button>
        </div>
      )}
      {status.cloudConfigured && (
        <div className="deployment-card">
          <h3>Encrypted cloud checkpoint</h3>
          <p>
            Check the cloud revision before uploading. A changed revision is a
            conflict and will not be overwritten silently. This needs the
            matching cloud service version.
          </p>
          <div className="deployment-actions">
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const data = await call<{
                    revision: number;
                    envelope: unknown | null;
                  }>("/cloud");
                  setRevision(data.revision);
                  if (data.envelope) {
                    setEnvelope(data.envelope);
                    setPreview(null);
                  }
                  setNotice(
                    `Cloud revision ${data.revision}${data.envelope ? " loaded for review." : " has no saved household."}`,
                  );
                })
              }
            >
              Check cloud copy
            </button>
            {status.enabled && revision !== null && (
              <button
                className="button button--secondary"
                type="button"
                disabled={busy || !!newKey}
                onClick={() =>
                  void run(async () => {
                    const result = await call<{ revision: number }>(
                      "/cloud",
                      "PUT",
                      {
                        expectedRevision: revision,
                        confirm: "upload-encrypted-checkpoint",
                      },
                    );
                    setRevision(result.revision);
                    setNotice("Encrypted checkpoint uploaded.");
                  })
                }
              >
                Upload current household
              </button>
            )}
          </div>
        </div>
      )}
      <h3>Restore into an empty household</h3>
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
            setError("");
            if (!file) return;
            if (file.size > 16 * 1024 * 1024) {
              setError("The household file is too large.");
              return;
            }
            void file
              .text()
              .then((text) => setEnvelope(JSON.parse(text) as unknown))
              .catch(() => setError("This is not a readable household file."));
          }}
        />
      </label>
      <label className="field">
        <span>Recovery key for this file</span>
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <button
        className="button button--secondary"
        type="button"
        disabled={busy || !envelope || !key}
        onClick={() =>
          void run(async () =>
            setPreview(
              await call<Preview>("/preview", "POST", {
                envelope,
                recoveryKey: key,
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
                  recoveryKey: key,
                  confirm: "restore-into-empty-household",
                });
                setKey("");
                setEnvelope(null);
                setPreview(null);
                setNotice(
                  "Household restored. Reload the application to choose a recovered profile.",
                );
              })
            }
          >
            Confirm restore into empty household
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
