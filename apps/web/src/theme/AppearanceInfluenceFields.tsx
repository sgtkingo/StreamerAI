import { useId } from "react";
import {
  DAYLIGHT_OVERRIDES,
  WEATHER_OVERRIDES,
  type DaylightOverride,
  type WeatherOverride,
} from "@streamer-ai/contracts";

const copy = {
  en: {
    weather: "Weather influence",
    lighting: "Lighting",
    auto: "Automatic",
    local: "Automatic (local weather)",
    clear: "Clear",
    cloudy: "Cloudy",
    fog: "Fog",
    rain: "Rain",
    snow: "Snow",
    storm: "Storm",
    day: "Day",
    night: "Night",
  },
  cs: {
    weather: "Vliv počasí",
    lighting: "Denní doba",
    auto: "Automaticky",
    local: "Automaticky (místní počasí)",
    clear: "Jasno",
    cloudy: "Zataženo",
    fog: "Mlha",
    rain: "Déšť",
    snow: "Sníh",
    storm: "Bouřka",
    day: "Den",
    night: "Noc",
  },
  de: {
    weather: "Wettereinfluss",
    lighting: "Tageszeit",
    auto: "Automatisch",
    local: "Automatisch (lokales Wetter)",
    clear: "Klar",
    cloudy: "Bewölkt",
    fog: "Nebel",
    rain: "Regen",
    snow: "Schnee",
    storm: "Gewitter",
    day: "Tag",
    night: "Nacht",
  },
};

export function AppearanceInfluenceFields({
  weather,
  daylight,
  onWeatherChange,
  onDaylightChange,
  locale = "en",
  disabled = false,
}: {
  weather: WeatherOverride;
  daylight: DaylightOverride;
  onWeatherChange: (weather: WeatherOverride) => void;
  onDaylightChange: (daylight: DaylightOverride) => void;
  locale?: "en" | "cs" | "de";
  disabled?: boolean;
}) {
  const id = useId();
  const text = copy[locale];
  return (
    <>
      <label className="theme-select" htmlFor={`${id}-weather`}>
        <span>{text.weather}</span>
        <select
          id={`${id}-weather`}
          value={weather}
          disabled={disabled}
          onChange={(event) =>
            onWeatherChange(event.target.value as WeatherOverride)
          }
        >
          {WEATHER_OVERRIDES.map((value) => (
            <option key={value} value={value}>
              {value === "auto" ? text.local : text[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="theme-select" htmlFor={`${id}-daylight`}>
        <span>{text.lighting}</span>
        <select
          id={`${id}-daylight`}
          value={daylight}
          disabled={disabled}
          onChange={(event) =>
            onDaylightChange(event.target.value as DaylightOverride)
          }
        >
          {DAYLIGHT_OVERRIDES.map((value) => (
            <option key={value} value={value}>
              {text[value]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
