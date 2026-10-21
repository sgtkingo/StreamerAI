import { useId } from "react";
import {
  THEME_MODES,
  SEASONAL_THEME_MODES,
  type ThemeMode,
} from "@streamer-ai/contracts";

const labels = {
  en: {
    label: "Theme",
    auto: "Seasonal",
    cinematic: "Cinematic",
    spring: "Spring",
    summer: "Summer",
    autumn: "Autumn",
    winter: "Winter",
    christmas: "Christmas",
    "new-year": "New Year's Eve",
  },
  cs: {
    label: "Téma",
    auto: "Sezónní",
    cinematic: "Cinematic",
    spring: "Jaro",
    summer: "Léto",
    autumn: "Podzim",
    winter: "Zima",
    christmas: "Vánoce",
    "new-year": "Silvestr",
  },
  de: {
    label: "Design",
    auto: "Saisonal",
    cinematic: "Cinematic",
    spring: "Frühling",
    summer: "Sommer",
    autumn: "Herbst",
    winter: "Winter",
    christmas: "Weihnachten",
    "new-year": "Silvester",
  },
};

export function ThemeSelect({
  value,
  onChange,
  locale = "en",
  compact = false,
  disabled = false,
  selection = "all",
  label,
}: {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
  locale?: "en" | "cs" | "de";
  compact?: boolean;
  disabled?: boolean;
  selection?: "all" | "primary" | "season";
  label?: string;
}) {
  const id = useId();
  const copy = labels[locale];
  const modes =
    selection === "primary"
      ? (["auto", "cinematic"] as const)
      : selection === "season"
        ? SEASONAL_THEME_MODES
        : THEME_MODES;
  const selected =
    selection === "primary" && value !== "cinematic" ? "auto" : value;
  return (
    <label
      className={`theme-select${compact ? " theme-select--compact" : ""}`}
      htmlFor={id}
    >
      <span>{label ?? copy.label}</span>
      <select
        id={id}
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ThemeMode)}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {selection === "season" && mode === "auto"
              ? locale === "cs"
                ? "Podle kalendáře"
                : locale === "de"
                  ? "Kalender folgen"
                  : "Follow the calendar"
              : copy[mode]}
          </option>
        ))}
      </select>
    </label>
  );
}
