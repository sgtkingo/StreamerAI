import { useEffect, useState } from "react";
import type { AccountOverview, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { DigitSlotsInput } from "./DigitSlotsInput";
import { useToasts } from "./ToastProvider";
import { InfoTip } from "./InfoTip";

export function AccountSecurity({ api }: { api: StreamerApi }) {
  const [account, setAccount] = useState<AccountOverview | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void api
        .getAccount?.()
        .then((value) => {
          if (active) setAccount(value);
        })
        .catch((reason) => {
          if (active) setError(safeErrorMessage(reason));
        });
    refresh();
    window.addEventListener("streamer:household-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("streamer:household-changed", refresh);
    };
  }, [api]);

  return (
    <section className="profile-page__section" id="account-security">
      <p className="eyebrow">Account protection</p>
      <h2>Security</h2>
      <section
        className="account-security__subsection"
        aria-labelledby="account-master-pin-title"
      >
        <h3 id="account-master-pin-title">Master PIN</h3>
        <p>
          Your 8-digit Master PIN unlocks any profile and encrypts household
          backups.
        </p>
        <p className="settings-note">
          Older backups still require the PIN that protected them.
        </p>
        {api.changeMasterPin && (
          <>
            <div className="deployment-actions">
              <button
                className="button button--secondary"
                type="button"
                aria-expanded={changeOpen}
                onClick={() => {
                  if (changeOpen) {
                    setCurrentPin("");
                    setNewPin("");
                    setConfirmation("");
                  }
                  setChangeOpen((open) => !open);
                  setError("");
                }}
              >
                Change Master PIN
              </button>
              {account?.account.cloudLinked && account.manageUrl && (
                <span>
                  <a href="/admin/recover">Forgot PIN?</a>{" "}
                  <InfoTip label="How to recover your Master PIN">
                    Sign in with the cloud account connected to this household
                    to reset its Master PIN on this server. Existing backups
                    still require their original PIN.
                  </InfoTip>
                </span>
              )}
            </div>
            {changeOpen && (
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    pending ||
                    !/^\d{8}$/.test(currentPin) ||
                    !/^\d{8}$/.test(newPin) ||
                    newPin !== confirmation
                  )
                    return;
                  setPending(true);
                  setError("");
                  void api.changeMasterPin!(currentPin, newPin, confirmation)
                    .then(() => {
                      setCurrentPin("");
                      setNewPin("");
                      setConfirmation("");
                      setChangeOpen(false);
                      showToast(
                        "Master PIN changed. New backups will use the new PIN.",
                        "success",
                      );
                    })
                    .catch((reason) => setError(safeErrorMessage(reason)))
                    .finally(() => setPending(false));
                }}
              >
                <DigitSlotsInput
                  label="Current Master PIN"
                  value={currentPin}
                  onChange={setCurrentPin}
                  disabled={pending}
                />
                <DigitSlotsInput
                  label="New Master PIN"
                  value={newPin}
                  onChange={setNewPin}
                  disabled={pending}
                />
                <DigitSlotsInput
                  label="Confirm new Master PIN"
                  value={confirmation}
                  onChange={setConfirmation}
                  disabled={pending}
                />
                {confirmation.length === 8 && confirmation !== newPin && (
                  <p className="profile-pin-match profile-pin-match--mismatch">
                    The PINs do not match.
                  </p>
                )}
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={
                    pending ||
                    !/^\d{8}$/.test(currentPin) ||
                    !/^\d{8}$/.test(newPin) ||
                    confirmation !== newPin
                  }
                >
                  Save Master PIN
                </button>
              </form>
            )}
          </>
        )}
        {account?.account.cloudLinked === false && (
          <p className="settings-note">
            If you forget the Master PIN for a local account, it cannot be
            recovered.
          </p>
        )}
        {error && (
          <p className="account-inline-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </section>
  );
}
