import { useEffect, useRef, useState } from "react";
import { UpdateSaveError, useUpdateSave, useUpdatePending } from "./updateSave";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type { ProfilePinResetRequest, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { PinPad } from "./PinPad";
import { DigitSlotsInput } from "./DigitSlotsInput";
import { useToasts } from "./ToastProvider";
import { MasterPinDialog } from "./MasterPinDialog";

function useOwnerReset(api: StreamerApi) {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let active = true;
    if (
      api.requestProfilePinReset &&
      api.pollProfilePinReset &&
      api.getAuthStatus
    ) {
      void api
        .getAuthStatus()
        .then((status) => {
          if (active) setSupported(status.ownerResetAvailable === true);
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
  purpose = "reset",
}: {
  api: StreamerApi;
  profile: ViewerProfile;
  onReset: () => void | Promise<void>;
  onCancel: () => void;
  purpose?: "reset" | "unlock" | "change";
}) {
  const [error, setError] = useState("");
  const [request, setRequest] = useState<ProfilePinResetRequest | null>(null);
  const [outcome, setOutcome] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [approved, setApproved] = useState(false);
  const callback = useRef(onReset);
  callback.current = onReset;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setError("");
    setRequest(null);
    setOutcome("");
    setApproved(false);
    const poll = async (grant: ProfilePinResetRequest) => {
      if (!active) return;
      if (Date.parse(grant.expiresAt) <= Date.now()) {
        setOutcome("This request has expired.");
        return;
      }
      try {
        const response = await api.pollProfilePinReset!(profile.id, grant.id);
        if (!active) return;
        setError("");
        if (response.status === "approved") {
          setApproved(true);
          try {
            if (purpose === "reset") await api.setProfilePin!(profile.id, null);
            if (active) await callback.current();
          } catch (reason) {
            if (active) setError(safeErrorMessage(reason));
          }
          return;
        }
        if (response.status === "denied" || response.status === "expired") {
          setOutcome(
            response.status === "denied"
              ? "This request was declined."
              : "This request has expired.",
          );
          return;
        }
      } catch (reason) {
        if (active) setError(safeErrorMessage(reason));
      }
      if (active) timer = setTimeout(() => void poll(grant), 5000);
    };
    void api.requestProfilePinReset!(profile.id, purpose)
      .then((grant) => {
        if (!active) return;
        setRequest(grant);
        timer = setTimeout(() => void poll(grant), 5000);
      })
      .catch((reason) => {
        if (active) setError(safeErrorMessage(reason));
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, profile.id, attempt, purpose]);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, [request]);
  return (
    <div
      ref={dialogRef}
      className="profile-pin-recovery"
      role="dialog"
      aria-modal="true"
      aria-label={
        purpose === "reset"
          ? "Reset profile PIN"
          : "Request household owner approval"
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              "a[href], button:not(:disabled)",
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
      <h2>
        {purpose === "reset"
          ? "Reset profile PIN"
          : "Waiting for owner approval"}
      </h2>
      <p>
        Ask the household owner to confirm{" "}
        {purpose === "unlock"
          ? "profile access"
          : purpose === "change"
            ? "a PIN change"
            : "the reset"}{" "}
        for {profile.name} in household administration on this server.
        {purpose === "reset" && " Approval removes the current profile PIN."}
      </p>
      {request ? (
        <>
          <a
            className="button button--primary"
            href={request.manageUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open household administration
          </a>
          <p role="status">
            {outcome || "Waiting for household owner confirmation…"}
          </p>
        </>
      ) : (
        !error && <p role="status">Sending request…</p>
      )}
      {error && <p role="alert">{error}</p>}
      {(outcome || error) && (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            if (approved) {
              setError("");
              void Promise.resolve(
                purpose === "reset"
                  ? api.setProfilePin!(profile.id, null)
                  : undefined,
              )
                .then(() => callback.current())
                .catch((reason) => setError(safeErrorMessage(reason)));
            } else setAttempt((value) => value + 1);
          }}
        >
          Try again
        </button>
      )}
      <button className="text-button" type="button" onClick={onCancel}>
        Cancel
      </button>
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
  const [useMaster, setUseMaster] = useState(false);
  const [hasMaster, setHasMaster] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .getAuthStatus?.()
      .then((status) => {
        if (active) {
          setHasMaster(!!status.masterPinEnabled);
        }
      })
      .catch(() => {
        if (active) setUseMaster(false);
      });
    if (!api.getAuthStatus) setUseMaster(false);
    return () => {
      active = false;
    };
  }, [api]);
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
    if (
      submitting.current ||
      !api.unlockProfile ||
      !(useMaster ? /^\d{8}$/ : /^\d{4}$/).test(value)
    )
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
          purpose="reset"
        />
      </div>
    );
  if (useMaster)
    return (
      <MasterPinDialog
        onSubmit={async (value) => {
          await api.unlockProfile!(profile.id, value);
          await onUnlocked();
        }}
        onCancel={() => {
          setUseMaster(false);
          setPin("");
        }}
        onAskOwner={supportsOwnerReset ? () => setRecovering(true) : undefined}
      />
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
          {useMaster
            ? "Enter your Master PIN to continue."
            : "Enter your profile PIN to continue."}
        </p>
        <PinPad
          label={useMaster ? "Master PIN" : "Profile PIN"}
          length={useMaster ? 8 : 4}
          value={pin}
          disabled={pending}
          onChange={(value) => {
            setError("");
            setPin(value);
            if (value.length === (useMaster ? 8 : 4)) void unlock(value);
          }}
        />
        {(hasMaster || supportsOwnerReset) && (
          <button
            type="button"
            className="text-button"
            disabled={pending}
            onClick={() => {
              setUseMaster((value) => !value);
              setPin("");
              setError("");
            }}
          >
            Forgot PIN?
          </button>
        )}
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
        {!hasMaster && !supportsOwnerReset && (
          <p className="settings-note">
            Ask the household owner to reset this profile's PIN in household
            administration.
          </p>
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
  const [useMasterCurrent, setUseMasterCurrent] = useState(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const [ownerApproved, setOwnerApproved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const { showToast } = useToasts();
  const supportsOwnerReset = useOwnerReset(api);
  const save = async (value: string | null, forUpdate = false) => {
    if (
      !api.setProfilePin ||
      pending ||
      (profile.pinEnabled &&
        !ownerApproved &&
        !/^(?:\d{4}|\d{8})$/.test(currentPin))
    ) {
      if (forUpdate)
        throw new UpdateSaveError(
          "Enter the current profile PIN before updating.",
        );
      return;
    }
    setPending(true);
    setError("");
    try {
      const wasEnabled = profile.pinEnabled;
      const result = await api.setProfilePin(
        profile.id,
        value,
        currentPin || undefined,
      );
      onProfileUpdated({ ...profile, pinEnabled: result.pinEnabled });
      setPin("");
      setConfirmation("");
      setCurrentPin("");
      setOwnerApproved(false);
      setUseMasterCurrent(false);
      showToast(
        value
          ? wasEnabled
            ? "Profile PIN changed."
            : "Profile PIN saved."
          : "Profile PIN removed.",
        "success",
      );
    } catch (reason) {
      setError(safeErrorMessage(reason));
      if (forUpdate) throw reason;
    } finally {
      setPending(false);
    }
  };
  useUpdatePending(pending);
  useUpdateSave(Boolean(pin || confirmation || currentPin), async () => {
    if (!/^\d{4}$/.test(pin) || confirmation !== pin)
      throw new UpdateSaveError(
        "Complete both matching 4-digit profile PINs before updating.",
      );
    await save(pin, true);
  });
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
          ? "Enter the current 4-digit profile PIN or 8-digit Master PIN to change or remove it."
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
          <>
            {!useMasterCurrent && !ownerApproved && (
              <DigitSlotsInput
                label="Current profile PIN"
                value={currentPin}
                onChange={setCurrentPin}
                className="field--compact"
                length={4}
                disabled={pending}
              />
            )}
            {(useMasterCurrent || ownerApproved) && (
              <p role="status">
                {ownerApproved
                  ? "Household owner approved a PIN change."
                  : "Master PIN entered. Save to verify it."}
              </p>
            )}
            <button
              className="text-button profile-pin-method"
              type="button"
              disabled={pending}
              onClick={() => {
                if (useMasterCurrent || ownerApproved) {
                  setUseMasterCurrent(false);
                  setOwnerApproved(false);
                  setCurrentPin("");
                } else setMasterOpen(true);
                setError("");
              }}
            >
              {useMasterCurrent || ownerApproved
                ? "Use profile PIN instead"
                : "Forgot PIN?"}
            </button>
          </>
        )}
        <DigitSlotsInput
          label="New PIN (4 digits)"
          value={pin}
          onChange={setPin}
          className="field--compact"
          length={4}
          autoComplete="new-password"
          disabled={pending}
        />
        <DigitSlotsInput
          label="Confirm new PIN"
          value={confirmation}
          onChange={setConfirmation}
          className="field--compact"
          length={4}
          autoComplete="new-password"
          disabled={pending}
        />
        {confirmation && (
          <p
            className={`profile-pin-match ${
              confirmation === pin
                ? "profile-pin-match--match"
                : "profile-pin-match--mismatch"
            }`}
            role="status"
          >
            {confirmation === pin
              ? "The PINs match."
              : "The PINs do not match."}
          </p>
        )}
        {error && (
          <p className="account-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="profile-page__actions">
          <button
            className="button button--secondary"
            type="submit"
            disabled={
              pending ||
              !/^\d{4}$/.test(pin) ||
              confirmation !== pin ||
              (!!profile.pinEnabled &&
                !ownerApproved &&
                !/^(?:\d{4}|\d{8})$/.test(currentPin))
            }
          >
            {pending ? "Saving…" : "Save PIN"}
          </button>
          {profile.pinEnabled && (
            <button
              className="button button--ghost"
              type="button"
              disabled={
                pending ||
                (!ownerApproved && !/^(?:\d{4}|\d{8})$/.test(currentPin))
              }
              onClick={() => void save(null)}
            >
              Remove PIN
            </button>
          )}
        </div>
      </form>
      {masterOpen && (
        <MasterPinDialog
          onSubmit={(value) => {
            setCurrentPin(value);
            setUseMasterCurrent(true);
            setOwnerApproved(false);
            setMasterOpen(false);
          }}
          onCancel={() => setMasterOpen(false)}
          onAskOwner={
            supportsOwnerReset
              ? () => {
                  setMasterOpen(false);
                  setRecovering(true);
                }
              : undefined
          }
        />
      )}
      {recovering && (
        <div className="profile-chooser__overlay">
          <ProfilePinRecovery
            api={api}
            profile={profile}
            onCancel={() => setRecovering(false)}
            purpose="reset"
            onReset={() => {
              setRecovering(false);
              setCurrentPin("");
              setOwnerApproved(false);
              setUseMasterCurrent(false);
              setPin("");
              setConfirmation("");
              onProfileUpdated({ ...profile, pinEnabled: false });
              showToast("Profile PIN removed.", "success");
            }}
          />
        </div>
      )}
    </section>
  );
}
