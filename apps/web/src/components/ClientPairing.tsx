import { useEffect, useRef, useState } from "react";
import type { StreamerApi } from "../api/client";
import type { InstallationStatus } from "./InstallationAccess";
import { AdminIcon, AdminHelp } from "./AdminUI";
import { Brand } from "./Brand";
import { MasterPinDialog } from "./MasterPinDialog";
import {
  clearPairingSession,
  readPairingSession,
  savePairingSession,
  type PairingRequest,
} from "./client-pairing-session";
import "./client-pairing.css";

type Phase =
  "name" | "pending" | "expired" | "denied" | "approved" | "unavailable";

export function ClientPairing({
  status,
  api,
  onConnected,
  requestInstallation,
}: {
  status: InstallationStatus;
  api?: StreamerApi;
  onConnected(): void;
  requestInstallation<T>(path: string, body?: unknown): Promise<T>;
}) {
  const [restored] = useState(() => readPairingSession(status.serverId));
  const [name, setName] = useState(restored?.name ?? "Home browser");
  const [request, setRequest] = useState<PairingRequest | null>(
    restored?.request ?? null,
  );
  const [phase, setPhase] = useState<Phase>(restored ? "pending" : "name");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const running = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const approvalHeading = useRef<HTMLHeadingElement>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  useEffect(() => {
    if (!request || phase !== "pending") return;
    const update = () => {
      const seconds = Math.max(
        0,
        Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1000),
      );
      setRemaining(seconds);
      if (!seconds) {
        setPhase("expired");
        setPollError("");
        clearPairingSession();
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [request, phase]);

  useEffect(() => {
    if (!request || phase !== "pending" || signIn) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const interval = Math.max(3, request.interval ?? 3) * 1000;
    const poll = async () => {
      if (!active || Date.now() >= Date.parse(request.expiresAt)) return;
      try {
        const result = await requestInstallation<{ status: string }>("poll", {
          requestId: request.requestId,
        });
        if (!active) return;
        setPollError("");
        if (result.status === "approved") {
          active = false;
          clearPairingSession();
          setPhase("approved");
          connected.current();
          return;
        }
        if (result.status === "expired" || result.status === "denied") {
          clearPairingSession();
          setPhase(result.status);
          return;
        }
      } catch (reason) {
        if (!active) return;
        if (
          reason instanceof Error &&
          "code" in reason &&
          reason.code === "POLL_TOO_FAST"
        ) {
          timer = setTimeout(() => void poll(), interval);
          return;
        }
        if (
          reason instanceof Error &&
          "code" in reason &&
          reason.code === "PAIRING_REJECTED"
        ) {
          clearPairingSession();
          setPollError("");
          setPhase("unavailable");
          return;
        }
        setPollError(
          "The server could not be reached. We will keep checking until this code expires.",
        );
      }
      if (active) timer = setTimeout(() => void poll(), interval);
    };
    timer = setTimeout(() => void poll(), interval);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [request, phase, signIn, requestInstallation]);

  const submit = async () => {
    if (running.current || !name.trim()) return;
    running.current = true;
    setBusy(true);
    setError("");
    setPollError("");
    try {
      const next = await requestInstallation<PairingRequest>("pair", {
        name: name.trim(),
      });
      if (
        !next.requestId ||
        !/^\d{6}$/.test(next.code) ||
        !Number.isFinite(Date.parse(next.expiresAt))
      )
        throw new Error(
          "A pairing code could not be prepared. Please try again.",
        );
      setRequest(next);
      savePairingSession(status.serverId, name.trim(), next);
      setRemaining(
        Math.max(
          0,
          Math.ceil((Date.parse(next.expiresAt) - Date.now()) / 1000),
        ),
      );
      setPhase("pending");
      setSignIn(false);
      requestAnimationFrame(() =>
        approvalHeading.current?.focus({ preventScroll: true }),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "A pairing code could not be prepared. Please try again.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const authorize = async (masterPin: string) => {
    const input = {
      masterPin,
      deviceName: name.trim() || "Home browser",
      admin: false,
    };
    if (api?.authorizeInstallation) await api.authorizeInstallation(input);
    else await requestInstallation("authorize", input);
    clearPairingSession();
    setPhase("approved");
    connected.current();
  };
  const editName = () => {
    clearPairingSession();
    setRequest(null);
    setPhase("name");
    setError("");
    setPollError("");
    requestAnimationFrame(() => nameInput.current?.focus());
  };
  const ready =
    status.householdReady !== false &&
    (status.claimed || status.householdReady === true);
  let approvalUrl = request
    ? new URL(
        `/admin/pair?code=${encodeURIComponent(request.code)}`,
        window.location.origin,
      ).href
    : "";
  if (request?.verificationUriComplete) {
    try {
      const provided = new URL(
        request.verificationUriComplete,
        window.location.origin,
      );
      if (["http:", "https:"].includes(provided.protocol))
        approvalUrl = provided.href;
    } catch {
      /* Keep the local approval URL. */
    }
  }
  const loopback =
    approvalUrl &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(approvalUrl).hostname);
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");

  return (
    <main className="client-pairing">
      <header className="client-pairing__brand">
        <Brand />
        <span>
          <AdminIcon name="security" />
          Household connection
        </span>
      </header>
      <section
        className="client-pairing__panel"
        aria-labelledby="client-pairing-title"
      >
        <header className="client-pairing__intro">
          <div className="client-pairing__intro-top">
            <span className="client-pairing__icon">
              <AdminIcon name="devices" />
            </span>
            {ready && (
              <ol
                className="client-pairing__progress"
                aria-label="Pairing progress"
              >
                <li aria-current={phase === "name" ? "step" : undefined}>
                  <span>
                    {phase === "name" ? "1" : <AdminIcon name="check" />}
                  </span>
                  This device
                </li>
                <li aria-current={phase !== "name" ? "step" : undefined}>
                  <span>2</span>Approval
                </li>
              </ol>
            )}
          </div>
          <h1 id="client-pairing-title">
            {!ready
              ? status.claimed
                ? "Your household is not ready yet"
                : "Set up your household first"
              : "Connect this device"}
          </h1>
          <p>
            {!ready
              ? "The server owner can create a household or import a backup in household administration."
              : phase === "name"
                ? "Name this device, then approve it from another device in your household."
                : "One quick approval, and this device is ready for your household."}
          </p>
          {status.householdName && (
            <div className="client-pairing__household">
              <AdminIcon name="household" />
              <span>
                Connecting to <strong>{status.householdName}</strong>
              </span>
            </div>
          )}
        </header>
        {!ready ? (
          <div className="client-pairing__setup">
            <a className="button button--primary" href="/admin">
              Open household administration
              <AdminIcon name="arrow" />
            </a>
          </div>
        ) : (
          <>
            {phase === "name" ? (
              <div className="client-pairing__start">
                <form
                  className="client-pairing__form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                  aria-labelledby="client-device-title"
                >
                  <div className="client-pairing__form-heading">
                    <h2 id="client-device-title">Name this device</h2>
                    <AdminHelp label="How to pair this device">
                      Show a pairing code, then use an already approved device
                      to open Administration → Devices. Compare the code and
                      approve this connection.
                    </AdminHelp>
                  </div>
                  <p>Choose a name the household owner will recognize.</p>
                  <label className="field" htmlFor="client-device-name">
                    <span>Device name</span>
                    <input
                      ref={nameInput}
                      id="client-device-name"
                      value={name}
                      maxLength={80}
                      required
                      disabled={busy}
                      placeholder="For example, Living room TV"
                      aria-describedby="client-device-hint"
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <p className="client-pairing__hint" id="client-device-hint">
                    This name appears with your access request.
                  </p>
                  <button
                    className="button button--primary"
                    type="submit"
                    disabled={busy || !name.trim()}
                  >
                    <AdminIcon name="pair" />
                    {busy ? "Preparing code..." : "Show pairing code"}
                  </button>
                </form>
                <aside
                  className="client-pairing__guide"
                  aria-labelledby="client-pairing-guide-title"
                >
                  <h2 id="client-pairing-guide-title">How pairing works</h2>
                  <ol>
                    <li>
                      <span>1</span>
                      <div>
                        <strong>Get your pairing code</strong>
                        <p>Create a code for this device using the form.</p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>Open an approved device</strong>
                        <p>
                          Use a phone or computer already connected to this
                          household.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>Approve the matching code</strong>
                        <p>
                          Open Administration → Devices and confirm this
                          request.
                        </p>
                      </div>
                    </li>
                  </ol>
                </aside>
              </div>
            ) : phase === "pending" && request ? (
              <div className="client-pairing__approval">
                <div className="client-pairing__scan">
                  {request.qrCodeDataUrl ? (
                    <div className="client-pairing__qr">
                      <img
                        src={request.qrCodeDataUrl}
                        width={208}
                        height={208}
                        alt="Scan to approve this device on your home server"
                      />
                    </div>
                  ) : (
                    <div className="client-pairing__qr-placeholder">
                      <AdminIcon name="pair" />
                      <p>Use the pairing code to approve this device.</p>
                    </div>
                  )}
                  <strong>
                    {loopback ? "Approval link" : "Scan with your phone"}
                  </strong>
                  <a
                    href={approvalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open approval page
                    <AdminIcon name="arrow" />
                  </a>
                  {loopback && (
                    <p className="client-pairing__hint">
                      This link opens on this computer. On another device, use
                      your server's network address.
                    </p>
                  )}
                </div>
                <div className="client-pairing__instructions">
                  <h2 ref={approvalHeading} tabIndex={-1}>
                    Approve this device
                  </h2>
                  <p>
                    On an approved device, open{" "}
                    <strong>Administration → Devices</strong>. Match this code
                    and choose <strong>Approve</strong>.
                  </p>
                  <div className="client-pairing__code-box">
                    <span>Pairing code</span>
                    <div
                      className="client-pairing__code"
                      aria-label={`Pairing code ${request.code}`}
                    >
                      <span>{request.code.slice(0, 3)}</span>{" "}
                      <span>{request.code.slice(3)}</span>
                    </div>
                    <span className="client-pairing__request-name">
                      <AdminIcon name="devices" />
                      {name.trim()}
                    </span>
                  </div>
                  <div
                    className={`client-pairing__status${pollError ? " client-pairing__status--warning" : ""}`}
                    role="status"
                  >
                    <span aria-hidden="true" />
                    {pollError
                      ? "Reconnecting to the server"
                      : "Waiting for approval"}
                  </div>
                  <p
                    className="client-pairing__expiry"
                    role="timer"
                    aria-live="off"
                  >
                    <AdminIcon name="clock" />
                    Expires in{" "}
                    <strong>
                      {minutes}:{seconds}
                    </strong>
                    <AdminHelp label="About the pairing code">
                      This code is valid for five minutes and can only connect
                      the browser or client that requested it. Compare the code
                      before approving.
                    </AdminHelp>
                  </p>
                  <button
                    className="client-pairing__text-button"
                    type="button"
                    disabled={busy}
                    onClick={editName}
                  >
                    Change device name or start again
                  </button>
                </div>
              </div>
            ) : (
              <div className="client-pairing__outcome">
                <span className="client-pairing__outcome-icon">
                  <AdminIcon name={phase === "approved" ? "check" : "clock"} />
                </span>
                <h2>
                  {phase === "expired"
                    ? "Your pairing code has expired"
                    : phase === "denied"
                      ? "This connection was declined"
                      : phase === "unavailable"
                        ? "This pairing request is no longer available"
                        : "Device connected"}
                </h2>
                <p>
                  {phase === "expired"
                    ? "Codes are valid for five minutes. Get a new code when your approved device is ready."
                    : phase === "denied"
                      ? "The household owner did not approve this request. Check with them before trying again."
                      : phase === "unavailable"
                        ? "The request can no longer be verified. Get a new code to connect this device."
                        : "Opening your household..."}
                </p>
                {phase !== "approved" && (
                  <div className="client-pairing__outcome-actions">
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void submit()}
                    >
                      <AdminIcon name="pair" />
                      {busy ? "Preparing code..." : "Get a new code"}
                    </button>
                    <button
                      className="button button--ghost"
                      type="button"
                      disabled={busy}
                      onClick={editName}
                    >
                      Change device name
                    </button>
                  </div>
                )}
              </div>
            )}
            {(error || pollError) && (
              <p className="client-pairing__error" role="alert">
                <AdminIcon name="info" />
                {error || pollError}
              </p>
            )}
            {phase !== "approved" && (
              <section
                className="client-pairing__alternative"
                aria-labelledby="client-pairing-pin-title"
              >
                <span className="client-pairing__alternative-icon">
                  <AdminIcon name="lock" />
                </span>
                <div>
                  <h2 id="client-pairing-pin-title">Know the Master PIN?</h2>
                  <p>Connect directly with your household's 8-digit PIN.</p>
                </div>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setSignIn(true)}
                >
                  Sign in on this device
                </button>
              </section>
            )}
          </>
        )}
      </section>
      {ready && (
        <footer className="client-pairing__footer">
          <span>
            <AdminIcon name="security" />
            Your device stays connected when the cloud is unavailable.
          </span>
          <a href="/admin">
            Open household administration
            <AdminIcon name="arrow" />
          </a>
        </footer>
      )}
      {signIn && (
        <MasterPinDialog
          title="Enter your Master PIN"
          description="Connect this device with your household's 8-digit Master PIN."
          onSubmit={authorize}
          onCancel={() => setSignIn(false)}
          onAskOwner={() => void submit()}
          askOwnerLabel="Ask household owner to approve this device"
        />
      )}
    </main>
  );
}
