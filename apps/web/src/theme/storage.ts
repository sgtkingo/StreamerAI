import {
  AppearancePreferencesSchema,
  DEFAULT_APPEARANCE_PREFERENCES,
  WeatherLocationSchema,
  WeatherSnapshotSchema,
  type AppearancePreferences,
  type WeatherLocation,
  type WeatherSnapshot,
} from "@streamer-ai/contracts";
import { detectedTimeZone, isValidTimeZone } from "./clock";

export const DEVICE_ENVIRONMENT_STORAGE_KEY = "streamer.environment.v1";
export const CHOOSER_APPEARANCE_STORAGE_KEY = "streamer.appearance.v1";
export const WEATHER_CACHE_STORAGE_KEY = "streamer.weather.v1";

export interface DeviceEnvironment {
  version: 1;
  autoDetectTime: boolean;
  timeZone: string;
  manualClock: { instant: string; setAt: string } | null;
  weatherEnabled: boolean;
  location: WeatherLocation | null;
}

export function defaultDeviceEnvironment(): DeviceEnvironment {
  return {
    version: 1,
    autoDetectTime: true,
    timeZone: detectedTimeZone(),
    manualClock: null,
    weatherEnabled: false,
    location: null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseDeviceEnvironment(
  value: unknown,
): DeviceEnvironment | null {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.autoDetectTime !== "boolean" ||
    typeof value.timeZone !== "string" ||
    !isValidTimeZone(value.timeZone) ||
    typeof value.weatherEnabled !== "boolean"
  ) {
    return null;
  }
  const manualClock = value.manualClock;
  if (
    manualClock !== null &&
    (!record(manualClock) ||
      !validInstant(manualClock.instant) ||
      !validInstant(manualClock.setAt))
  ) {
    return null;
  }
  const location =
    value.location === null
      ? null
      : WeatherLocationSchema.safeParse(value.location);
  if (location && !location.success) return null;
  return {
    version: 1,
    autoDetectTime: value.autoDetectTime,
    timeZone: value.timeZone,
    manualClock:
      manualClock === null
        ? null
        : {
            instant: (manualClock as { instant: string }).instant,
            setAt: (manualClock as { setAt: string }).setAt,
          },
    weatherEnabled: value.weatherEnabled,
    location:
      value.weatherEnabled && location?.success
        ? {
            ...location.data,
            latitude: Math.round(location.data.latitude * 100) / 100,
            longitude: Math.round(location.data.longitude * 100) / 100,
          }
        : null,
  };
}

function read(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored && stored.length < 32_000 ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readDeviceEnvironment(): DeviceEnvironment {
  return (
    parseDeviceEnvironment(read(DEVICE_ENVIRONMENT_STORAGE_KEY)) ??
    defaultDeviceEnvironment()
  );
}

export function writeDeviceEnvironment(value: DeviceEnvironment): boolean {
  const parsed = parseDeviceEnvironment(value);
  if (!parsed) return false;
  if (!parsed.weatherEnabled) clearWeatherCache();
  return write(DEVICE_ENVIRONMENT_STORAGE_KEY, parsed);
}

export function readChooserAppearance(): AppearancePreferences {
  const parsed = AppearancePreferencesSchema.safeParse(
    read(CHOOSER_APPEARANCE_STORAGE_KEY),
  );
  return parsed.success ? parsed.data : { ...DEFAULT_APPEARANCE_PREFERENCES };
}

export function writeChooserAppearance(value: AppearancePreferences): boolean {
  const parsed = AppearancePreferencesSchema.safeParse(value);
  return parsed.success && write(CHOOSER_APPEARANCE_STORAGE_KEY, parsed.data);
}

function locationKey(location: WeatherLocation): string {
  return `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
}

function hasPlausibleWeatherInstants(weather: WeatherSnapshot): boolean {
  const latest = Date.now() + 5 * 60_000;
  return (
    Date.parse(weather.fetchedAt) <= latest &&
    Date.parse(weather.observedAt) <= latest
  );
}

export function readWeatherCache(
  location: WeatherLocation | null,
): WeatherSnapshot | null {
  if (!location) return null;
  const stored = read(WEATHER_CACHE_STORAGE_KEY);
  if (!record(stored) || stored.location !== locationKey(location)) return null;
  const parsed = WeatherSnapshotSchema.safeParse(stored.weather);
  return parsed.success && hasPlausibleWeatherInstants(parsed.data)
    ? parsed.data
    : null;
}

export function writeWeatherCache(
  location: WeatherLocation,
  weather: WeatherSnapshot,
): boolean {
  const parsed = WeatherSnapshotSchema.safeParse(weather);
  return (
    parsed.success &&
    hasPlausibleWeatherInstants(parsed.data) &&
    write(WEATHER_CACHE_STORAGE_KEY, {
      location: locationKey(location),
      weather: parsed.data,
    })
  );
}

export function clearWeatherCache(): boolean {
  try {
    localStorage.removeItem(WEATHER_CACHE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
