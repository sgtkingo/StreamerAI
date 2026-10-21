import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppearancePreferencesSchema,
  WeatherLocationSchema,
  WeatherSnapshotSchema,
  type AppearancePreferences,
} from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { AppearanceSettings } from "./AppearanceSettings";
import { ThemeProvider, useTheme } from "./ThemeProvider";
import {
  DEVICE_ENVIRONMENT_STORAGE_KEY,
  defaultDeviceEnvironment,
  type DeviceEnvironment,
} from "./storage";

const { ambientBackground } = vi.hoisted(() => ({
  ambientBackground: vi.fn(() => null),
}));
vi.mock("./AmbientBackground", () => ({
  AmbientBackground: ambientBackground,
}));

const location = WeatherLocationSchema.parse({
  id: "prague",
  label: "Prague, Czechia",
  name: "Prague",
  address: "Prague, Central Bohemia",
  country: "Czechia",
  countryCode: "CZ",
  latitude: 50.083,
  longitude: 14.437,
  timezone: "Europe/Prague",
});
const geolocationDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "geolocation",
);

function EnvironmentProbe() {
  const theme = useTheme();
  return (
    <>
      <output data-testid="environment">
        {JSON.stringify(theme.environment)}
      </output>
      <output data-testid="appearance">
        {JSON.stringify(theme.appearance)}
      </output>
    </>
  );
}

function appearance(): AppearancePreferences {
  return JSON.parse(screen.getByTestId("appearance").textContent ?? "null");
}

function environment(): DeviceEnvironment {
  return JSON.parse(screen.getByTestId("environment").textContent ?? "null");
}

function renderSettings(
  locale: "en" | "cs" = "en",
  overrides: Partial<StreamerApi> = {},
) {
  const getCurrentPosition = vi.fn();
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition },
  });
  const api = {
    searchEnvironmentLocations: vi
      .fn()
      .mockResolvedValue({ items: [location] }),
    getEnvironmentWeather: vi.fn().mockResolvedValue({
      status: "unavailable",
      weather: null,
      attribution: {
        name: "Open-Meteo",
        url: "https://open-meteo.com/",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    }),
    ...overrides,
  } as unknown as StreamerApi;
  render(
    <ThemeProvider api={api} profile={null} onProfileUpdated={vi.fn()}>
      <AppearanceSettings api={api} locale={locale} />
      <EnvironmentProbe />
    </ThemeProvider>,
  );
  return { api, getCurrentPosition };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (geolocationDescriptor) {
    Object.defineProperty(navigator, "geolocation", geolocationDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "geolocation");
  }
});

