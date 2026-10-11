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
}: {
  state: "idle" | "downloading" | "complete";
  progress: number | null;
  label: string;
  onClick: () => void;
  compact?: boolean;
  deletable?: boolean;
  disabled?: boolean;
}) {
  const percentage = Math.max(0, Math.min(100, progress ?? 0));
  const deleting = state === "complete" && deletable;
  return (
    <button
      className={`download-button download-button--${state}${deleting ? " download-button--deletable" : ""}${compact ? " download-button--compact" : ""}${state === "downloading" && progress === null ? " download-button--indeterminate" : ""}`}
      type="button"
      disabled={disabled}
      aria-label={
        state === "downloading"
          ? `Cancel ${label}`
          : state === "complete"
            ? deleting
              ? `Delete saved offline copy of ${label}`
              : `Download ${label} again`
            : `Download ${label}`
      }
      title={
        state === "downloading"
          ? `Cancel download${progress === null ? "" : ` · ${percentage}%`}`
          : state === "complete"
            ? deleting
              ? "Delete saved offline copy"
              : "Saved offline"
            : "Save offline"
      }
      style={{ "--download-progress": `${percentage}%` } as CSSProperties}
      onClick={onClick}
    >
      {state === "downloading" ? (
        <>
          <span className="download-button__ring" aria-hidden="true" />
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
            <rect x="7" y="7" width="10" height="10" rx="1.5" />
          </svg>
        </>
      ) : (
        deleting ? (
          <TrashGlyph />
        ) : (
          <DownloadGlyph checked={state === "complete"} />
        )
      )}
    </button>
  );
}
