import { useEffect, useRef, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { PinPad } from "./PinPad";

function useOwnerReset(api: StreamerApi) {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let active = true;
    if (api.startDeviceAuthorization && api.getAuthStatus) {
      void api
        .getAuthStatus()
        .then((status) => {
          if (active)
            setSupported(
              status.cloudConfigured &&
                status.authenticated &&
                status.account?.cloudLinked !== false,
            );
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [api]);
  return supported;
}

function ProfilePinRecovery({
  api,
  profile,
  onReset,
  onCancel,
}: {
  api: StreamerApi;
  profile: ViewerProfile;
  onReset: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={dialogRef}
      className="profile-pin-recovery"
      role="dialog"
      aria-modal="true"
      aria-label="Reset profile PIN"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              "a[href], input:not(:disabled), button:not(:disabled)",
            ) ?? [],
          );
          const first = controls[0],
            last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <AccountLogin
        key={attempt}
        compact
        api={api}
        purpose={{ purpose: "pin-reset", profileId: profile.id }}
        error={error}
        onCancel={onCancel}
        onRetry={() => {
          setError("");
          setAttempt((value) => value + 1);
        }}
        onAuthenticated={() => {
          void (async () => {
            try {
              await api.setProfilePin!(profile.id, null);
              await onReset();
            } catch (reason) {
              setError(safeErrorMessage(reason));
            }
          })();
        }}
      />
    </div>
  );
}

export function ProfilePinDialog({
  api,
  profile,
  onUnlocked,
  onCancel,
}: {
  api: StreamerApi;
  profile: ViewerProfile;
  onUnlocked: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const submitting = useRef(false);
  const supportsOwnerReset = useOwnerReset(api);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    formRef.current?.querySelector("input")?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (error && !pending) formRef.current?.querySelector("input")?.focus();
  }, [error, pending]);
  const unlock = async (value: string) => {
    if (submitting.current || !api.unlockProfile || !/^\d{4}$/.test(value))
      return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await api.unlockProfile(profile.id, value);
      await onUnlocked();
    } catch (reason) {
      setError(safeErrorMessage(reason));
      setPin("");
      setPending(false);
      submitting.current = false;
      formRef.current?.querySelector("input")?.focus();
    }
  };
  if (recovering)
    return (
      <div className="profile-chooser__overlay">
        <ProfilePinRecovery
          api={api}
          profile={profile}
          onCancel={() => setRecovering(false)}
          onReset={onUnlocked}
        />
      </div>
    );
  return (
    <div className="profile-chooser__overlay">
      <form
        ref={formRef}
        className="profile-pin-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-pin-title"
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) onCancel();
          if (event.key === "Tab") {
            const controls = Array.from(
              formRef.current?.querySelectorAll<HTMLElement>(
                "input, button:not(:disabled)",
              ) ?? [],
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <p className="profile-pin-card__eyebrow">Profile protected</p>
        <h2 id="profile-pin-title">Welcome back, {profile.name}</h2>
        <p className="profile-pin-card__intro">
          Enter your profile PIN to continue.
        </p>
        <PinPad
          label="Profile PIN"
          value={pin}
          disabled={pending}
          onChange={(value) => {
            setError("");
            setPin(value);
            if (value.length === 4) void unlock(value);
          }}
        />
        {error && (
          <p className="profile-pin-card__error" role="alert">
            {error}
          </p>
        )}
        {pending && (
          <p className="pin-setup__feedback" role="status">
            Unlocking…
          </p>
        )}
        <div className="profile-pin-card__footer">
          <button
            className="text-button"
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
        {supportsOwnerReset && (
          <button
            className="text-button"
            type="button"
            disabled={pending}
            onClick={() => setRecovering(true)}
          >
            Forgot PIN? Verify account
          </button>
        )}
      </form>
    </div>
  );
}

export function ProfilePinSettings({
  api,
  profile,
  onProfileUpdated,
}: {
  api: StreamerApi;
  profile: ViewerProfile;
  onProfileUpdated: (profile: ViewerProfile) => void;
}) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const supportsOwnerReset = useOwnerReset(api);
  const save = async (value: string | null) => {
    if (
      !api.setProfilePin ||
      pending ||
      (profile.pinEnabled && !/^\d{4}$/.test(currentPin))
    )
      return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const result = await api.setProfilePin(
        profile.id,
        value,
        currentPin || undefined,
      );
      onProfileUpdated({ ...profile, pinEnabled: result.pinEnabled });
      setPin("");
      setConfirmation("");
      setCurrentPin("");
      setMessage(value ? "Profile PIN saved." : "Profile PIN removed.");
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  if (!api.setProfilePin) return null;
  return (
    <section className="profile-page__section">
      <p className="eyebrow">Profile privacy</p>
      <h2>Profile PIN</h2>
      <p>
        {profile.pinEnabled
          ? "This profile is protected with a PIN."
          : "Add an optional PIN to protect this profile."}{" "}
        {profile.pinEnabled
          ? "Enter the current PIN to change or remove it."
          : "Choose 4 digits."}
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save(pin);
        }}
      >
        {profile.pinEnabled && (
          <label className="field field--compact">
            <span>Current PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{4}"
              maxLength={4}
              value={currentPin}
              onChange={(event) =>
                setCurrentPin(event.target.value.replace(/\D/g, ""))
              }
            />
          </label>
        )}
        <label className="field field--compact">
          <span>New PIN (4 digits)</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            pattern="[0-9]{4}"
            minLength={4}
            maxLength={4}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          />
        </label>
        <label className="field field--compact">
          <span>Confirm new PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={confirmation}
            onChange={(event) =>
              setConfirmation(event.target.value.replace(/\D/g, ""))
            }
          />
        </label>
        {confirmation && confirmation !== pin && (
          <p className="settings-note">The PINs must match.</p>
        )}
        {error && (
          <p className="account-inline-error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <div className="profile-page__actions">
          <button
            className="button button--secondary"
            type="submit"
            disabled={
              pending ||
              !/^\d{4}$/.test(pin) ||
              confirmation !== pin ||
              (!!profile.pinEnabled && !/^\d{4}$/.test(currentPin))
            }
          >
            {pending ? "Saving…" : "Save PIN"}
          </button>
          {profile.pinEnabled && (
            <button
              className="button button--ghost"
              type="button"
              disabled={pending || !/^\d{4}$/.test(currentPin)}
              onClick={() => void save(null)}
            >
              Remove PIN
            </button>
          )}
        </div>
      </form>
      {profile.pinEnabled && supportsOwnerReset && (
        <button
          className="text-button"
          type="button"
          disabled={pending}
          onClick={() => setRecovering(true)}
        >
          Forgot PIN? Verify account
        </button>
      )}
      {recovering && (
        <div className="profile-chooser__overlay">
          <ProfilePinRecovery
            api={api}
            profile={profile}
            onCancel={() => setRecovering(false)}
            onReset={() => {
              onProfileUpdated({ ...profile, pinEnabled: false });
              setRecovering(false);
              setCurrentPin("");
              setPin("");
              setConfirmation("");
              setMessage(
                "Profile PIN removed. Choose a new PIN when you are ready.",
              );
            }}
          />
        </div>
      )}
    </section>
  );
}
