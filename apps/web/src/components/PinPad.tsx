import { useId } from "react";
import "./pin-pad.css";

export function PinPad({
  label,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  length = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  length?: 4 | 8;
}) {
  const inputId = useId();
  const update = (next: string) => {
    if (!disabled) onChange(next.replace(/\D/g, "").slice(0, length));
  };
  return (
    <div
      className="pin-pad"
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          update(value + event.key);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          update(value.slice(0, -1));
        }
      }}
    >
      <label className="pin-pad__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="pin-pad__entry">
        <div
          className="pin-pad__slots"
          style={{ gridTemplateColumns: `repeat(${length}, 1fr)` }}
          aria-hidden="true"
        >
          {Array.from({ length }, (_, index) => (
            <span
              key={index}
              className={
                index < value.length
                  ? "pin-pad__slot is-filled"
                  : "pin-pad__slot"
              }
            >
              {index < value.length ? "●" : ""}
            </span>
          ))}
        </div>
        <input
          id={inputId}
          className="pin-pad__input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={label}
          maxLength={length}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => update(event.target.value)}
        />
      </div>
      <div className="pin-pad__keys" role="group" aria-label="PIN keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled || value.length >= length}
            onClick={() => update(value + digit)}
          >
            {digit}
          </button>
        ))}
        <span aria-hidden="true" />
        <button
          type="button"
          disabled={disabled || value.length >= length}
          onClick={() => update(value + "0")}
        >
          0
        </button>
        <button
          className="pin-pad__backspace"
          type="button"
          aria-label="Delete last digit"
          disabled={disabled || !value}
          onClick={() => update(value.slice(0, -1))}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
