import { useId, type ReactNode } from "react";

export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const tooltipId = useId();

  return (
    <span
      className="info-tip"
      tabIndex={0}
      aria-label={label}
      aria-describedby={tooltipId}
    >
      i
      <span
        className="info-tip__tooltip"
        id={tooltipId}
        role="tooltip"
      >
        {children}
      </span>
    </span>
  );
}
