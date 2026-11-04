import type { ProfileDraft } from "../../api/client";
import { useState } from "react";
import { PinPad } from "../PinPad";
import { StatusBadge } from "./StatusBadge";

interface FinishStepProps {
  profile: ProfileDraft;
  services: string[];
  localAiEnabled: boolean;
  error: string;
  pinAvailable: boolean;
  pinRequested: boolean;
  onPinRequestedChange: (requested: boolean) => void;
  pin: string;
  onPinChange: (pin: string) => void;
  pinConfirmation: string;
  onPinConfirmationChange: (pin: string) => void;
  disabled: boolean;
}

export function FinishStep({
  profile,
  services,
  localAiEnabled,
  error,
  pinAvailable,
  pinRequested,
  onPinRequestedChange,
  pin,
  onPinChange,
  pinConfirmation,
  onPinConfirmationChange,
  disabled,
}: FinishStepProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="step-copy step-copy--finish">
      <p className="eyebrow">Ready for the first frame</p>
      <h1 tabIndex={-1}>
        Welcome home{profile.name ? `, ${profile.name}` : ""}.
      </h1>
      <p className="step-lead">Your private cinema is ready to explore.</p>

      <dl className="setup-summary">
        <div>
          <dt>Profile</dt>
          <dd>
            {profile.name || "Local viewer"} · {profile.locale.toUpperCase()}
          </dd>
          <StatusBadge status="success" label="Ready" />
        </div>
        <div>
          <dt>Services</dt>
          <dd>
            {services.length
              ? services.join(", ")
              : "Connect later in Settings"}
          </dd>
          <StatusBadge
            status={services.length ? "success" : "idle"}
            label={services.length ? "Ready" : "Optional"}
          />
        </div>
        <div>
          <dt>AI agent</dt>
          <dd>{localAiEnabled ? "Agent selected" : "Optional for now"}</dd>
          <StatusBadge
            status={localAiEnabled ? "success" : "idle"}
            label={localAiEnabled ? "Ready" : "Optional"}
          />
        </div>
      </dl>

      {pinAvailable && (
        <section className="pin-setup" aria-labelledby="setup-pin-title">
          <h2 id="setup-pin-title">Protect your profile</h2>
          <p>Keep your profile personal with a four-digit PIN.</p>
          <label className="pin-setup__choice">
            <input
              type="checkbox"
              checked={pinRequested}
              disabled={disabled}
              onChange={(event) => {
                onPinRequestedChange(event.target.checked);
                if (!event.target.checked) {
                  setConfirming(false);
                  onPinChange("");
                  onPinConfirmationChange("");
                }
              }}
            />
            <span>Add a PIN to this profile</span>
          </label>
          {pinRequested && (
            <>
              <PinPad
                label={
                  confirming ? "Confirm profile PIN" : "Choose a 4-digit PIN"
                }
                value={confirming ? pinConfirmation : pin}
                disabled={disabled}
                onChange={(value) => {
                  if (confirming) onPinConfirmationChange(value);
                  else {
                    onPinChange(value);
                    if (value.length === 4) setConfirming(true);
                  }
                }}
              />
              {confirming && (
                <>
                  <p
                    className={`pin-setup__feedback${pinConfirmation.length === 4 ? (pinConfirmation === pin ? " is-success" : " is-error") : ""}`}
                    aria-live="polite"
                  >
                    {pinConfirmation.length < 4
                      ? "Enter the same PIN again."
                      : pinConfirmation === pin
                        ? "PIN confirmed."
                        : "The PINs do not match. Try again."}
                  </p>
                  <button
                    className="text-button"
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setConfirming(false);
                      onPinChange("");
                      onPinConfirmationChange("");
                    }}
                  >
                    Choose a different PIN
                  </button>
                </>
              )}
            </>
          )}
          <p className="pin-setup__feedback">
            You can change or remove it later in Settings.
          </p>
        </section>
      )}
      {error && (
        <p className="inline-message inline-message--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
