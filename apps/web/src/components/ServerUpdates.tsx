import { useCallback, useEffect, useRef, useState } from "react";
import { AdminIcon, AdminNote, AdminStatus } from "./AdminUI";
import { useToasts } from "./ToastProvider";

export interface ServerUpdateStatus {
  supported: boolean;
  unsupportedReason?: "development" | "platform";
  currentVersion: string;
  state:
    | "unsupported"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  latestVersion: string | null;
  releaseNotesUrl: string | null;
  downloadBytes: number | null;
  downloadedBytes: number | null;
  checkedAt: string | null;
  error: string | null;
  settings: { autoDownload: boolean; nightlyInstall: boolean };
  remindAfter: string | null;
  playbackActive: boolean;
  nightlyWindow: { startHour: number; endHour: number };
  lastResult: {
    result: "installed" | "current" | "rolled-back" | "failed";
    version: string | null;
    from: string | null;
    message?: string;
    at: string;
  } | null;
}

class ServerUpdateRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(
  path = "",
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
): Promise<ServerUpdateStatus> {
  const response = await fetch(`/api/v1/server/updates${path}`, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ServerUpdateRequestError(
      failure?.error?.message ?? "Server updates are unavailable right now.",
      failure?.error?.code ?? "UPDATE_REQUEST_FAILED",
      response.status,
    );
  }
  return response.json() as Promise<ServerUpdateStatus>;
}

