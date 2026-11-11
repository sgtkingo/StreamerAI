import { useEffect, useState } from "react";
import type { AccountOverview, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { DigitSlotsInput } from "./DigitSlotsInput";
import { useToasts } from "./ToastProvider";
import { AdminHelp as InfoTip } from "./AdminUI";
import { AdminIcon, AdminNote, AdminStatus } from "./AdminUI";
import { UpdateSaveError, useUpdateSave, useUpdatePending } from "./updateSave";

export function AccountSecurity({
  api,
  masterPinEnabled,
}: {
  api: StreamerApi;
  masterPinEnabled?: boolean;
}) {
  const [account, setAccount] = useState<AccountOverview | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  useUpdatePending(pending);
  const savePin = async () => {
    if (
      !api.changeMasterPin ||
      pending ||
      !/^\d{8}$/.test(currentPin) ||
      !/^\d{8}$/.test(newPin) ||
      newPin !== confirmation
    )
      throw new UpdateSaveError(
        "Complete the current Master PIN and matching new PINs, or close the PIN form, before updating.",
      );
    setPending(true);
    setError("");
    try {
      await api.changeMasterPin(currentPin, newPin, confirmation);
      setCurrentPin("");
      setNewPin("");
      setConfirmation("");
      setChangeOpen(false);
      showToast(
        "Master PIN changed. New backups will use the new PIN.",
        "success",
      );
    } catch (reason) {
      setError(safeErrorMessage(reason));
      throw reason;
    } finally {
      setPending(false);
    }
  };
  useUpdateSave(
    changeOpen && Boolean(currentPin || newPin || confirmation),
    savePin,
  );
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
      <div className="admin-card-heading">
        <h2>Household protection</h2>
        {masterPinEnabled !== undefined && (
          <AdminStatus tone={masterPinEnabled ? "success" : "warning"}>
            {masterPinEnabled ? "Master PIN enabled" : "PIN not configured"}
          </AdminStatus>
        )}
      </div>
      <section
        className="account-security__subsection admin-subsection"
        aria-labelledby="account-master-pin-title"
      >
        <h3 id="account-master-pin-title">
          <AdminIcon name="lock" />
          Master PIN{" "}
          <InfoTip label="What your Master PIN protects">
            This eight-digit code authorizes household administration, can
            unlock profiles and encrypts portable backups. Individual profile
            PINs are managed in Profiles.
          </InfoTip>
        </h3>
        <p>
          Your 8-digit Master PIN unlocks any profile and encrypts household
          backups.
        </p>
        <AdminNote>
          Changing the PIN protects <strong>new backups</strong>. Older backups
          still require the PIN that protected them.
        </AdminNote>
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
                <AdminIcon name="lock" />
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
                className="form-stack admin-pin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    pending ||
                    !/^\d{8}$/.test(currentPin) ||
                    !/^\d{8}$/.test(newPin) ||
                    newPin !== confirmation
                  )
                    return;
                  void savePin().catch(() => undefined);
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
                  {pending ? "Saving PIN…" : "Save Master PIN"}
                </button>
              </form>
            )}
          </>
        )}
        {account?.account.cloudLinked === false && (
          <div className="admin-note admin-note--warning">
            <AdminIcon name="security" />
            <p>
              If you forget the Master PIN for a local account, it cannot be
              recovered.
            </p>
          </div>
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
