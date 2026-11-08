import { useState } from "react";
import { safeErrorMessage } from "../api/client";
import { DigitSlotsInput } from "./DigitSlotsInput";

export function MasterPinSetup({
  onSave,
  title = "Choose your Master PIN",
  description,
}: {
  onSave: (pin: string) => Promise<void>;
  title?: string;
  description?: string;
}) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="account-login__card">
      <p className="eyebrow">Account security</p>
      <h1>{title}</h1>
      <p>
        {description ?? (
          <>
            Use 8 digits to unlock any profile and encrypt local backups. Keep
            it somewhere safe: you need the current PIN to change it, and a
            forgotten local account PIN cannot be recovered.
          </>
        )}
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending || !/^\d{8}$/.test(pin) || pin !== confirmation) return;
          setPending(true);
          setError("");
          void onSave(pin)
            .catch((reason) => setError(safeErrorMessage(reason)))
            .finally(() => setPending(false));
        }}
      >
        <DigitSlotsInput
          label="Master PIN (8 digits)"
          value={pin}
          onChange={setPin}
          autoComplete="new-password"
          disabled={pending}
        />
        <DigitSlotsInput
          label="Confirm Master PIN"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
          disabled={pending}
        />
        {confirmation && confirmation !== pin && (
          <p className="settings-note">The PINs must match.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <button
          className="button button--primary"
          type="submit"
          disabled={pending || !/^\d{8}$/.test(pin) || pin !== confirmation}
        >
          {pending ? "Saving…" : "Save Master PIN"}
        </button>
      </form>
    </section>
  );
}
