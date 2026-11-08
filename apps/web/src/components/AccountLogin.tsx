import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeviceAuthorization,
  DeviceAuthorizationInput,
  StreamerApi,
} from "../api/client";
import { ApiError, safeErrorMessage } from "../api/client";
import { Brand } from "./Brand";
import { MasterPinSetup } from "./MasterPinSetup";

interface AccountLoginProps {
  api: StreamerApi;
  onAuthenticated: () => void;
  error?: string;
  onRetry?: () => void;
  purpose?: DeviceAuthorizationInput;
  compact?: boolean;
  onCancel?: () => void;
  allowLocal?: boolean;
  allowCloud?: boolean;
  recoveredLocalAccounts?: { id: string }[];
  adoptLocalAccount?: boolean;
  onRestoreBackup?: () => void;
  adminLogin?: boolean;
}

/** The grant stays in component memory; only the home server receives the session. */
export function AccountLogin({
  api,
  onAuthenticated,
  error,
  onRetry,
  purpose,
  compact = false,
  onCancel,
  allowLocal = false,
  allowCloud = true,
  adoptLocalAccount = false,
  onRestoreBackup,
  adminLogin = false,
}: AccountLoginProps) {
  const [grant, setGrant] = useState<DeviceAuthorization | null>(null);
  const [starting, setStarting] = useState(false);
  const [startingLocal, setStartingLocal] = useState(false);
  const [needsMasterPin, setNeedsMasterPin] = useState(false);
  const [message, setMessage] = useState("");
  const [messageSource, setMessageSource] = useState<
    "pairing" | "local" | null
  >(null);
  const [outcome, setOutcome] = useState<
    "expired" | "denied" | "cancelled" | "failed" | null
  >(null);
  const started = useRef(false);
  const inFlight = useRef(false);
  const requestId = useRef(0);
  const [remaining, setRemaining] = useState(0);
  const callback = useRef(onAuthenticated);
  const sectionRef = useRef<HTMLElement>(null);
  callback.current = onAuthenticated;

  useEffect(() => {
    sectionRef.current?.querySelector<HTMLElement>(".button")?.focus();
  }, [grant, outcome, error]);

  const start = useCallback(async () => {
    if (inFlight.current || !api.startDeviceAuthorization) return;
    inFlight.current = true;
    const id = ++requestId.current;
    setStarting(true);
    setMessage("");
    setMessageSource(null);
    setOutcome(null);
    setGrant(null);
    try {
      const result = await api.startDeviceAuthorization(
        purpose ??
          (adminLogin
            ? { adminLogin: true }
            : adoptLocalAccount
              ? { adoptLocalAccount }
              : undefined),
      );
      if (id === requestId.current) setGrant(result);
    } catch (reason) {
      if (id === requestId.current) {
        setMessage(safeErrorMessage(reason));
        setMessageSource("pairing");
      }
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, [api, purpose, adoptLocalAccount, adminLogin]);

  useEffect(() => {
    if (allowCloud && !allowLocal && !purpose && !error && !started.current) {
      started.current = true;
      void start();
    }
  }, [allowCloud, allowLocal, purpose, error, start]);

  const local = async (masterPin?: string, restore = false) => {
    if (startingLocal || !api.startLocalSession) return;
    requestId.current++;
    setGrant(null);
    setOutcome("cancelled");
    setStartingLocal(true);
    setMessage("");
    setMessageSource(null);
    try {
      if (masterPin) await api.startLocalSession(undefined, masterPin);
      else await api.startLocalSession();
      if (restore && onRestoreBackup) onRestoreBackup();
      else callback.current();
    } catch (reason) {
      if (
        reason instanceof Error &&
        "code" in reason &&
        reason.code === "MASTER_PIN_REQUIRED"
      ) {
        setNeedsMasterPin(true);
        return;
      }
      setMessage(safeErrorMessage(reason));
      setMessageSource("local");
    } finally {
      setStartingLocal(false);
    }
  };

  useEffect(() => {
    if (!grant || outcome || !api.pollDeviceAuthorization) return;
    const id = requestId.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const expiresAt = Date.parse(grant.expiresAt);
    const updateRemaining = () => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) setOutcome("expired");
    };
    updateRemaining();
    const countdown = setInterval(updateRemaining, 1000);
    const poll = async () => {
      if (!active || Date.now() >= expiresAt) return;
      try {
        const response = await api.pollDeviceAuthorization!(grant.deviceCode);
        if (!active || id !== requestId.current) return;
        if (response.status === "approved") {
          active = false;
          clearInterval(countdown);
          callback.current();
          return;
        }
        if (response.status === "expired" || response.status === "denied") {
          clearInterval(countdown);
          setMessage("");
          setOutcome(response.status);
          return;
        }
        setMessage("");
      } catch (reason) {
        if (!active || id !== requestId.current) return;
        setMessage(safeErrorMessage(reason));
        setMessageSource("pairing");
        if (
          reason instanceof ApiError &&
          reason.code &&
          [
            "HOUSEHOLD_CLOUD_UNAVAILABLE",
            "HOUSEHOLD_CLOUD_CONFLICT",
            "HOUSEHOLD_BACKUP_REQUIRED",
            "PAIRING_NOT_FOUND",
            "INSTALLATION_OWNER_REQUIRED",
          ].includes(reason.code)
        ) {
          active = false;
          clearInterval(countdown);
          setOutcome("failed");
          return;
        }
      }
      if (active)
        timer = setTimeout(
          () => void poll(),
          Math.max(1, grant.interval) * 1000,
        );
    };
    timer = setTimeout(() => void poll(), Math.max(1, grant.interval) * 1000);
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(countdown);
    };
  }, [api, grant, outcome]);

  if (needsMasterPin)
    return (
      <main className="account-login">
        <MasterPinSetup
          onSave={async (pin) => {
            if (!api.startLocalSession) return;
            await api.startLocalSession(undefined, pin);
            callback.current();
          }}
        />
      </main>
    );
  return (
    <main
      className={`account-login${compact ? " account-login--compact" : ""}`}
    >
      {!compact && <Brand />}
      <section
        ref={sectionRef}
        className="account-login__card"
        aria-labelledby="account-login-title"
      >
        <p className="eyebrow">
          {purpose ? "Verify account ownership" : "Your cinema, together"}
        </p>
        <h1 id="account-login-title">
          {purpose
            ? "Reset this profile's PIN"
            : adminLogin
              ? "Sign in to household administration"
              : adoptLocalAccount
                ? "Connect cloud services"
                : "Set up your household"}
        </h1>
        <p>
          {purpose
            ? "Sign in to the StreamerAI account that owns this profile to remove its PIN. You can then choose a new PIN."
            : adminLogin
              ? "Sign in to the cloud account connected to this household to authorize this administration browser."
              : adoptLocalAccount
                ? "Connect your household to your online account for remote management, synchronization and cloud backups. Your profiles and Master PIN stay with this household."
                : allowCloud
                  ? "Create a household on this server, import a backup, or sign in to bring your household from the cloud."
                  : "Create a household on this server or import an encrypted backup."}
        </p>
        {(error ||
          message ||
          outcome === "denied" ||
          outcome === "expired") && (
          <div className="account-login__alert" role="alert">
            <strong>
              {outcome === "denied"
                ? "Sign-in was declined"
                : outcome === "expired"
                  ? "Your pairing code has expired"
                  : messageSource === "local"
                    ? "Unable to open household"
                    : "Unable to complete sign-in"}
            </strong>
            <p>
              {error ||
                message ||
                (outcome === "denied"
                  ? "This request was declined on the confirmation screen. This device has not been connected. Create a new code when you are ready to try again."
                  : "This code is no longer valid. Create a new code to connect this device.")}
            </p>
          </div>
        )}
        {error && onRetry ? (
          <button
            className="button button--primary"
            type="button"
            onClick={onRetry}
          >
            Try again
          </button>
        ) : !allowCloud ? null : !grant || outcome ? (
          starting ? (
            <p role="status" className="account-login__loading">
              Preparing your secure pairing code…
            </p>
          ) : (
            <button
              className="button button--primary"
              type="button"
              disabled={starting || startingLocal}
              onClick={() => void start()}
            >
              {outcome === "denied" ||
              outcome === "expired" ||
              outcome === "failed"
                ? "Get a new code"
                : purpose
                  ? "Verify account"
                  : adoptLocalAccount
                    ? "Connect cloud"
                    : "Sign in to cloud"}
            </button>
          )
        ) : (
          <div className="device-pairing">
            {grant.qrCodeDataUrl && (
              <img
                className="device-pairing__qr"
                src={grant.qrCodeDataUrl}
                alt="Scan to sign in and connect this device"
                width={208}
                height={208}
              />
            )}
            <div>
              <h2>
                {purpose ? "Confirm PIN reset" : "Connect cloud services"}
              </h2>
              <p>
                Scan the QR code with your phone, or open this address and enter
                the code:
              </p>
              <a
                href={grant.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                {grant.verificationUri}
              </a>
              <p
                className="device-pairing__code"
                aria-label={`Pairing code ${grant.userCode}`}
              >
                {grant.userCode}
              </p>
              <p className="settings-note">
                Expires in {Math.floor(remaining / 60)}:
                {String(remaining % 60).padStart(2, "0")} · Waiting for your
                confirmation
              </p>
              <a
                className="button button--secondary"
                href={grant.verificationUriComplete}
                target="_blank"
                rel="noopener noreferrer"
              >
                Sign in on this device
              </a>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setOutcome("cancelled");
                  setGrant(null);
                  setMessage("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {allowCloud && (
          <p className="settings-note">
            {purpose
              ? "Approve only the PIN reset you requested. The verification must use this profile's account owner."
              : "Sign in with Google or an e-mail code on your phone when using a TV. Confirm only devices you recognize."}
          </p>
        )}
        {!purpose &&
          allowLocal &&
          api.startLocalSession &&
          !adoptLocalAccount && (
            <div className="account-login__local-option">
              <button
                className="button button--secondary"
                type="button"
                disabled={startingLocal}
                onClick={() => void local()}
              >
                Create a household
              </button>
              {onRestoreBackup && (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={startingLocal}
                  onClick={() => void local(undefined, true)}
                >
                  Import a backup
                </button>
              )}
              <p className="settings-note account-login__local-note">
                Your household and its profiles stay on this home server. Cloud
                services can be connected or disconnected later.
              </p>
            </div>
          )}
        {onCancel && (
          <button
            className="button button--ghost"
            type="button"
            onClick={onCancel}
          >
            Back
          </button>
        )}
      </section>
    </main>
  );
}
