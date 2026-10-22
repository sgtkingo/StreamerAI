import type {
  AppearancePreferences,
  ThemeMode,
  WeatherLocation,
  WeatherSnapshot,
} from "@streamer-ai/contracts";
import type { CSSProperties } from "react";
import { calendarDate, zonedDateParts } from "./clock";
import { lunarPhase } from "./summer-sky";

export type SeasonalTheme = Exclude<ThemeMode, "auto" | "cinematic">;
export type WeatherEffect =
  "none" | "cloudy" | "fog" | "rain" | "snow" | "storm";
export type ThemeMotif =
  | "none"
  | "petals"
  | "bokeh"
  | "leaves"
  | "crystals"
  | "lights"
  | "confetti"
  | "fireworks";
export type ThemeCssVariables = CSSProperties & Record<`--${string}`, string>;

export interface ThemePalette {
  background: string;
  deepBackground: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  accent: string;
  accentHover: string;
  text: string;
  secondaryText: string;
  mutedText: string;
  glow: string;
  particle: string;
}

export interface ResolvedTheme {
  id: SeasonalTheme | "cinematic";
  season: SeasonalTheme | "cinematic";
  period: "day" | "night";
  weatherEffect: WeatherEffect;
  approximateDaylight: boolean;
  palette: ThemePalette;
  motif: ThemeMotif;
  ambientOpacity: number;
  moonPhase: number | null;
  cssVariables: ThemeCssVariables;
}

export const THEME_CALENDAR = {
  christmas: { month: 12, firstDay: 20, lastDay: 30 },
  newYear: ["12-31", "01-01"],
  approximateDay: { startHour: 7, endHour: 19 },
} as const;

interface SeasonalPalette {
  background: string;
  surface: string;
  accent: string;
  glow: string;
  particle: string;
  motif: ThemeMotif;
}

const palettes: Record<SeasonalTheme, SeasonalPalette> = {
  spring: {
    background: "#0c2010",
    surface: "#223d26",
    accent: "#b9ec86",
    glow: "#59a83e",
    particle: "#edc4d6",
    motif: "petals",
  },
  summer: {
    background: "#2a200d",
    surface: "#49391d",
    accent: "#ffe1a0",
    glow: "#d9a542",
    particle: "#ffdc89",
    motif: "bokeh",
  },
  autumn: {
    background: "#1a100e",
    surface: "#32231e",
    accent: "#e6bea0",
    glow: "#9c5435",
    particle: "#c97e47",
    motif: "leaves",
  },
  winter: {
    background: "#0b141e",
    surface: "#1b2a3c",
    accent: "#c5d9ee",
    glow: "#3d6286",
    particle: "#bbd6e9",
    motif: "crystals",
  },
  christmas: {
    background: "#071d12",
    surface: "#173b26",
    accent: "#f1ce82",
    glow: "#c63d4b",
    particle: "#e5b85b",
    motif: "lights",
  },
  "new-year": {
    background: "#10112a",
    surface: "#262044",
    accent: "#f2d393",
    glow: "#9d64d8",
    particle: "#f6cb6b",
    motif: "fireworks",
  },
};

