import { useEffect, useRef, useState } from "react";
import { useToasts } from "./ToastProvider";

export function AccountId({
  value,
  label = "Account ID",
}: {
  value: string | null;
  label?: "Account ID" | "Household ID";
}) {
  const [copied, setCopied] = useState(false);
  const identifier = label === "Household ID" ? "household ID" : "account ID";
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast } = useToasts();
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <div className="account-uid">
      <span>{label}:</span>
      <code>{value ?? "Unavailable"}</code>
      {value && (
        <button
          className="button button--secondary copy-uid"
          type="button"
          aria-label={`Copy ${identifier}`}
          title={copied ? `${label} copied` : `Copy ${identifier}`}
          data-copied={copied}
          onClick={async () => {
            if (resetTimer.current) clearTimeout(resetTimer.current);
            setCopied(false);
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              resetTimer.current = setTimeout(() => setCopied(false), 2000);
            } catch {
              showToast(
                `Select the ${identifier} and copy it manually.`,
                "error",
              );
            }
          }}
        >
          <svg
            className="copy-uid__copy"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
          <svg
            className="copy-uid__check"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 12 4.5 4.5L19 7" />
          </svg>
        </button>
      )}
      <span className="copy-uid-status" role="status" aria-live="polite">
        {copied ? `${label} copied.` : ""}
      </span>
    </div>
  );
}
