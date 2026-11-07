import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeviceAuthorization,
  DeviceAuthorizationInput,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
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
  recoveredLocalAccounts?: { id: string }[];
  adoptLocalAccount?: boolean;
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
  recoveredLocalAccounts = [],
  adoptLocalAccount = false,
}: AccountLoginProps) {
  const [grant, setGrant] = useState<DeviceAuthorization | null>(null);
  const [starting, setStarting] = useState(false);
  const [startingLocal, setStartingLocal] = useState(false);
  const [chooseLocal, setChooseLocal] = useState(false);
  const [needsMasterPin, setNeedsMasterPin] = useState(false);
  const [localAccountId, setLocalAccountId] = useState("");
  const [message, setMessage] = useState("");
  const [messageSource, setMessageSource] = useState<
    "pairing" | "local" | null
  >(null);
  const [outcome, setOutcome] = useState<
    "expired" | "denied" | "cancelled" | null
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
        purpose ?? (adoptLocalAccount ? { adoptLocalAccount } : undefined),
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
  }, [api, purpose, adoptLocalAccount]);

  useEffect(() => {
    if (!allowLocal && !purpose && !error && !started.current) {
      started.current = true;
      void start();
    }
  }, [allowLocal, purpose, error, start]);

  const local = async (masterPin?: string) => {
    if (startingLocal || !api.startLocalSession) return;
    requestId.current++;
    setGrant(null);
    setOutcome("cancelled");
    setStartingLocal(true);
    setMessage("");
    setMessageSource(null);
    try {
      if (masterPin)
        await api.startLocalSession(localAccountId || undefined, masterPin);
      else await api.startLocalSession(localAccountId || undefined);
      callback.current();
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

  const showLocalAccounts = () => {
    requestId.current++;
    setGrant(null);
    setOutcome("cancelled");
    setMessage("");
    setMessageSource(null);
    setChooseLocal(true);
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
            await api.startLocalSession(localAccountId || undefined, pin);
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
          {purpose ? "Reset this profile's PIN" : "Welcome to StreamerAI."}
        </h1>
        <p>
          {purpose
            ? "Sign in to the StreamerAI account that owns this profile to remove its PIN. You can then choose a new PIN."
            : "Use StreamerAI with a local household, or sign in to keep your profiles and watch progress in sync across home installations."}
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
                    ? "Unable to open local account"
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
        ) : !grant || outcome ? (
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
              {outcome === "denied" || outcome === "expired"
                ? "Get a new code"
                : purpose
                  ? "Verify account"
                  : "Connect this device"}
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
              <h2>{purpose ? "Confirm PIN reset" : "Connect this device"}</h2>
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
        <p className="settings-note">
          {purpose
            ? "Approve only the PIN reset you requested. The verification must use this profile's account owner."
            : "Sign in with Google or an e-mail code on your phone when using a TV. Confirm only devices you recognize."}
        </p>
        {!purpose &&
          allowLocal &&
          api.startLocalSession &&
          !adoptLocalAccount && (
            <div className="account-login__local-option">
              {chooseLocal && recoveredLocalAccounts.length > 0 && (
                <label>
                  Local account
                  <select
                    value={localAccountId}
                    onChange={(event) => setLocalAccountId(event.target.value)}
                  >
                    <option value="">Existing local household</option>
                    {recoveredLocalAccounts.map((account, index) => (
                      <option key={account.id} value={account.id}>
                        Account converted to local {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="account-login__local"
                type="button"
                disabled={startingLocal}
                onClick={() =>
                  recoveredLocalAccounts.length && !chooseLocal
                    ? showLocalAccounts()
                    : void local()
                }
              >
                {chooseLocal
                  ? "Continue with selected local account"
                  : "Prefer to continue without signing in, with a local account?"}
              </button>
              <p className="settings-note account-login__local-note">
                No account required. Profiles and watch progress stay on this
                home server. You can connect an online account later.
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
