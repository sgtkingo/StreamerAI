import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  AppearancePreferencesSchema,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
  EnvironmentWeatherResponseSchema,
  ViewerProfileSchema,
  WeatherLocationSchema,
  mergeAppearancePreferences,
  type AppearancePreferences,
  type ViewerProfile,
} from "@streamer-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { ThemeProvider, useTheme } from "./ThemeProvider";
import {
  CHOOSER_APPEARANCE_STORAGE_KEY,
  DEVICE_ENVIRONMENT_STORAGE_KEY,
  defaultDeviceEnvironment,
} from "./storage";

// Animation rendering is covered by the ambient layer's own checks.
vi.mock("./AmbientBackground", () => ({ AmbientBackground: () => null }));

const prague = WeatherLocationSchema.parse({
  id: "prague",
  label: "Prague, Czechia",
  latitude: 50.08,
  longitude: 14.44,
  timezone: "Europe/Prague",
});

function profile(
  id: string,
  appearance: Partial<AppearancePreferences> = {},
): ViewerProfile {
  return ViewerProfileSchema.parse({
    id,
    name: id,
    onboardingComplete: true,
    locale: "en",
    genres: [],
    prompt: "",
    playback: DEFAULT_PLAYBACK_PREFERENCES,
    appearance,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createApi(overrides: Partial<StreamerApi> = {}): StreamerApi {
  return {
    getProfiles: vi.fn().mockResolvedValue({ items: [] }),
    updateProfile: vi.fn(),
    getEnvironmentWeather: vi.fn(),
    ...overrides,
  } as StreamerApi;
}

function Probe() {
  const theme = useTheme();
  return (
    <>
      <output data-testid="appearance">
        {JSON.stringify(theme.appearance)}
      </output>
      <output data-testid="saving">{String(theme.saving)}</output>
      <output data-testid="appearance-error">{theme.appearanceError}</output>
      <output data-testid="storage-error">{theme.storageError}</output>
      <output data-testid="weather-status">{theme.weatherStatus}</output>
      <output data-testid="resolved-theme">
        {JSON.stringify(theme.resolvedTheme)}
      </output>
      <output data-testid="environment">
        {JSON.stringify(theme.environment)}
      </output>
      {(["auto", "cinematic", "summer", "winter"] as const).map((mode) => (
        <button key={mode} onClick={() => theme.setAppearance({ mode })}>
          {mode}
        </button>
      ))}
      <button onClick={() => theme.setThemeFamily("cinematic")}>
        Cinematic family
      </button>
      <button onClick={() => theme.setThemeFamily("auto")}>
        Seasonal family
      </button>
      <button onClick={() => theme.setAppearance({ weatherOverride: "snow" })}>
        Simulate snow
      </button>
      <button
        onClick={() => theme.setAppearance({ daylightOverride: "night" })}
      >
        Force night
      </button>
      <button
        onClick={() =>
          theme.updateEnvironment({
            ...theme.environment,
            weatherEnabled: true,
            location: prague,
          })
        }
      >
        Enable weather
      </button>
      <button
        onClick={() =>
          theme.updateEnvironment({
            ...theme.environment,
            weatherEnabled: false,
            location: null,
          })
        }
      >
        Disable weather
      </button>
      <button onClick={theme.refreshWeather}>Refresh weather</button>
    </>
  );
}

function shownAppearance(): AppearancePreferences {
  return JSON.parse(screen.getByTestId("appearance").textContent ?? "null");
}

function chooserAppearance(): unknown {
  const value = localStorage.getItem(CHOOSER_APPEARANCE_STORAGE_KEY);
  return value ? JSON.parse(value) : null;
}

afterEach(() => vi.restoreAllMocks());

describe("ThemeProvider integration", () => {
  it("defaults the chooser to automatic and remembers each selected profile appearance", () => {
    const api = createApi();
    const updated = vi.fn();
    const { rerender } = render(
      <ThemeProvider api={api} profile={null} onProfileUpdated={updated}>
        <Probe />
      </ThemeProvider>,
    );
    expect(shownAppearance()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    fireEvent.click(screen.getByRole("button", { name: "winter" }));
    expect(chooserAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "winter",
        ambientMotion: true,
      }),
    );
    expect(api.updateProfile).not.toHaveBeenCalled();

    const selected = profile("alex", { mode: "summer", ambientMotion: false });
    rerender(
      <ThemeProvider api={api} profile={selected} onProfileUpdated={updated}>
        <Probe />
      </ThemeProvider>,
    );
    expect(shownAppearance()).toEqual(selected.appearance);
    expect(chooserAppearance()).toEqual(selected.appearance);
    rerender(
      <ThemeProvider api={api} profile={null} onProfileUpdated={updated}>
        <Probe />
      </ThemeProvider>,
    );
    expect(shownAppearance()).toEqual(selected.appearance);

    const next = profile("another-viewer");
    rerender(
      <ThemeProvider api={api} profile={next} onProfileUpdated={updated}>
        <Probe />
      </ThemeProvider>,
    );
    expect(shownAppearance()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(chooserAppearance()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  it("preserves disabled motion and waits for a profile save before updating chooser storage", async () => {
    const selected = profile("alex", { ambientMotion: false });
    const save = deferred<ViewerProfile>();
    const api = createApi({
      updateProfile: vi.fn().mockReturnValue(save.promise),
    });
    const updated = vi.fn();
    render(
      <ThemeProvider api={api} profile={selected} onProfileUpdated={updated}>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "summer" }));
    expect(shownAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "summer",
        ambientMotion: false,
      }),
    );
    expect(chooserAppearance()).toEqual(selected.appearance);
    await waitFor(() =>
      expect(api.updateProfile).toHaveBeenCalledWith("alex", {
        appearance: { mode: "summer" },
      }),
    );
    const saved = profile("alex", { mode: "summer", ambientMotion: false });
    await act(async () => save.resolve(saved));
    expect(updated).toHaveBeenCalledWith(saved);
    expect(shownAppearance()).toEqual(saved.appearance);
    expect(chooserAppearance()).toEqual(saved.appearance);
    expect(screen.getByTestId("saving")).toHaveTextContent("false");
  });

  it("serializes rapid saves so an older failure cannot revert the newer choice", async () => {
    const selected = profile("alex", { ambientMotion: false });
    const first = deferred<ViewerProfile>();
    const second = deferred<ViewerProfile>();
    const updateProfile = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = createApi({ updateProfile });
    render(
      <ThemeProvider api={api} profile={selected} onProfileUpdated={vi.fn()}>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "summer" }));
    fireEvent.click(screen.getByRole("button", { name: "winter" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(shownAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "winter",
        ambientMotion: false,
      }),
    );
    await act(async () => first.reject(new Error("The first save failed.")));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile).toHaveBeenNthCalledWith(2, "alex", {
      appearance: { mode: "winter" },
    });
    expect(shownAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "winter",
        ambientMotion: false,
      }),
    );
    expect(screen.getByTestId("appearance-error")).toBeEmptyDOMElement();
    await act(async () =>
      second.resolve(profile("alex", { mode: "winter", ambientMotion: false })),
    );
    expect(shownAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "winter",
        ambientMotion: false,
      }),
    );
    expect(chooserAppearance()).toEqual(shownAppearance());
    expect(screen.getByTestId("saving")).toHaveTextContent("false");
  });

  it("ignores a pending save response after switching to a different profile", async () => {
    const save = deferred<ViewerProfile>();
    const api = createApi({
      updateProfile: vi.fn().mockReturnValue(save.promise),
    });
    const updated = vi.fn();
    const { rerender } = render(
      <ThemeProvider
        api={api}
        profile={profile("alex")}
        onProfileUpdated={updated}
      >
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "summer" }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    const another = profile("another", { mode: "cinematic" });
    rerender(
      <ThemeProvider api={api} profile={another} onProfileUpdated={updated}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => save.resolve(profile("alex", { mode: "summer" })));
    expect(shownAppearance()).toEqual(another.appearance);
    expect(chooserAppearance()).toEqual(another.appearance);
    expect(updated).not.toHaveBeenCalled();
  });

  it("saves the active profile without waiting for a stalled previous profile", async () => {
    const firstSave = deferred<ViewerProfile>();
    const secondSave = deferred<ViewerProfile>();
    const updateProfile = vi
      .fn()
      .mockImplementation((id: string) =>
        id === "alex" ? firstSave.promise : secondSave.promise,
      );
    const api = createApi({ updateProfile });
    const updated = vi.fn();
    const { rerender } = render(
      <ThemeProvider
        api={api}
        profile={profile("alex")}
        onProfileUpdated={updated}
      >
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "summer" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    rerender(
      <ThemeProvider
        api={api}
        profile={profile("another", { ambientMotion: false })}
        onProfileUpdated={updated}
      >
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("saving")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "winter" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile).toHaveBeenNthCalledWith(2, "another", {
      appearance: { mode: "winter" },
    });
    const saved = profile("another", { mode: "winter", ambientMotion: false });
    await act(async () => secondSave.resolve(saved));
    expect(updated).toHaveBeenCalledWith(saved);
    expect(shownAppearance()).toEqual(saved.appearance);
    expect(screen.getByTestId("saving")).toHaveTextContent("false");
    await act(async () =>
      firstSave.resolve(profile("alex", { mode: "summer" })),
    );
    expect(updated).toHaveBeenCalledTimes(1);
    expect(shownAppearance()).toEqual(saved.appearance);
    expect(chooserAppearance()).toEqual(saved.appearance);
    expect(screen.getByTestId("saving")).toHaveTextContent("false");
  });

  it("requests weather only after location opt-in and stops requests in Cinematic", async () => {
    const now = new Date().toISOString();
    const response = EnvironmentWeatherResponseSchema.parse({
      status: "fresh",
      weather: {
        condition: "rain",
        precipitation: 1,
        cloudCover: 80,
        observedAt: now,
        fetchedAt: now,
        isDay: true,
        timezone: prague.timezone,
        solar: [],
      },
      attribution: {
        name: "Open-Meteo",
        url: "https://open-meteo.com/",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    });
    const getEnvironmentWeather = vi.fn().mockResolvedValue(response);
    const api = createApi({ getEnvironmentWeather });
    render(
      <ThemeProvider api={api} profile={null} onProfileUpdated={vi.fn()}>
        <Probe />
      </ThemeProvider>,
    );
    expect(getEnvironmentWeather).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable weather" }));
    await waitFor(() => expect(getEnvironmentWeather).toHaveBeenCalledTimes(1));
    expect(getEnvironmentWeather).toHaveBeenCalledWith(
      50.08,
      14.44,
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(screen.getByTestId("weather-status")).toHaveTextContent("fresh"),
    );
    fireEvent.click(screen.getByRole("button", { name: "cinematic" }));
    expect(screen.getByTestId("weather-status")).toHaveTextContent("disabled");
    fireEvent.click(screen.getByRole("button", { name: "Refresh weather" }));
    expect(getEnvironmentWeather).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Disable weather" }));
    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh weather" }));
    expect(getEnvironmentWeather).toHaveBeenCalledTimes(1);
  });

  it("never requests weather when starting in Cinematic with a saved location", () => {
    localStorage.setItem(
      DEVICE_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        ...defaultDeviceEnvironment(),
        weatherEnabled: true,
        location: prague,
      }),
    );
    localStorage.setItem(
      CHOOSER_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ mode: "cinematic", ambientMotion: true }),
    );
    const api = createApi();
    render(
      <ThemeProvider api={api} profile={null} onProfileUpdated={vi.fn()}>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh weather" }));
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
    expect(screen.getByTestId("weather-status")).toHaveTextContent("disabled");
  });

  it("honors an initially selected Cinematic profile before evaluating saved weather", () => {
    localStorage.setItem(
      DEVICE_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        ...defaultDeviceEnvironment(),
        weatherEnabled: true,
        location: prague,
      }),
    );
    const api = createApi();
    render(
      <ThemeProvider
        api={api}
        profile={profile("cinema-viewer", { mode: "cinematic" })}
        onProfileUpdated={vi.fn()}
      >
        <Probe />
      </ThemeProvider>,
    );
    expect(shownAppearance().mode).toBe("cinematic");
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
  });

  it("keeps theme and environment controls usable when browser storage is denied", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    const api = createApi();
    render(
      <ThemeProvider api={api} profile={null} onProfileUpdated={vi.fn()}>
        <Probe />
      </ThemeProvider>,
    );
    expect(shownAppearance()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    fireEvent.click(screen.getByRole("button", { name: "winter" }));
    expect(shownAppearance().mode).toBe("winter");
    expect(screen.getByTestId("storage-error")).toHaveTextContent(
      "could not be saved",
    );
    fireEvent.click(screen.getByRole("button", { name: "Disable weather" }));
    expect(screen.getByTestId("environment")).toHaveTextContent(
      '"weatherEnabled":false',
    );
    expect(screen.getByTestId("storage-error")).toHaveTextContent(
      "could not be saved",
    );
  });

  it("restores the fixed holiday and pinned weather and lighting after toggling Cinematic", async () => {
    const selected = profile("alex", {
      mode: "christmas",
      ambientMotion: false,
      weatherOverride: "snow",
      daylightOverride: "night",
    });
    let stored = selected;
    const updateProfile = vi.fn().mockImplementation(async (_id, patch) => {
      stored = {
        ...stored,
        appearance: mergeAppearancePreferences(
          stored.appearance,
          patch.appearance,
        ),
      };
      return stored;
    });
    const api = createApi({ updateProfile });
    render(
      <ThemeProvider api={api} profile={selected} onProfileUpdated={vi.fn()}>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cinematic family" }));
    expect(shownAppearance()).toEqual({
      ...selected.appearance,
      mode: "cinematic",
    });
    fireEvent.click(screen.getByRole("button", { name: "Seasonal family" }));
    expect(shownAppearance()).toEqual(selected.appearance);
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile).toHaveBeenNthCalledWith(1, "alex", {
      appearance: { mode: "cinematic", seasonalMode: "christmas" },
    });
    expect(updateProfile).toHaveBeenNthCalledWith(2, "alex", {
      appearance: { mode: "christmas" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("saving")).toHaveTextContent("false"),
    );
    expect(shownAppearance()).toEqual(selected.appearance);
    expect(chooserAppearance()).toEqual(selected.appearance);
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
  });

  it("renders manual weather and lighting without a location or provider request", () => {
    const api = createApi();
    render(
      <ThemeProvider api={api} profile={null} onProfileUpdated={vi.fn()}>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simulate snow" }));
    fireEvent.click(screen.getByRole("button", { name: "Force night" }));
    expect(shownAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        weatherOverride: "snow",
        daylightOverride: "night",
      }),
    );
    expect(document.documentElement).toHaveAttribute("data-weather", "snow");
    expect(document.documentElement).toHaveAttribute("data-period", "night");
    expect(screen.getByTestId("environment")).toHaveTextContent(
      '"location":null',
    );
    expect(api.getEnvironmentWeather).not.toHaveBeenCalled();
  });
});