describe("appearance settings", () => {
  it("keeps weather opt-in, lets the viewer select a city, and stores coarse coordinates", async () => {
    const { api, getCurrentPosition } = renderSettings();
    expect(screen.getByLabelText("Auto-detect")).toBeChecked();
    expect(screen.getByLabelText("Use local weather")).not.toBeChecked();
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Use local weather"));
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
    const locate = screen.getByRole("button", { name: "Use my location" });
    expect(locate).toHaveAttribute("title", "Use my location");
    expect(locate.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByLabelText("City").closest(".theme-location-search"),
    ).toContainElement(locate);
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Prague" },
    });
    const city = await screen.findByRole("button", { name: /Prague, Czechia/ });
    expect(api.searchEnvironmentLocations).toHaveBeenCalledWith(
      "Prague",
      "en",
      expect.any(AbortSignal),
    );
    fireEvent.click(city);
    await waitFor(() =>
      expect(api.getEnvironmentWeather).toHaveBeenCalledTimes(1),
    );
    expect(api.getEnvironmentWeather).toHaveBeenCalledWith(
      50.08,
      14.44,
      expect.any(AbortSignal),
    );
    expect(environment().location).toEqual({
      ...location,
      latitude: 50.08,
      longitude: 14.44,
    });
    const weatherCard = screen.getByRole("article");
    expect(
      within(weatherCard).getByRole("heading", { name: "Prague" }),
    ).toBeInTheDocument();
    expect(
      within(weatherCard).getByText("Prague, Central Bohemia"),
    ).toBeInTheDocument();
    expect(within(weatherCard).getByText("Czechia")).toBeInTheDocument();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Use local weather"));
    expect(environment()).toMatchObject({
      weatherEnabled: false,
      location: null,
    });
    expect(
      JSON.parse(
        localStorage.getItem(DEVICE_ENVIRONMENT_STORAGE_KEY) ?? "null",
      ),
    ).toMatchObject({ weatherEnabled: false, location: null });
  });

  it("rejects a DST gap and requires an explicit offset for a repeated local time", () => {
    const { getCurrentPosition } = renderSettings("cs");
    fireEvent.click(screen.getByLabelText("Autodetekce"));
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Europe/Prague" },
    });
    const originalAnchor = environment().manualClock;
    fireEvent.change(screen.getByLabelText("Local date and time"), {
      target: { value: "2026-03-29T02:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save time settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("does not exist");
    expect(environment().manualClock).toEqual(originalAnchor);

    fireEvent.change(screen.getByLabelText("Local date and time"), {
      target: { value: "2026-10-25T02:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save time settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose the UTC offset",
    );
    expect(environment().manualClock).toEqual(originalAnchor);
    fireEvent.click(screen.getByLabelText("UTC+01:00"));
    fireEvent.click(screen.getByRole("button", { name: "Save time settings" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(environment()).toMatchObject({
      autoDetectTime: false,
      timeZone: "Europe/Prague",
      manualClock: { instant: "2026-10-25T01:30:00.000Z" },
    });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("preserves the manual instant when only timezone changes and restores autodetection", () => {
    const anchor = {
      instant: "2026-12-31T23:30:00.000Z",
      setAt: new Date().toISOString(),
    };
    localStorage.setItem(
      DEVICE_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        ...defaultDeviceEnvironment(),
        autoDetectTime: false,
        timeZone: "UTC",
        manualClock: anchor,
      }),
    );
    renderSettings();
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Pacific/Auckland" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save time settings" }));
    expect(environment().timeZone).toBe("Pacific/Auckland");
    expect(environment().manualClock).toEqual(anchor);
    fireEvent.click(screen.getByLabelText("Auto-detect"));
    expect(environment()).toMatchObject({
      autoDetectTime: true,
      manualClock: null,
    });
    expect(screen.queryByLabelText("Timezone")).not.toBeInTheDocument();
  });

  it("discards a location permission result after weather has been disabled", () => {
    const { api, getCurrentPosition } = renderSettings();
    fireEvent.click(screen.getByLabelText("Use local weather"));
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Use my location" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Use my location" }),
    ).toHaveAttribute("aria-busy", "true");
    const success = getCurrentPosition.mock.calls[0]![0] as PositionCallback;
    fireEvent.click(screen.getByLabelText("Use local weather"));
    act(() => {
      success({
        coords: { latitude: 50.083, longitude: 14.437 },
      } as GeolocationPosition);
    });
    expect(environment()).toMatchObject({
      weatherEnabled: false,
      location: null,
    });
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
  });

  it("previews a chosen season, weather and lighting without sharing a location", () => {
    const { api, getCurrentPosition } = renderSettings();
    fireEvent.change(screen.getByLabelText("Season"), {
      target: { value: "christmas" },
    });
    fireEvent.change(screen.getByLabelText("Weather influence"), {
      target: { value: "rain" },
    });
    fireEvent.change(screen.getByLabelText("Lighting"), {
      target: { value: "night" },
    });
    expect(appearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "christmas",
        weatherOverride: "rain",
        daylightOverride: "night",
      }),
    );
    expect(document.documentElement).toHaveAttribute("data-theme", "christmas");
    expect(document.documentElement).toHaveAttribute("data-weather", "rain");
    expect(document.documentElement).toHaveAttribute("data-period", "night");
    expect(screen.getByText(/rain preview/)).toBeInTheDocument();
    expect(environment()).toMatchObject({
      weatherEnabled: false,
      location: null,
    });
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("keeps city search available after geolocation permission is denied", () => {
    const { getCurrentPosition } = renderSettings();
    fireEvent.click(screen.getByLabelText("Use local weather"));
    const locate = screen.getByRole("button", { name: "Use my location" });
    fireEvent.click(locate);
    const fail = getCurrentPosition.mock.calls[0]![1] as PositionErrorCallback;
    act(() =>
      fail({
        code: 1,
        message: "Permission denied",
      } as GeolocationPositionError),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "permission was denied",
    );
    expect(screen.getByLabelText("City")).toBeEnabled();
    expect(locate).toBeEnabled();
    expect(locate).toHaveAttribute("aria-busy", "false");
    expect(environment().location).toBeNull();
  });

  it("fixes the current three axes, restores them after Cinematic, and can return to automatic", () => {
    localStorage.setItem(
      DEVICE_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        ...defaultDeviceEnvironment(),
        autoDetectTime: false,
        timeZone: "UTC",
        manualClock: {
          instant: "2026-10-20T10:00:00.000Z",
          setAt: new Date().toISOString(),
        },
      }),
    );
    const { api } = renderSettings();
    expect(document.documentElement).toHaveAttribute("data-theme", "autumn");
    expect(document.documentElement).toHaveAttribute("data-period", "day");
    fireEvent.click(screen.getByLabelText("Ambient motion"));
    const fixTheme = screen.getByRole("checkbox", {
      name: "Use current theme as fixed",
    });
    fireEvent.click(fixTheme);
    const pinned = AppearancePreferencesSchema.parse({
      mode: "autumn",
      ambientMotion: false,
      weatherOverride: "clear",
      daylightOverride: "day",
    });
    expect(appearance()).toEqual(pinned);
    expect(
      screen.getByRole("checkbox", { name: "Use current theme as fixed" }),
    ).toBeChecked();
    expect(
      screen
        .getByRole("checkbox", { name: "Use current theme as fixed" })
        .querySelector("svg"),
    ).toHaveAttribute("data-lock-state", "locked");
    expect(screen.getByText(/Appearance fixed:/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "cinematic" },
    });
    expect(screen.getByLabelText("Season")).toBeDisabled();
    expect(screen.getByLabelText("Weather influence")).toBeDisabled();
    expect(screen.getByLabelText("Lighting")).toBeDisabled();
    expect(appearance()).toEqual({ ...pinned, mode: "cinematic" });
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "auto" },
    });
    expect(appearance()).toEqual(pinned);

    act(() => {
      localStorage.setItem(
        DEVICE_ENVIRONMENT_STORAGE_KEY,
        JSON.stringify({
          ...environment(),
          manualClock: {
            instant: "2027-04-01T23:00:00.000Z",
            setAt: new Date().toISOString(),
          },
        }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: DEVICE_ENVIRONMENT_STORAGE_KEY }),
      );
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "autumn");
    expect(document.documentElement).toHaveAttribute("data-period", "day");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use current theme as fixed" }),
    );
    expect(appearance()).toEqual(
      AppearancePreferencesSchema.parse({ ambientMotion: false }),
    );
    expect(document.documentElement).toHaveAttribute("data-theme", "spring");
    expect(document.documentElement).toHaveAttribute("data-period", "night");
    expect(screen.queryByText(/Appearance fixed:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Use current theme as fixed" }),
    ).not.toBeChecked();
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
  });

  it("groups Local time and Weather atmosphere in one card below Appearance", () => {
    renderSettings();
    const card = screen.getByRole("region", { name: "Appearance" });
    expect(
      within(card).getByRole("heading", { name: "Appearance", level: 2 }),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole("heading", { name: "Theme", level: 3 }),
    ).toBeInTheDocument();
    const device = screen.getByRole("region", {
      name: "Time and weather settings",
    });
    expect(card.nextElementSibling).toBe(device);
    const time = within(device).getByRole("region", { name: "Local time" });
    expect(time).toHaveAttribute("id", "settings-time");
    expect(
      within(time).getByRole("heading", { name: "Local time", level: 2 }),
    ).toBeInTheDocument();
    const weather = within(device).getByRole("region", {
      name: "Weather atmosphere",
    });
    expect(weather).toHaveAttribute("id", "settings-weather");
    expect(
      within(weather).getByRole("heading", {
        name: "Weather atmosphere",
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(time.nextElementSibling).toBe(weather);
    expect(device.querySelectorAll(".profile-page__section")).toHaveLength(0);
    expect(within(weather).getByRole("article").previousElementSibling).toBe(
      within(weather)
        .getByRole("checkbox", { name: "Use local weather" })
        .closest("label"),
    );
    expect(card.querySelectorAll(".profile-page__section")).toHaveLength(0);
  });

  it("shows a clock with running seconds without restarting the ambient background or resetting a time draft", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:34:56.250Z"));
    localStorage.setItem(
      DEVICE_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        ...defaultDeviceEnvironment(),
        autoDetectTime: false,
        timeZone: "UTC",
        manualClock: {
          instant: "2026-10-21T12:34:56.250Z",
          setAt: "2026-10-21T12:34:56.250Z",
        },
      }),
    );
    renderSettings();
    const time = screen
      .getByRole("region", { name: "Local time" })
      .querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-10-21T12:34:56.250Z");
    expect(time).toHaveTextContent("12:34:56");
    fireEvent.change(screen.getByLabelText("Local date and time"), {
      target: { value: "2027-02-01T11:15" },
    });
    const backgroundRenders = ambientBackground.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(time).toHaveTextContent("12:34:58");
    expect(time).toHaveAttribute("datetime", "2026-10-21T12:34:58.000Z");
    expect(screen.getByLabelText("Local date and time")).toHaveValue(
      "2027-02-01T11:15",
    );
    expect(ambientBackground).toHaveBeenCalledTimes(backgroundRenders);
  });

  it("keeps observed weather ages on real time while the appearance clock is simulated", async () => {
    const now = new Date().toISOString();
    localStorage.setItem(
      DEVICE_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        ...defaultDeviceEnvironment(),
        autoDetectTime: false,
        timeZone: "UTC",
        manualClock: { instant: "2035-01-01T12:00:00.000Z", setAt: now },
        weatherEnabled: true,
        location,
      }),
    );
    const observed = WeatherSnapshotSchema.parse({
      condition: "rain",
      precipitation: 1,
      cloudCover: 90,
      observedAt: now,
      fetchedAt: now,
      isDay: true,
      timezone: "Europe/Prague",
      solar: [],
    });
    renderSettings("en", {
      getEnvironmentWeather: vi.fn().mockResolvedValue({
        status: "fresh",
        weather: observed,
        attribution: {
          name: "Open-Meteo",
          url: "https://open-meteo.com/",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        },
      }),
    });
    expect(await screen.findByText("Rain")).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveTextContent(
      "Fresh · Observed just now",
    );
    expect(
      screen.getByRole("region", { name: "Local time" }).querySelector("time")
        ?.dateTime,
    ).toContain("2035-01-01");
  });
});