function mix(first: string, second: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const a = Number.parseInt(first.slice(offset, offset + 2), 16);
    const b = Number.parseInt(second.slice(offset, offset + 2), 16);
    return Math.round(a * (1 - amount) + b * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

export function resolveSeason(
  instant: Date,
  timeZone: string,
  latitude: number | null = null,
): SeasonalTheme {
  const { month, day } = zonedDateParts(instant, timeZone);
  if ((month === 12 && day === 31) || (month === 1 && day === 1))
    return "new-year";
  if (
    month === 12 &&
    day >= THEME_CALENDAR.christmas.firstDay &&
    day <= THEME_CALENDAR.christmas.lastDay
  )
    return "christmas";
  const northern: SeasonalTheme =
    month >= 3 && month <= 5
      ? "spring"
      : month >= 6 && month <= 8
        ? "summer"
        : month >= 9 && month <= 11
          ? "autumn"
          : "winter";
  if (latitude === null || latitude >= 0) return northern;
  return {
    spring: "autumn",
    summer: "winter",
    autumn: "spring",
    winter: "summer",
  }[northern] as SeasonalTheme;
}

function resolveDaylight(
  instant: Date,
  timeZone: string,
  weather: WeatherSnapshot | null,
  realNow: Date,
): { period: "day" | "night"; approximateDaylight: boolean } {
  if (weather) {
    const localDate = calendarDate(instant, weather.timezone);
    const solar = weather.solar.find((entry) => entry.date === localDate);
    if (solar?.sunrise && solar.sunset) {
      const sunrise = Date.parse(solar.sunrise);
      const sunset = Date.parse(solar.sunset);
      if (
        Number.isFinite(sunrise) &&
        Number.isFinite(sunset) &&
        sunrise < sunset
      ) {
        return {
          period:
            instant.getTime() >= sunrise && instant.getTime() < sunset
              ? "day"
              : "night",
          approximateDaylight: false,
        };
      }
    }
    const observationAge = realNow.getTime() - Date.parse(weather.observedAt);
    // Current provider is_day can describe a polar day/night, but must never
    // leak into a simulated date or a stale weather observation.
    if (
      solar &&
      !solar.sunrise &&
      !solar.sunset &&
      observationAge >= -300_000 &&
      observationAge <= 1_800_000 &&
      Math.abs(instant.getTime() - realNow.getTime()) <= 300_000 &&
      calendarDate(realNow, weather.timezone) === localDate
    ) {
      return {
        period: weather.isDay ? "day" : "night",
        approximateDaylight: false,
      };
    }
  }
  const { hour } = zonedDateParts(instant, timeZone);
  return {
    period:
      hour >= THEME_CALENDAR.approximateDay.startHour &&
      hour < THEME_CALENDAR.approximateDay.endHour
        ? "day"
        : "night",
    approximateDaylight: true,
  };
}

function cssVariables(
  palette: ThemePalette,
  ambientOpacity: number,
): ThemeCssVariables {
  return {
    "--black": palette.background,
    "--deep-black": palette.deepBackground,
    "--surface": palette.surface,
    "--surface-raised": palette.surfaceRaised,
    "--border": palette.border,
    "--white": palette.text,
    "--slate": palette.secondaryText,
    "--muted": palette.mutedText,
    "--accent": palette.accent,
    "--accent-hover": palette.accentHover,
    "--theme-glow": palette.glow,
    "--theme-particle": palette.particle,
    "--theme-ambient-opacity": String(ambientOpacity),
    "--theme-focus": palette.accent,
  };
}

export function resolveTheme({
  appearance,
  instant,
  timeZone,
  location,
  weather,
  realNow,
}: {
  appearance: AppearancePreferences;
  instant: Date;
  timeZone: string;
  location: WeatherLocation | null;
  weather: WeatherSnapshot | null;
  realNow: Date;
}): ResolvedTheme {
  const daylight =
    appearance.daylightOverride && appearance.daylightOverride !== "auto"
      ? { period: appearance.daylightOverride, approximateDaylight: false }
      : resolveDaylight(instant, timeZone, location ? weather : null, realNow);
  if (appearance.mode === "cinematic") {
    const palette: ThemePalette = {
      background: "#000000",
      deepBackground: "#030303",
      surface: "#1a1a1a",
      surfaceRaised: "#202020",
      border: "#27272a",
      accent: "#f2f2f2",
      accentHover: "#d7d7d7",
      text: "#ffffff",
      secondaryText: "#a7adb7",
      mutedText: "#7d848e",
      glow: "#000000",
      particle: "#ffffff",
    };
    return {
      id: "cinematic",
      season: "cinematic",
      ...daylight,
      palette,
      motif: "none",
      weatherEffect: "none",
      ambientOpacity: 0,
      moonPhase: null,
      cssVariables: cssVariables(palette, 0),
    };
  }
  const season =
    appearance.mode === "auto"
      ? resolveSeason(instant, timeZone, location?.latitude ?? null)
      : appearance.mode;
  const base =
    season === "summer" && daylight.period === "night"
      ? {
          ...palettes.summer,
          background: "#0b1423",
          surface: "#1c2938",
          glow: "#36496a",
        }
      : season === "winter" && daylight.period === "night"
        ? {
            ...palettes.winter,
            background: "#040b18",
            surface: "#142234",
            glow: "#203752",
          }
        : palettes[season];
  const age = weather
    ? realNow.getTime() - Date.parse(weather.observedAt)
    : Infinity;
  const observedCondition =
    location && weather && age >= -300_000 && age <= 7_200_000
      ? weather.condition
      : "unknown";
  // A visual weather choice is independent of location permission, forecast
  // freshness and the daylight axis. It never mutates the actual observation.
  const condition =
    appearance.weatherOverride && appearance.weatherOverride !== "auto"
      ? appearance.weatherOverride
      : observedCondition;
  const weatherEffect: WeatherEffect =
    condition === "clear" || condition === "unknown" ? "none" : condition;
  const weatherTint =
    condition === "fog"
      ? 0.24
      : ["rain", "storm", "snow", "cloudy"].includes(condition)
        ? 0.14
        : 0;
  const nightTint = daylight.period === "night" ? 0.36 : 0;
  const background = mix(
    mix(base.background, "#03060e", nightTint),
    "#192533",
    weatherTint,
  );
  const surface = mix(
    mix(base.surface, "#090d16", nightTint * 0.65),
    "#253244",
    weatherTint,
  );
  const palette: ThemePalette = {
    background,
    deepBackground: mix(background, "#000000", 0.25),
    surface,
    surfaceRaised: mix(surface, "#c4ccd5", 0.055),
    border: mix(surface, base.accent, 0.15),
    accent: base.accent,
    accentHover: mix(base.accent, "#ffffff", 0.15),
    text: "#f8f7f5",
    secondaryText: "#c5c7cc",
    mutedText: "#b1b5bd",
    glow: mix(base.glow, "#3d526a", weatherTint),
    particle: base.particle,
  };
  const ambientOpacity =
    daylight.period === "night" ? 0.24 : season === "summer" ? 0.44 : 0.34;
  return {
    id: season,
    season,
    ...daylight,
    weatherEffect,
    palette,
    motif: base.motif,
    ambientOpacity,
    moonPhase:
      season === "summer" || season === "winter" ? lunarPhase(instant) : null,
    cssVariables: cssVariables(palette, ambientOpacity),
  };
}
