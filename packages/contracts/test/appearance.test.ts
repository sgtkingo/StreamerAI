import { describe, expect, it } from "vitest";

import {
  AppearancePatchSchema,
  AppearancePreferencesSchema,
  DEFAULT_APPEARANCE_PREFERENCES,
  DAYLIGHT_OVERRIDES,
  SEASONAL_THEME_MODES,
  THEME_MODES,
  WEATHER_OVERRIDES,
  mergeAppearancePreferences,
} from "../src/appearance.js";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  SetupProfileSchema,
  UpdateViewerProfileSchema,
  ViewerProfileSchema,
} from "../src/onboarding.js";

describe("appearance preferences", () => {
  it("upgrades existing profile and setup payloads to automatic appearance", () => {
    expect(
      ViewerProfileSchema.parse({
        id: "old-viewer",
        name: "Viewer",
        onboardingComplete: true,
        locale: "cs",
        genres: [],
        prompt: "",
        playback: DEFAULT_PLAYBACK_PREFERENCES,
      }).appearance,
    ).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(
      SetupProfileSchema.parse({ name: "Viewer", locale: "en" }).appearance,
    ).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(AppearancePreferencesSchema.parse({ ambientMotion: false })).toEqual(
      {
        ...DEFAULT_APPEARANCE_PREFERENCES,
        ambientMotion: false,
      },
    );
  });

  it("keeps appearance patches free of defaults and validates every theme", () => {
    expect(AppearancePatchSchema.parse({})).toEqual({});
    for (const mode of THEME_MODES) {
      expect(UpdateViewerProfileSchema.parse({ appearance: { mode } })).toEqual(
        {
          appearance: { mode },
        },
      );
    }
    expect(
      AppearancePreferencesSchema.safeParse({ mode: "unrecognized" }).success,
    ).toBe(false);
    expect(
      AppearancePatchSchema.safeParse({ ambientMotion: "false" }).success,
    ).toBe(false);
    expect(
      AppearancePatchSchema.safeParse({ deviceTimeZone: "UTC" }).success,
    ).toBe(false);
  });

  it("normalizes legacy fixed seasons and keeps an explicit remembered season", () => {
    for (const mode of THEME_MODES) {
      expect(AppearancePreferencesSchema.parse({ mode })).toEqual({
        ...DEFAULT_APPEARANCE_PREFERENCES,
        mode,
        seasonalMode: mode === "cinematic" ? "auto" : mode,
      });
    }
    expect(
      AppearancePreferencesSchema.parse({
        mode: "cinematic",
        seasonalMode: "christmas",
      }).seasonalMode,
    ).toBe("christmas");
    expect(
      AppearancePreferencesSchema.parse({
        mode: "spring",
        seasonalMode: "winter",
      }).seasonalMode,
    ).toBe("winter");
  });

  it("validates independent weather and daylight choices without adding PATCH defaults", () => {
    for (const seasonalMode of SEASONAL_THEME_MODES) {
      expect(AppearancePatchSchema.parse({ seasonalMode })).toEqual({
        seasonalMode,
      });
    }
    for (const weatherOverride of WEATHER_OVERRIDES) {
      expect(AppearancePatchSchema.parse({ weatherOverride })).toEqual({
        weatherOverride,
      });
    }
    for (const daylightOverride of DAYLIGHT_OVERRIDES) {
      expect(AppearancePatchSchema.parse({ daylightOverride })).toEqual({
        daylightOverride,
      });
    }
    for (const invalid of [
      { seasonalMode: "cinematic" },
      { weatherOverride: "hail" },
      { daylightOverride: "sunset" },
      { daylightOverride: null },
    ]) {
      expect(AppearancePatchSchema.safeParse(invalid).success).toBe(false);
      expect(AppearancePreferencesSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("merges one appearance axis while preserving other pins and remembered seasonal choices", () => {
    const original = AppearancePreferencesSchema.parse({
      mode: "autumn",
      ambientMotion: false,
      weatherOverride: "rain",
      daylightOverride: "night",
    });
    expect(mergeAppearancePreferences(original, { mode: "cinematic" })).toEqual(
      {
        ...original,
        mode: "cinematic",
      },
    );
    const winter = mergeAppearancePreferences(original, { mode: "winter" });
    expect(winter).toEqual({
      ...original,
      mode: "winter",
      seasonalMode: "winter",
    });
    expect(
      mergeAppearancePreferences(winter, { weatherOverride: "snow" }),
    ).toEqual({
      ...winter,
      weatherOverride: "snow",
    });
    expect(
      mergeAppearancePreferences(winter, {
        mode: "auto",
        seasonalMode: "christmas",
      }),
    ).toEqual({ ...winter, mode: "auto", seasonalMode: "christmas" });
    expect(mergeAppearancePreferences(winter, {})).toEqual(winter);
  });
});
