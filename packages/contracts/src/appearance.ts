import { z } from "zod";

export const THEME_MODES = [
  "auto",
  "cinematic",
  "spring",
  "summer",
  "autumn",
  "winter",
  "christmas",
  "new-year",
] as const;

export const ThemeModeSchema = z.enum(THEME_MODES);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const SEASONAL_THEME_MODES = [
  "auto",
  "spring",
  "summer",
  "autumn",
  "winter",
  "christmas",
  "new-year",
] as const;
export const SeasonalThemeModeSchema = z.enum(SEASONAL_THEME_MODES);
export type SeasonalThemeMode = z.infer<typeof SeasonalThemeModeSchema>;

export const WEATHER_OVERRIDES = [
  "auto",
  "clear",
  "cloudy",
  "fog",
  "rain",
  "snow",
  "storm",
] as const;
export const WeatherOverrideSchema = z.enum(WEATHER_OVERRIDES);
export type WeatherOverride = z.infer<typeof WeatherOverrideSchema>;

export const DAYLIGHT_OVERRIDES = ["auto", "day", "night"] as const;
export const DaylightOverrideSchema = z.enum(DAYLIGHT_OVERRIDES);
export type DaylightOverride = z.infer<typeof DaylightOverrideSchema>;

export const AppearancePreferencesSchema = z
  .object({
    mode: ThemeModeSchema.default("auto"),
    ambientMotion: z.boolean().default(true),
    seasonalMode: SeasonalThemeModeSchema.optional(),
    weatherOverride: WeatherOverrideSchema.default("auto"),
    daylightOverride: DaylightOverrideSchema.default("auto"),
  })
  .strict()
  .transform((value) => ({
    ...value,
    seasonalMode:
      value.seasonalMode ?? (value.mode === "cinematic" ? "auto" : value.mode),
  }));

export type AppearancePreferences = z.infer<typeof AppearancePreferencesSchema>;

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences =
  AppearancePreferencesSchema.parse({});

/** A partial update never resets the viewer's other appearance axes. */
export const AppearancePatchSchema = z
  .object({
    mode: ThemeModeSchema.optional(),
    ambientMotion: z.boolean().optional(),
    seasonalMode: SeasonalThemeModeSchema.optional(),
    weatherOverride: WeatherOverrideSchema.optional(),
    daylightOverride: DaylightOverrideSchema.optional(),
  })
  .strict();

export type AppearancePatch = z.infer<typeof AppearancePatchSchema>;

/** Keep the seasonal choice when entering Cinematic and remember explicit seasonal changes. */
export function mergeAppearancePreferences(
  current: AppearancePreferences,
  patch: AppearancePatch,
): AppearancePreferences {
  return AppearancePreferencesSchema.parse({
    ...current,
    ...patch,
    ...(patch.mode !== undefined &&
    patch.mode !== "cinematic" &&
    patch.seasonalMode === undefined
      ? { seasonalMode: patch.mode }
      : {}),
  });
}
