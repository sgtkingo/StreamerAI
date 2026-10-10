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

export function DownloadButton({
  state,
  progress,
  label,
  onClick,
  compact = false,
}: {
  state: "idle" | "downloading" | "complete";
  progress: number | null;
  label: string;
  onClick: () => void;
  compact?: boolean;
}) {
  const percentage = Math.max(0, Math.min(100, progress ?? 0));
  return (
    <button
      className={`download-button download-button--${state}${compact ? " download-button--compact" : ""}${state === "downloading" && progress === null ? " download-button--indeterminate" : ""}`}
      type="button"
      aria-label={
        state === "downloading"
          ? `Cancel ${label}`
          : state === "complete"
            ? `Download ${label} again`
            : `Download ${label}`
      }
      title={
        state === "downloading"
          ? `Cancel download${progress === null ? "" : ` · ${percentage}%`}`
          : state === "complete"
            ? "Saved offline · download again"
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
        <DownloadGlyph checked={state === "complete"} />
      )}
    </button>
  );
}
