import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppearancePreferencesSchema,
  DEFAULT_APPEARANCE_PREFERENCES,
  type WeatherLocation,
  type WeatherSnapshot,
} from "@streamer-ai/contracts";
import {
  CHOOSER_APPEARANCE_STORAGE_KEY,
  DEVICE_ENVIRONMENT_STORAGE_KEY,
  WEATHER_CACHE_STORAGE_KEY,
  defaultDeviceEnvironment,
  readChooserAppearance,
  readDeviceEnvironment,
  readWeatherCache,
  writeChooserAppearance,
  writeDeviceEnvironment,
  writeWeatherCache,
} from "./storage";

const location: WeatherLocation = {
  id: "prague",
  label: "Prague",
  latitude: 50.087_891,
  longitude: 14.421_234,
  timezone: "Europe/Prague",
};
const weather: WeatherSnapshot = {
  condition: "rain",
  precipitation: 1,
  cloudCover: 90,
  observedAt: "2026-10-20T12:00:00Z",
  fetchedAt: "2026-10-20T12:00:00Z",
  isDay: true,
  timezone: "Europe/Prague",
  solar: [],
};

afterEach(() => vi.restoreAllMocks());

describe("device environment persistence", () => {
  it("defaults to automatic time, Automatic appearance and no weather location", () => {
    expect(readDeviceEnvironment()).toMatchObject({
      version: 1,
      autoDetectTime: true,
      manualClock: null,
      weatherEnabled: false,
      location: null,
    });
    expect(readChooserAppearance()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  it("rounds selected location coordinates before storage", () => {
    expect(
      writeDeviceEnvironment({
        ...defaultDeviceEnvironment(),
        weatherEnabled: true,
        location,
      }),
    ).toBe(true);
    expect(readDeviceEnvironment().location).toMatchObject({
      latitude: 50.09,
      longitude: 14.42,
    });
    expect(localStorage.getItem(DEVICE_ENVIRONMENT_STORAGE_KEY)).not.toContain(
      "50.087891",
    );
  });

  it("drops location and the weather cache when weather is disabled", () => {
    writeWeatherCache(location, weather);
    writeDeviceEnvironment({
      ...defaultDeviceEnvironment(),
      weatherEnabled: false,
      location,
    });
    expect(readDeviceEnvironment().location).toBeNull();
    expect(localStorage.getItem(WEATHER_CACHE_STORAGE_KEY)).toBeNull();
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({ ...defaultDeviceEnvironment(), timeZone: "Bad/Zone" }),
    JSON.stringify({
      ...defaultDeviceEnvironment(),
      manualClock: { instant: "not a date", setAt: "2026-10-20T12:00:00Z" },
    }),
  ])("recovers from a corrupt record", (stored) => {
    localStorage.setItem(DEVICE_ENVIRONMENT_STORAGE_KEY, stored);
    expect(readDeviceEnvironment()).toMatchObject({
      autoDetectTime: true,
      manualClock: null,
      weatherEnabled: false,
      location: null,
    });
  });

  it("validates appearance modes and rejects unrelated profile information", () => {
    localStorage.setItem(
      CHOOSER_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ mode: "invalid", ambientMotion: true }),
    );
    expect(readChooserAppearance().mode).toBe("auto");
    expect(
      writeChooserAppearance(
        AppearancePreferencesSchema.parse({
          mode: "autumn",
          ambientMotion: false,
        }),
      ),
    ).toBe(true);
    expect(readChooserAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "autumn",
        ambientMotion: false,
      }),
    );
    localStorage.setItem(
      CHOOSER_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ mode: "winter", profileId: "private" }),
    );
    expect(readChooserAppearance().mode).toBe("auto");
  });

  it("validates cached weather and binds it to the selected coarse location", () => {
    expect(writeWeatherCache(location, weather)).toBe(true);
    expect(readWeatherCache(location)).toEqual(weather);
    expect(readWeatherCache({ ...location, latitude: 51 })).toBeNull();
    localStorage.setItem(
      WEATHER_CACHE_STORAGE_KEY,
      JSON.stringify({
        location: "50.09,14.42",
        weather: { ...weather, precipitation: -1 },
      }),
    );
    expect(readWeatherCache(location)).toBeNull();
  });

  it("upgrades legacy chooser records and persists pinned appearance axes independently", () => {
    localStorage.setItem(
      CHOOSER_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ mode: "christmas", ambientMotion: false }),
    );
    expect(readChooserAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "christmas",
        ambientMotion: false,
      }),
    );
    const pinned = AppearancePreferencesSchema.parse({
      mode: "cinematic",
      seasonalMode: "christmas",
      ambientMotion: false,
      weatherOverride: "snow",
      daylightOverride: "night",
    });
    expect(writeChooserAppearance(pinned)).toBe(true);
    expect(readChooserAppearance()).toEqual(pinned);
    expect(
      JSON.parse(
        localStorage.getItem(CHOOSER_APPEARANCE_STORAGE_KEY) ?? "null",
      ),
    ).toEqual(pinned);
  });

  it.each(["fetchedAt", "observedAt"] as const)(
    "rejects cached weather with a far-future %s without losing old solar data",
    (field) => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const invalid = { ...weather, [field]: future };
      localStorage.setItem(
        WEATHER_CACHE_STORAGE_KEY,
        JSON.stringify({ location: "50.09,14.42", weather: invalid }),
      );
      expect(readWeatherCache(location)).toBeNull();
      expect(writeWeatherCache(location, invalid)).toBe(false);
      expect(
        writeWeatherCache(location, {
          ...weather,
          observedAt: "2026-10-01T12:00:00Z",
          fetchedAt: "2026-10-01T12:00:00Z",
        }),
      ).toBe(true);
      expect(readWeatherCache(location)).not.toBeNull();
    },
  );

  it("uses safe in-memory defaults and reports unsaved values when browser storage fails", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(readDeviceEnvironment().autoDetectTime).toBe(true);
    expect(readChooserAppearance().mode).toBe("auto");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(writeDeviceEnvironment(defaultDeviceEnvironment())).toBe(false);
    expect(
      writeChooserAppearance(
        AppearancePreferencesSchema.parse({
          mode: "winter",
          ambientMotion: true,
        }),
      ),
    ).toBe(false);
  });
});
