import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AppearancePreferencesSchema,
  EnvironmentWeatherResponseSchema,
  mergeAppearancePreferences,
  type AppearancePreferences,
  type EnvironmentWeatherResponse,
  type ViewerProfile,
  type WeatherSnapshot,
} from "@streamer-ai/contracts";
import { safeErrorMessage, type StreamerApi } from "../api/client";
import { AmbientBackground } from "./AmbientBackground";
import { createAdvancingClock, effectiveClock } from "./clock";
import { resolveTheme, type ResolvedTheme } from "./resolve-theme";
import {
  CHOOSER_APPEARANCE_STORAGE_KEY,
  DEVICE_ENVIRONMENT_STORAGE_KEY,
  clearWeatherCache,
  readChooserAppearance,
  readDeviceEnvironment,
  readWeatherCache,
  writeChooserAppearance,
  writeDeviceEnvironment,
  writeWeatherCache,
  type DeviceEnvironment,
} from "./storage";
import "./adaptive-theme.css";

const PROFILE_CHANGED_KEY = "streamer.appearance.profile-change.v1";

interface ThemeContextValue {
  appearance: AppearancePreferences;
  setAppearance: (patch: Partial<AppearancePreferences>) => void;
  setThemeFamily: (mode: "auto" | "cinematic") => void;
  previewAppearance: (appearance: AppearancePreferences | null) => void;
  rememberAppearance: (appearance: AppearancePreferences) => void;
  saving: boolean;
  appearanceError: string;
  retryAppearance: () => void;
  environment: DeviceEnvironment;
  updateEnvironment: (environment: DeviceEnvironment) => void;
  storageError: string;
  instant: Date;
  timeZone: string;
  resolvedTheme: ResolvedTheme;
  weather: WeatherSnapshot | null;
  weatherStatus: "disabled" | "loading" | EnvironmentWeatherResponse["status"];
  weatherError: string;
  refreshWeather: () => void;
  setPlaybackActive: (active: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("Theme controls require ThemeProvider.");
  return context;
}

export function ThemeProvider({
  api,
  profile,
  onProfileUpdated,
  children,
}: {
  api: StreamerApi;
  profile: ViewerProfile | null;
  onProfileUpdated: (profile: ViewerProfile) => void;
  children: ReactNode;
}) {
  const [appearance, setCurrentAppearance] = useState(() =>
    AppearancePreferencesSchema.parse(
      profile?.appearance ?? readChooserAppearance(),
    ),
  );
  const [preview, setPreview] = useState<AppearancePreferences | null>(null);
  const [environment, setEnvironment] = useState(readDeviceEnvironment);
  const [storageError, setStorageError] = useState("");
  const [appearanceError, setAppearanceError] = useState("");
  const [pending, setPending] = useState(0);
  const [playbackActive, setPlaybackActive] = useState(false);
  const profileRef = useRef(profile);
  const onUpdatedRef = useRef(onProfileUpdated);
  profileRef.current = profile;
  onUpdatedRef.current = onProfileUpdated;
  const queues = useRef(new Map<string, Promise<void>>());
  const pendingByProfile = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const pendingRef = useRef(0);
  const desired = useRef(appearance);
  const acknowledged = useRef(appearance);
  const retryPatch = useRef<Partial<AppearancePreferences> | null>(null);
  const activeId = useRef<string | null>(null);
  const invalidated = useRef(false);

  const rememberAppearance = useCallback((value: AppearancePreferences) => {
    if (!writeChooserAppearance(value))
      setStorageError("Appearance could not be saved on this device.");
    if (!profileRef.current) {
      desired.current = value;
      acknowledged.current = value;
      setCurrentAppearance(value);
    }
  }, []);

  useEffect(() => {
    const id = profile?.id ?? null;
    if (activeId.current !== id) {
      activeId.current = id;
      pendingRef.current = id ? (pendingByProfile.current.get(id) ?? 0) : 0;
      setPending(pendingRef.current);
      sequence.current += 1;
      const next = profile
        ? AppearancePreferencesSchema.parse(profile.appearance ?? {})
        : readChooserAppearance();
      desired.current = next;
      acknowledged.current = next;
      setCurrentAppearance(next);
      setAppearanceError("");
      if (profile) rememberAppearance(next);
    } else if (profile && pendingRef.current === 0) {
      const next = AppearancePreferencesSchema.parse(profile.appearance ?? {});
      acknowledged.current = next;
      desired.current = next;
      setCurrentAppearance(next);
    }
  }, [profile, rememberAppearance]);

  const reloadProfile = useCallback(async () => {
    const id = profileRef.current?.id;
    if (!id) return;
    if (pendingRef.current > 0) {
      invalidated.current = true;
      return;
    }
    try {
      const { items } = await api.getProfiles();
      if (profileRef.current?.id !== id || pendingRef.current > 0) return;
      const updated = items.find((item) => item.id === id);
      if (updated) onUpdatedRef.current(updated);
    } catch {
      /* Keep the last acknowledged appearance when the server is offline. */
    }
  }, [api]);

  const setAppearance = useCallback(
    (patch: Partial<AppearancePreferences>) => {
      const next = mergeAppearancePreferences(desired.current, patch);
      desired.current = next;
      setCurrentAppearance(next);
      setAppearanceError("");
      const target = profileRef.current;
      const operation = ++sequence.current;
      if (!target) {
        rememberAppearance(next);
        return;
      }
      pendingByProfile.current.set(
        target.id,
        (pendingByProfile.current.get(target.id) ?? 0) + 1,
      );
      pendingRef.current = pendingByProfile.current.get(target.id) ?? 0;
      setPending(pendingRef.current);
      const queued = (queues.current.get(target.id) ?? Promise.resolve()).then(
        async () => {
          try {
            const updated = await api.updateProfile(target.id, {
              appearance: patch,
            });
            const value = AppearancePreferencesSchema.parse(
              updated.appearance ?? next,
            );
            if (profileRef.current?.id === target.id) {
              acknowledged.current = value;
              onUpdatedRef.current(updated);
              if (operation === sequence.current) {
                desired.current = value;
                setCurrentAppearance(value);
              }
              rememberAppearance(value);
            }
            try {
              localStorage.setItem(
                PROFILE_CHANGED_KEY,
                JSON.stringify({
                  profileId: target.id,
                  nonce: `${Date.now()}:${operation}`,
                }),
              );
            } catch {
              /* Cross-tab notification is best effort. */
            }
          } catch (error) {
            if (
              profileRef.current?.id === target.id &&
              operation === sequence.current
            ) {
              retryPatch.current = patch;
              desired.current = acknowledged.current;
              setCurrentAppearance(acknowledged.current);
              setAppearanceError(safeErrorMessage(error));
            }
          } finally {
            const remaining = Math.max(
              0,
              (pendingByProfile.current.get(target.id) ?? 1) - 1,
            );
            if (remaining) pendingByProfile.current.set(target.id, remaining);
            else {
              pendingByProfile.current.delete(target.id);
              queues.current.delete(target.id);
            }
            if (profileRef.current?.id === target.id) {
              pendingRef.current = remaining;
              setPending(remaining);
            }
            if (
              profileRef.current?.id === target.id &&
              remaining === 0 &&
              invalidated.current
            ) {
              invalidated.current = false;
              void reloadProfile();
            }
          }
        },
      );
      queues.current.set(target.id, queued);
    },
    [api, rememberAppearance, reloadProfile],
  );

  const setThemeFamily = useCallback(
    (mode: "auto" | "cinematic") => {
      if (mode === "cinematic") {
        setAppearance({
          mode,
          seasonalMode:
            desired.current.mode === "cinematic"
              ? desired.current.seasonalMode
              : desired.current.mode,
        });
      } else {
        setAppearance({ mode: desired.current.seasonalMode });
      }
    },
    [setAppearance],
  );

  const updateEnvironment = useCallback((value: DeviceEnvironment) => {
    setEnvironment(value);
    setStorageError(
      writeDeviceEnvironment(value)
        ? ""
        : "Time and weather settings could not be saved on this device.",
    );
    if (!value.weatherEnabled) clearWeatherCache();
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === DEVICE_ENVIRONMENT_STORAGE_KEY)
        setEnvironment(readDeviceEnvironment());
      if (event.key === CHOOSER_APPEARANCE_STORAGE_KEY && !profileRef.current) {
        const value = readChooserAppearance();
        desired.current = value;
        acknowledged.current = value;
        setCurrentAppearance(value);
      }
      if (event.key === PROFILE_CHANGED_KEY && event.newValue) {
        try {
          const value: unknown = JSON.parse(event.newValue);
          if (
            typeof value === "object" &&
            value !== null &&
            "profileId" in value &&
            value.profileId === profileRef.current?.id
          )
            void reloadProfile();
        } catch {
          /* Ignore invalid browser storage. */
        }
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [reloadProfile]);

  const clock = useMemo(() => createAdvancingClock(environment), [environment]);
  const [realNow, setRealNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const milliseconds = clock.now().getTime();
      const remainder = ((milliseconds % 60_000) + 60_000) % 60_000;
      timer = window.setTimeout(tick, Math.max(50, 60_000 - remainder));
    };
    const tick = () => {
      clock.reconcile();
      setRealNow(new Date());
      window.clearTimeout(timer);
      schedule();
    };
    tick();
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [clock]);
  const instant = clock.now();
  const timeZone = effectiveClock(environment, realNow).timeZone;

  const effectiveAppearance = preview ?? appearance;
  const [weatherRecord, setWeatherRecord] = useState<{
    key: string;
    value: WeatherSnapshot | null;
  } | null>(null);
  const [weatherStatus, setWeatherStatus] =
    useState<ThemeContextValue["weatherStatus"]>("disabled");
  const [weatherError, setWeatherError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const location = environment.location;
  const locationKey = location
    ? `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`
    : "";
  const weather =
    weatherRecord?.key === locationKey ? weatherRecord.value : null;
  const weatherEnabled =
    environment.weatherEnabled &&
    location !== null &&
    effectiveAppearance.mode !== "cinematic";

  useEffect(() => {
    if (!weatherEnabled || !location) {
      setWeatherRecord(null);
      setWeatherStatus("disabled");
      setWeatherError("");
      return;
    }
    const cached = readWeatherCache(location);
    const setWeather = (value: WeatherSnapshot | null) =>
      setWeatherRecord({ key: locationKey, value });
    setWeather(cached);
    setWeatherStatus(
      cached
        ? Date.now() - Date.parse(cached.observedAt) <= 15 * 60_000
          ? "fresh"
          : "stale"
        : "loading",
    );
    let cancelled = false;
    let inFlight = false;
    let retryAt = 0;
    let lastFetch = refreshVersion
      ? 0
      : cached
        ? Math.min(Date.now(), Date.parse(cached.fetchedAt))
        : 0;
    const controller = new AbortController();
    const refresh = async () => {
      if (
        cancelled ||
        inFlight ||
        document.visibilityState === "hidden" ||
        navigator.onLine === false ||
        Date.now() < retryAt ||
        Date.now() - lastFetch < 15 * 60_000
      )
        return;
      if (!api.getEnvironmentWeather) {
        setWeatherStatus("unavailable");
        return;
      }
      inFlight = true;
      try {
        const response = EnvironmentWeatherResponseSchema.parse(
          await api.getEnvironmentWeather(
            location.latitude,
            location.longitude,
            controller.signal,
          ),
        );
        if (cancelled) return;
        lastFetch = Date.now();
        retryAt = Date.now() + (response.retryAfterSeconds ?? 0) * 1000;
        setWeather(response.weather);
        setWeatherStatus(response.status);
        setWeatherError(
          response.status === "unavailable"
            ? "Weather is unavailable. Seasonal and local-time themes are still active."
            : "",
        );
        if (response.weather) writeWeatherCache(location, response.weather);
      } catch (error) {
        if (cancelled) return;
        retryAt = Date.now() + 60_000;
        setWeatherStatus(cached ? "stale" : "unavailable");
        setWeatherError(safeErrorMessage(error));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 60_000);
    const resume = () => {
      void refresh();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [api, weatherEnabled, location, locationKey, refreshVersion]);

  const resolvedTheme = useMemo(
    () =>
      resolveTheme({
        appearance: effectiveAppearance,
        instant,
        timeZone,
        location,
        weather,
        realNow,
      }),
    [effectiveAppearance, instant, timeZone, location, weather, realNow],
  );
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme.id;
    root.dataset.period = resolvedTheme.period;
    root.dataset.weather = resolvedTheme.weatherEffect;
    const variables = Object.entries(resolvedTheme.cssVariables);
    for (const [name, value] of variables)
      root.style.setProperty(name, String(value));
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const originalMeta = meta?.content;
    if (meta)
      meta.content = String(resolvedTheme.cssVariables["--black"] ?? "#000000");
    return () => {
      delete root.dataset.theme;
      delete root.dataset.period;
      delete root.dataset.weather;
      for (const [name] of variables) root.style.removeProperty(name);
      if (meta && originalMeta) meta.content = originalMeta;
    };
  }, [resolvedTheme]);

  const value: ThemeContextValue = {
    appearance: effectiveAppearance,
    setAppearance,
    setThemeFamily,
    previewAppearance: setPreview,
    rememberAppearance,
    saving: pending > 0,
    appearanceError,
    retryAppearance: () => {
      if (retryPatch.current) setAppearance(retryPatch.current);
    },
    environment,
    updateEnvironment,
    storageError,
    instant,
    timeZone,
    resolvedTheme,
    weather,
    weatherStatus,
    weatherError,
    refreshWeather: () => setRefreshVersion((version) => version + 1),
    setPlaybackActive,
  };
  return (
    <ThemeContext.Provider value={value}>
      <AmbientBackground
        theme={resolvedTheme}
        enabled={effectiveAppearance.ambientMotion}
        paused={playbackActive}
      />
      <div className="theme-content">{children}</div>
    </ThemeContext.Provider>
  );
}