const ACTIVE_STATES = new Set(["checking", "downloading", "installing"]);
const megabytes = (bytes: number) =>
  `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;

/** Whether the owner should be reminded about an offered update now. */
export function shouldRemind(
  status: ServerUpdateStatus | null,
  now = Date.now(),
) {
  return (
    !!status?.supported &&
    !!status.latestVersion &&
    (status.state === "available" || status.state === "ready") &&
    (!status.remindAfter || Date.parse(status.remindAfter) <= now)
  );
}

/**
 * Owner-only server update status. Polls while an operation is running and
 * reloads the page once the server comes back with a new version.
 */
export function useServerUpdates(enabled = true) {
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const installingFrom = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const value = await request();
      setStatus(value);
      setUnavailable(false);
      return value;
    } catch (reason) {
      if (reason instanceof ServerUpdateRequestError && reason.status === 403)
        setUnavailable(true);
      throw reason;
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void request()
      .then((value) => active && setStatus(value))
      .catch((reason) => {
        if (
          active &&
          reason instanceof ServerUpdateRequestError &&
          reason.status === 403
        )
          setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !status || !ACTIVE_STATES.has(status.state)) return;
    if (status.state === "installing")
      installingFrom.current ??= status.currentVersion;
    const timer = setInterval(
      () => {
        // While the updater restarts the server, requests fail; keep waiting.
        void request()
          .then((value) => {
            if (
              installingFrom.current &&
              value.currentVersion !== installingFrom.current
            ) {
              window.location.reload();
              return;
            }
            if (value.lastResult && value.state !== "installing")
              installingFrom.current = null;
            setStatus(value);
          })
          .catch(() => undefined);
      },
      status.state === "installing" ? 4000 : 1500,
    );
    return () => clearInterval(timer);
  }, [enabled, status]);
  return { status, setStatus, refresh, unavailable };
}

export function ServerUpdatesPanel() {
  const { status, setStatus } = useServerUpdates();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [confirmPlayback, setConfirmPlayback] = useState(false);
  const { showToast } = useToasts();
  const act = async (
    name: string,
    action: () => Promise<ServerUpdateStatus>,
  ) => {
    setPending(name);
    setError("");
    try {
      const value = await action();
      setStatus(value);
      return value;
    } catch (reason) {
      if (
        reason instanceof ServerUpdateRequestError &&
        reason.code === "PLAYBACK_ACTIVE"
      )
        setConfirmPlayback(true);
      else
        setError(
          reason instanceof Error
            ? reason.message
            : "The update action failed.",
        );
      return null;
    } finally {
      setPending("");
    }
  };
  if (!status)
    return (
      <section className="profile-page__section">
        <h2>Server updates</h2>
        <p role="status">Checking update status…</p>
      </section>
    );
  if (!status.supported)
    return (
      <section className="profile-page__section">
        <div className="admin-card-heading">
          <h2>Server updates</h2>
          <AdminStatus>Version {status.currentVersion}</AdminStatus>
        </div>
        <AdminNote>
          <strong>Automatic updates need the Windows server installer.</strong>{" "}
          {status.unsupportedReason === "platform"
            ? "Update this server with its package manager or a new release package."
            : "This server runs from a development tree or container; update it with git or a new image."}
        </AdminNote>
      </section>
    );
  const { state, latestVersion } = status;
  const progress =
    state === "downloading" && status.downloadBytes
      ? Math.min(
          100,
          Math.round(
            ((status.downloadedBytes ?? 0) / status.downloadBytes) * 100,
          ),
        )
      : null;
  const tone =
    state === "ready" || state === "available"
      ? "warning"
      : state === "error"
        ? "danger"
        : state === "installing" ||
            state === "downloading" ||
            state === "checking"
          ? "neutral"
          : "success";
  const label = {
    unsupported: "Unavailable",
    idle: "Up to date",
    checking: "Checking…",
    available: `Version ${latestVersion} available`,
    downloading:
      progress === null ? "Downloading…" : `Downloading ${progress}%`,
    ready: `Version ${latestVersion} ready to install`,
    installing: "Installing…",
    error: "Check failed",
  }[state];
  const saveSetting = (
    key: "autoDownload" | "nightlyInstall",
    value: boolean,
  ) =>
    void act(key, () => request("/settings", "PUT", { [key]: value })).then(
      (result) => {
        if (result) showToast("Update preference saved.", "success");
      },
    );
  const install = (allowDuringPlayback = false) =>
    void act("install", () =>
      request("/install", "POST", {
        confirm: "install-server-update",
        version: latestVersion,
        allowDuringPlayback,
      }),
    ).then((result) => {
      if (result) {
        setConfirmPlayback(false);
        showToast(
          "Installing the update. StreamerAI restarts in a moment.",
          "success",
        );
      }
    });
  const result = status.lastResult;
  return (
    <section
      className="profile-page__section server-updates"
      aria-busy={state === "installing" || state === "downloading"}
    >
      <div className="admin-card-heading">
        <h2>Server updates</h2>
        <AdminStatus tone={tone}>{label}</AdminStatus>
      </div>
      <dl className="server-updates__versions">
        <div>
          <dt>Installed</dt>
          <dd>{status.currentVersion}</dd>
        </div>
        <div>
          <dt>Latest</dt>
          <dd>
            {latestVersion ??
              (state === "idle" && status.checkedAt
                ? status.currentVersion
                : "—")}
            {status.releaseNotesUrl && (
              <>
                {" "}
                <a
                  href={status.releaseNotesUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  What's new <AdminIcon name="arrow" />
                </a>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>
            {status.checkedAt
              ? new Date(status.checkedAt).toLocaleString()
              : "Not yet"}
          </dd>
        </div>
      </dl>
      {result?.result === "installed" &&
        result.version === status.currentVersion && (
          <AdminNote>
            <strong>Updated to {result.version}.</strong>
            {result.from
              ? ` Previous version ${result.from} is kept for automatic rollback.`
              : ""}
          </AdminNote>
        )}
      {(result?.result === "rolled-back" || result?.result === "failed") && (
        <AdminNote tone="warning">
          <strong>
            {result.result === "rolled-back"
              ? `Version ${result.version} did not start, so ${result.from} was restored with its data.`
              : `The update to ${result.version ?? "the new version"} could not be installed.`}
          </strong>{" "}
          {result.message}
        </AdminNote>
      )}
      {state === "installing" && (
        <AdminNote>
          <strong>Installing the update.</strong> StreamerAI stops for a minute
          or two and this page reloads when it is back. If the new version does
          not start, the previous one is restored automatically.
        </AdminNote>
      )}
      {progress !== null && (
        <progress
          className="server-updates__progress"
          max={100}
          value={progress}
          aria-label="Update download progress"
        />
      )}
      {state === "ready" && status.downloadBytes && (
        <p>
          The update ({megabytes(status.downloadBytes)}) is downloaded and
          verified. Installing restarts the server; your household, profiles and
          settings stay as they are.
        </p>
      )}
      {status.error && state !== "installing" && (
        <p role="alert">{status.error}</p>
      )}
      {confirmPlayback && (
        <AdminNote tone="warning">
          <strong>Someone is watching right now.</strong> Installing stops
          playback on every device for a moment.
          <div className="deployment-actions">
            <button
              className="button button--primary"
              type="button"
              disabled={!!pending}
              onClick={() => install(true)}
            >
              Install anyway
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => setConfirmPlayback(false)}
            >
              Wait
            </button>
          </div>
        </AdminNote>
      )}
      <div className="deployment-actions">
        {state === "ready" && !confirmPlayback && (
          <button
            className="button button--primary"
            type="button"
            disabled={!!pending}
            onClick={() => install()}
          >
            <AdminIcon name="download" />
            {pending === "install"
              ? "Starting installation…"
              : `Install ${latestVersion} now`}
          </button>
        )}
        {state === "available" && (
          <button
            className="button button--primary"
            type="button"
            disabled={!!pending}
            onClick={() =>
              void act("download", () => request("/download", "POST"))
            }
          >
            <AdminIcon name="download" />
            {pending === "download"
              ? "Starting download…"
              : `Download ${latestVersion}`}
          </button>
        )}
        {(state === "available" || state === "ready") && (
          <button
            className="button button--ghost"
            type="button"
            disabled={!!pending}
            onClick={() =>
              void act("remind", () => request("/remind-later", "POST")).then(
                (value) =>
                  value && showToast("We'll remind you tomorrow.", "success"),
              )
            }
          >
            <AdminIcon name="clock" />
            Remind me tomorrow
          </button>
        )}
        <button
          className="button button--ghost"
          type="button"
          disabled={!!pending || ACTIVE_STATES.has(state)}
          onClick={() => void act("check", () => request("/check", "POST"))}
        >
          {pending === "check" || state === "checking"
            ? "Checking…"
            : "Check for updates"}
        </button>
      </div>
      <fieldset className="admin-subsection">
        <legend>Automatic updates</legend>
        <label className="admin-toggle">
          <input
            type="checkbox"
            checked={status.settings.autoDownload}
            disabled={!!pending}
            onChange={(event) =>
              saveSetting("autoDownload", event.target.checked)
            }
          />{" "}
          <span>
            <strong>Download updates automatically</strong>
            <small>
              New versions are downloaded and verified in the background.
              Nothing is installed without you.
            </small>
          </span>
        </label>
        <label className="admin-toggle">
          <input
            type="checkbox"
            checked={status.settings.nightlyInstall}
            disabled={!!pending}
            onChange={(event) =>
              saveSetting("nightlyInstall", event.target.checked)
            }
          />{" "}
          <span>
            <strong>Install updates automatically at night</strong>
            <small>
              Between {hour(status.nightlyWindow.startHour)} and{" "}
              {hour(status.nightlyWindow.endHour)} server time, only when nobody
              is watching. A failed update is rolled back automatically.
            </small>
          </span>
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * Reminder bar for the household owner. It reappears after "Remind me
 * tomorrow" until the update is installed.
 */
export function ServerUpdateReminder({ onReview }: { onReview?: () => void }) {
  const { status, setStatus, unavailable } = useServerUpdates();
  const [hidden, setHidden] = useState(false);
  if (unavailable || hidden || !shouldRemind(status)) return null;
  const ready = status!.state === "ready";
  return (
    <div className="server-update-reminder" role="status">
      <AdminIcon name="download" />
      <p>
        <strong>StreamerAI {status!.latestVersion} is available.</strong>{" "}
        {ready
          ? "It is downloaded and ready to install."
          : "Review the update when it suits you."}
      </p>
      <div>
        {onReview ? (
          <button
            className="button button--primary"
            type="button"
            onClick={onReview}
          >
            Review update
          </button>
        ) : (
          <a className="button button--primary" href="/admin?tab=updates">
            Review update
          </a>
        )}
        <button
          className="button button--ghost"
          type="button"
          onClick={() => {
            setHidden(true);
            void request("/remind-later", "POST")
              .then(setStatus)
              .catch(() => undefined);
          }}
        >
          Remind me tomorrow
        </button>
      </div>
    </div>
  );
}
