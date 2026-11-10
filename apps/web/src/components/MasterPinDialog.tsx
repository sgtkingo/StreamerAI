import { useEffect, useRef, useState } from "react";
import { safeErrorMessage } from "../api/client";
import { PinPad } from "./PinPad";

export function MasterPinDialog({
  onSubmit,
  onCancel,
  onAskOwner,
  askOwnerLabel = "Ask household owner for PIN reset",
  title = "Enter your Master PIN",
  description = "Enter the 8-digit Master PIN for this household.",
}: {
  onSubmit: (pin: string) => void | Promise<void>;
  onCancel: () => void;
  onAskOwner?: () => void;
  askOwnerLabel?: string;
  title?: string;
  description?: string;
}) {
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector("input")?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (error && !pending) dialog.current?.querySelector("input")?.focus();
  }, [error, pending]);
  const submit = async (value: string) => {
    if (running.current || !/^\d{8}$/.test(value)) return;
    running.current = true;
    setPending(true);
    setError("");
    try {
      await onSubmit(value);
    } catch (reason) {
      setError(safeErrorMessage(reason));
      setPin("");
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return (
    <div className="profile-chooser__overlay">
      <div
        ref={dialog}
        className="profile-pin-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) onCancel();
          if (event.key === "Tab") {
            const controls = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                "input:not(:disabled), button:not(:disabled), a[href]",
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
        <p className="profile-pin-card__eyebrow">Household access</p>
        <h2>{title}</h2>
        <p className="profile-pin-card__intro">{description}</p>
        <PinPad
          label="Master PIN"
          length={8}
          value={pin}
          disabled={pending}
          onChange={(value) => {
            setError("");
            setPin(value);
            if (value.length === 8) void submit(value);
          }}
        />
        {error && (
          <p className="profile-pin-card__error" role="alert">
            {error}
          </p>
        )}
        {pending && <p role="status">Checking…</p>}
        {onAskOwner && (
          <button
            type="button"
            className="text-button"
            disabled={pending}
            onClick={onAskOwner}
          >
            {askOwnerLabel}
          </button>
        )}
        <div className="profile-pin-card__footer">
          <button
            type="button"
            className="text-button"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
