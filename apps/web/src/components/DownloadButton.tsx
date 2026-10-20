import type { CSSProperties } from "react";

export function DownloadGlyph({ checked = false }: { checked?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v11m-4-4 4 4 4-4M4 18v3h16v-3" />
      {checked && (
        <path className="download-glyph__check" d="m15.5 5 2 2 3.5-4" />
      )}
    </svg>
  );
}

export function TrashGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 4v5m4-5v5" />
    </svg>
  );
}

export function DownloadButton({
  state,
  progress,
  label,
  onClick,
  compact = false,
  deletable = false,
  disabled = false,
  retry = false,
  stopLabel = "Cancel",
  className = "",
  pending = false,
  multiFile = false,
  multiFileCount = 3,
  preparing = false,
  showCompleteCheck = true,
}: {
  state: "idle" | "downloading" | "complete";
  progress: number | null;
  label: string;
  onClick: () => void;
  compact?: boolean;
  deletable?: boolean;
  disabled?: boolean;
  retry?: boolean;
  stopLabel?: string;
  className?: string;
  pending?: boolean;
  multiFile?: boolean;
  multiFileCount?: 2 | 3;
  preparing?: boolean;
  showCompleteCheck?: boolean;
}) {
  const percentage = Math.max(0, Math.min(100, progress ?? 0));
  const deleting = state === "complete" && deletable;
  const checking = preparing && state === "downloading";
  return (
    <button
      className={`download-button download-button--${state}${deleting ? " download-button--deletable" : ""}${compact ? " download-button--compact" : ""}${state === "downloading" && (progress === null || checking) ? " download-button--indeterminate" : ""}${checking ? " download-button--preparing" : ""}${pending ? " download-button--pending" : ""}${className ? ` ${className}` : ""}`}
      type="button"
      disabled={disabled || pending}
      aria-busy={pending || checking || undefined}
      aria-label={
        pending
          ? `Stopping ${label}`
          : checking
            ? `Checking episode availability for ${label}. Click to cancel preparation`
            : state === "downloading"
              ? `${stopLabel} ${label}`
              : state === "complete"
                ? deleting
                  ? `Delete saved offline copy of ${label}`
                  : `Download ${label} again`
                : `${retry ? "Retry" : "Download"} ${label}`
      }
      title={
        pending
          ? "Waiting for download to stop"
          : checking
            ? "Checking episode availability · click to cancel"
            : state === "downloading"
              ? `${stopLabel} download${progress === null ? "" : ` · ${Math.round(percentage)}%`}`
              : state === "complete"
                ? deleting
                  ? "Delete saved offline copy"
                  : "Saved offline"
                : retry
                  ? "Download remaining episodes"
                  : "Save offline"
      }
      style={{ "--download-progress": `${percentage}%` } as CSSProperties}
      onClick={onClick}
    >
      {state === "downloading" ? (
        <>
          <span className="download-button__ring" aria-hidden="true" />
          {checking ? (
            <DownloadGlyph />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
            </svg>
          )}
        </>
      ) : deleting ? (
        <TrashGlyph />
      ) : (
        <DownloadGlyph checked={state === "complete" && showCompleteCheck} />
      )}
      {multiFile && (
        <span className="download-button__multifile" aria-hidden="true">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {multiFileCount === 2 ? (
              <>
                <rect x="4.5" y="3.5" width="9" height="10" rx="1.2" />
                <rect x="8.5" y="5.5" width="9" height="10" rx="1.2" />
              </>
            ) : (
              <>
                <rect x="1.5" y="2.5" width="9" height="10" rx="1.2" />
                <rect x="5.5" y="4.5" width="9" height="10" rx="1.2" />
                <rect x="9.5" y="6.5" width="9" height="10" rx="1.2" />
              </>
            )}
          </svg>
        </span>
      )}
    </button>
  );
}
