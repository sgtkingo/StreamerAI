import { useId } from "react";
import "./pin-pad.css";

export function DigitSlotsInput({
  label,
  value,
  onChange,
  disabled = false,
  autoComplete = "off",
  className = "",
  length = 8,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoComplete?: "off" | "new-password" | "one-time-code";
  className?: string;
  length?: 4 | 8;
}) {
  const id = useId();
  return (
    <label className={`field ${className}`.trim()} htmlFor={id}>
      <span>{label}</span>
      <span className={`digit-slots digit-slots--${length}`}>
        <span
          className="digit-slots__cells"
          style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}
          aria-hidden="true"
        >
          {Array.from({ length }, (_, index) => (
            <span
              key={index}
              className={
                index < value.length
                  ? "digit-slots__cell is-filled"
                  : "digit-slots__cell"
              }
            >
              {index < value.length ? "●" : ""}
            </span>
          ))}
        </span>
        <input
          id={id}
          className="digit-slots__input"
          type="password"
          inputMode="numeric"
          autoComplete={autoComplete}
          pattern="[0-9]*"
          maxLength={length}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(event) =>
            onChange(event.target.value.replace(/\D/g, "").slice(0, length))
          }
        />
      </span>
    </label>
  );
}
