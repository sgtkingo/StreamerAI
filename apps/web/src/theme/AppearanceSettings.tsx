import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  EnvironmentLocationsResponseSchema,
  type WeatherLocation,
} from "@streamer-ai/contracts";
import { safeErrorMessage, type StreamerApi } from "../api/client";
import {
  createClockAnchor,
  isValidTimeZone,
  resolveWallTime,
  toDateTimeLocal,
} from "./clock";
import { ThemeSelect } from "./ThemeSelect";
import { AppearanceInfluenceFields } from "./AppearanceInfluenceFields";
import { useTheme } from "./ThemeProvider";
import { useLocalClock } from "./useLocalClock";
import { WeatherLocationCard } from "./WeatherLocationCard";
import "./settings.css";

export function AppearanceSettings({
  api,
  locale,
}: {
  api: StreamerApi;
  locale: "en" | "cs" | "de";
}) {
  const theme = useTheme();
  const { environment, updateEnvironment, instant, timeZone } = theme;
  const liveInstant = useLocalClock(environment);
  const headingId = useId();
  const [zoneDraft, setZoneDraft] = useState(timeZone);
  const [wallDraft, setWallDraft] = useState(() =>
    toDateTimeLocal(instant, timeZone),
  );
  const [wallDirty, setWallDirty] = useState(false);
  const [offsetChoice, setOffsetChoice] = useState("");
  const [timeError, setTimeError] = useState("");
  const [timeNotice, setTimeNotice] = useState("");
  const [query, setQuery] = useState("");
  const [locations, setLocations] = useState<WeatherLocation[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [locating, setLocating] = useState(false);
  const [searchComplete, setSearchComplete] = useState(false);
  const locationRequest = useRef(0);
  const environmentRef = useRef(environment);
  environmentRef.current = environment;
  const zoneListId = useId();
  useEffect(() => {
    if (!environment.weatherEnabled) {
      locationRequest.current += 1;
      setLocating(false);
    }
    return () => {
      locationRequest.current += 1;
    };
  }, [environment.weatherEnabled]);
  const resolution = useMemo(
    () => resolveWallTime(wallDraft, zoneDraft),
    [wallDraft, zoneDraft],
  );
  const zoneSuggestions = useMemo(() => {
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    };
    return [
      ...new Set([
        timeZone,
        "UTC",
        "Europe/Prague",
        ...(intl.supportedValuesOf?.("timeZone") ?? []),
      ]),
    ];
  }, [timeZone]);

  useEffect(() => {
    setZoneDraft(timeZone);
    setWallDraft(toDateTimeLocal(instant, timeZone));
    setWallDirty(false);
    setOffsetChoice("");
    // Refresh the form after saved or cross-tab changes, not on each clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    environment.autoDetectTime,
    environment.timeZone,
    environment.manualClock,
  ]);

  useEffect(() => {
    setLocations([]);
    setSearchError("");
    setSearchComplete(false);
    if (!environment.weatherEnabled || query.trim().length < 3) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      if (!api.searchEnvironmentLocations) {
        setSearching(false);
        setSearchError("City search is unavailable.");
        return;
      }
      void api
        .searchEnvironmentLocations(query.trim(), locale, controller.signal)
        .then((response) => {
          if (!active) return;
          setLocations(
            EnvironmentLocationsResponseSchema.parse(response).items,
          );
          setSearchComplete(true);
        })
        .catch((error: unknown) => {
          if (active) setSearchError(safeErrorMessage(error));
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, locale, environment.weatherEnabled]);

  const applyTime = () => {
    setTimeError("");
    setTimeNotice("");
    if (!isValidTimeZone(zoneDraft)) {
      setTimeError("Choose a valid IANA timezone, for example Europe/Prague.");
      return;
    }
    if (!wallDirty) {
      updateEnvironment({ ...environment, timeZone: zoneDraft });
      setTimeNotice("Time settings saved on this device.");
      return;
    }
    if (
      resolution.status === "invalid" ||
      resolution.status === "nonexistent"
    ) {
      setTimeError(
        resolution.status === "nonexistent"
          ? "This local time does not exist because the clocks move forward. Choose another time."
          : "Enter a valid local date and time.",
      );
      return;
    }
    const candidate =
      resolution.status === "ambiguous"
        ? resolution.candidates.find((item) => item.instant === offsetChoice)
        : resolution.candidates[0];
    if (!candidate) {
      setTimeError("This time occurs twice. Choose the UTC offset below.");
      return;
    }
    updateEnvironment({
      ...environment,
      timeZone: zoneDraft,
      manualClock: createClockAnchor(new Date(candidate.instant)),
    });
    setTimeNotice("Time settings saved on this device.");
  };

  const chooseLocation = (location: WeatherLocation) => {
    locationRequest.current += 1;
    setLocating(false);
    updateEnvironment({
      ...environmentRef.current,
      weatherEnabled: true,
      location: {
        ...location,
        latitude: Math.round(location.latitude * 100) / 100,
        longitude: Math.round(location.longitude * 100) / 100,
      },
    });
    setQuery("");
    setLocations([]);
    setSearchError("");
  };

  const locate = () => {
    setSearchError("");
    if (!navigator.geolocation) {
      setSearchError(
        "Location is unavailable here. Search for your city instead.",
      );
      return;
    }
    setLocating(true);
    const request = ++locationRequest.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (request !== locationRequest.current) return;
        setLocating(false);
        chooseLocation({
          id: "device-location",
          label: "Current approximate location",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timezone: timeZone,
        });
      },
      () => {
        if (request !== locationRequest.current) return;
        setLocating(false);
        setSearchError(
          "Location was unavailable or permission was denied. Search for your city instead.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 15 * 60_000 },
    );
  };

  const autoLabel =
    locale === "cs"
      ? "Autodetekce"
      : locale === "de"
        ? "Automatische Erkennung"
        : "Auto-detect";
  const cinematic = theme.appearance.mode === "cinematic";
  const fixed =
    !cinematic &&
    theme.appearance.mode !== "auto" &&
    theme.appearance.weatherOverride !== "auto" &&
    theme.appearance.daylightOverride !== "auto";
  return (
    <>
      <section
        className="profile-page__section theme-settings"
        id="settings-theme"
        aria-labelledby={headingId}
      >
        <h2 id={headingId}>
          {locale === "cs"
            ? "Vzhled"
            : locale === "de"
              ? "Erscheinungsbild"
              : "Appearance"}
        </h2>
        <section
          className="theme-settings__subsection"
          aria-label="Theme controls"
        >
          <h3 id={`${headingId}-theme`}>
            {locale === "cs" ? "Téma" : locale === "de" ? "Design" : "Theme"}
          </h3>
          <div className="theme-family-controls">
            <ThemeSelect
              selection="primary"
              value={theme.appearance.mode}
              locale={locale}
              onChange={(mode) =>
                theme.setThemeFamily(
                  mode === "cinematic" ? "cinematic" : "auto",
                )
              }
            />
            <div className="theme-motion-options">
              <label className="theme-checkbox theme-motion-toggle">
                <input
                  type="checkbox"
                  checked={theme.appearance.ambientMotion}
                  onChange={(event) =>
                    theme.setAppearance({ ambientMotion: event.target.checked })
                  }
                />
                <span>Ambient motion</span>
              </label>
              <label className="theme-checkbox theme-fix-toggle">
                <input
                  type="checkbox"
                  checked={fixed}
                  disabled={cinematic}
                  title={
                    fixed
                      ? "Uncheck to return to automatic theme settings"
                      : "Check to fix the current season, weather and lighting"
                  }
                  onChange={(event) => {
                    if (theme.resolvedTheme.id === "cinematic") return;
                    if (!event.target.checked) {
                      theme.setAppearance({
                        mode: "auto",
                        weatherOverride: "auto",
                        daylightOverride: "auto",
                      });
                      return;
                    }
                    theme.setAppearance({
                      mode: theme.resolvedTheme.id,
                      weatherOverride:
                        theme.resolvedTheme.weatherEffect === "none"
                          ? "clear"
                          : theme.resolvedTheme.weatherEffect,
                      daylightOverride: theme.resolvedTheme.period,
                    });
                  }}
                />
                <svg
                  className="theme-lock-icon"
                  data-lock-state={fixed ? "locked" : "unlocked"}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <rect x="5" y="10" width="14" height="11" rx="2" />
                  <path
                    d={
                      fixed
                        ? "M8 10V6a4 4 0 0 1 8 0v4"
                        : "M8 10V6a4 4 0 0 1 7.5-2"
                    }
                  />
                  <path d="M12 14v3" />
                </svg>
                <span>Use current theme as fixed</span>
              </label>
            </div>
          </div>
          <p className="settings-note">
            Seasonal blends the season, local time and optional weather.
            Cinematic keeps the original black, white and red.
          </p>
          <div className="theme-detail-grid">
            <ThemeSelect
              selection="season"
              label={
                locale === "cs"
                  ? "Sezona"
                  : locale === "de"
                    ? "Jahreszeit"
                    : "Season"
              }
              value={
                cinematic
                  ? theme.appearance.seasonalMode
                  : theme.appearance.mode
              }
              locale={locale}
              disabled={cinematic}
              onChange={(mode) => theme.setAppearance({ mode })}
            />
            <AppearanceInfluenceFields
              weather={theme.appearance.weatherOverride}
              daylight={theme.appearance.daylightOverride}
              locale={locale}
              disabled={cinematic}
              onWeatherChange={(weatherOverride) =>
                theme.setAppearance({ weatherOverride })
              }
              onDaylightChange={(daylightOverride) =>
                theme.setAppearance({ daylightOverride })
              }
            />
          </div>
          <p className="settings-note">
            Choose a season to pin its base. Manual weather and lighting preview
            instantly without a location and do not change your actual weather
            data.
          </p>
          <div className="theme-fix-actions">
            <button
              type="button"
              className="text-button"
              disabled={cinematic}
              onClick={() =>
                theme.setAppearance({
                  mode: "auto",
                  weatherOverride: "auto",
                  daylightOverride: "auto",
                })
              }
            >
              Use automatic settings
            </button>
          </div>
          {fixed && (
            <p className="settings-note" role="status">
              Appearance fixed: season, weather and lighting stay as selected.
            </p>
          )}
          {!cinematic && (
            <p className="theme-current-look">
              {theme.resolvedTheme.id.replace("-", " ")} ·{" "}
              {theme.resolvedTheme.period} ·{" "}
              {theme.appearance.weatherOverride !== "auto"
                ? `${theme.appearance.weatherOverride} preview`
                : "automatic weather"}
            </p>
          )}
          {!cinematic &&
            ["christmas", "new-year"].includes(theme.resolvedTheme.id) && (
              <p className="settings-note">
                Holiday themes include decorative snow. Christmas adds colorful
                lights; New Year adds background fireworks.
              </p>
            )}
          <p className="settings-note theme-muted-note theme-saved-note">
            Saved per profile. Motion pauses during playback and respects
            reduced-motion preferences.
          </p>
          {theme.saving && <p role="status">Saving appearance…</p>}
          {theme.appearanceError && (
            <p role="alert">
              {theme.appearanceError}{" "}
              <button
                className="text-button"
                type="button"
                onClick={theme.retryAppearance}
              >
                Try again
              </button>
            </p>
          )}
        </section>
      </section>
      <section
        className="profile-page__section theme-settings"
        aria-label="Time and weather settings"
      >
        <section
          className="theme-settings__subsection"
          id="settings-time"
          aria-labelledby={`${headingId}-time`}
        >
          <p className="eyebrow">Time / This device</p>
          <h2 id={`${headingId}-time`}>Local time</h2>
          <p className="theme-clock">
            <time dateTime={liveInstant.toISOString()}>
              {liveInstant.toLocaleString(locale, {
                timeZone,
                dateStyle: "medium",
                timeStyle: "medium",
              })}
            </time>{" "}
            <span>{timeZone}</span>
          </p>
          <label className="theme-checkbox">
            <input
              type="checkbox"
              checked={environment.autoDetectTime}
              onChange={(event) => {
                const autoDetectTime = event.target.checked;
                setTimeError("");
                setTimeNotice("");
                updateEnvironment({
                  ...environment,
                  autoDetectTime,
                  timeZone,
                  manualClock: autoDetectTime
                    ? null
                    : createClockAnchor(liveInstant),
                });
              }}
            />
            <span>{autoLabel}</span>
          </label>
          <p className="settings-note">
            Use this device's clock and timezone automatically.
          </p>
          {!environment.autoDetectTime && (
            <div className="form-stack theme-time-fields">
              <label className="field">
                <span>Timezone</span>
                <input
                  list={zoneListId}
                  value={zoneDraft}
                  maxLength={100}
                  onChange={(event) => {
                    const next = event.target.value;
                    setZoneDraft(next);
                    setOffsetChoice("");
                    if (!wallDirty && isValidTimeZone(next))
                      setWallDraft(toDateTimeLocal(instant, next));
                  }}
                />
                <datalist id={zoneListId}>
                  {zoneSuggestions.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>Local date and time</span>
                <input
                  type="datetime-local"
                  value={wallDraft}
                  onChange={(event) => {
                    setWallDraft(event.target.value);
                    setWallDirty(true);
                    setOffsetChoice("");
                  }}
                />
              </label>
              {resolution.status === "ambiguous" && wallDirty && (
                <fieldset className="preference-fieldset">
                  <legend>
                    This time occurs twice. Choose its UTC offset.
                  </legend>
                  {resolution.candidates.map((candidate) => (
                    <label className="theme-checkbox" key={candidate.instant}>
                      <input
                        type="radio"
                        name="clock-offset"
                        value={candidate.instant}
                        checked={offsetChoice === candidate.instant}
                        onChange={() => setOffsetChoice(candidate.instant)}
                      />
                      <span>{candidate.offsetLabel}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <button
                className="button button--secondary"
                type="button"
                onClick={applyTime}
              >
                Save time settings
              </button>
            </div>
          )}
          {timeError && <p role="alert">{timeError}</p>}
          {timeNotice && <p role="status">{timeNotice}</p>}
          {theme.resolvedTheme.approximateDaylight && (
            <p className="settings-note theme-muted-note">
              Daylight is approximate: 07:00–19:00. Select a weather location
              for sunrise and sunset.
            </p>
          )}
        </section>
        <section
          className="theme-settings__subsection"
          id="settings-weather"
          aria-labelledby={`${headingId}-weather`}
        >
          <p className="eyebrow">Weather / This device</p>
          <h2 id={`${headingId}-weather`}>Weather atmosphere</h2>
          <label className="theme-checkbox">
            <input
              type="checkbox"
              checked={environment.weatherEnabled}
              onChange={(event) =>
                updateEnvironment({
                  ...environment,
                  weatherEnabled: event.target.checked,
                  location: event.target.checked ? environment.location : null,
                })
              }
            />
            <span>Use local weather</span>
          </label>
          <WeatherLocationCard
            location={environment.location}
            weather={theme.weather}
            status={theme.weatherStatus}
            enabled={environment.weatherEnabled}
            cinematic={cinematic}
            preview={theme.appearance.weatherOverride}
            locale={locale}
            timeZone={timeZone}
            onRefresh={theme.refreshWeather}
            error={theme.weatherError}
          />
          <p className="settings-note theme-saved-note">
            Your approximate location is sent through your home server to
            Open-Meteo. You can choose a city without sharing your device's
            location.
          </p>
          {environment.weatherEnabled && (
            <div className="form-stack">
              <div className="theme-location-search">
                <label className="field">
                  <span>City</span>
                  <input
                    type="search"
                    autoComplete="off"
                    value={query}
                    maxLength={100}
                    placeholder="Search for a city…"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button
                  className="theme-location-action"
                  type="button"
                  aria-label="Use my location"
                  title={
                    locating ? "Finding your location…" : "Use my location"
                  }
                  aria-busy={locating}
                  disabled={locating}
                  onClick={locate}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                    <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                  </svg>
                </button>
              </div>
              {locating && (
                <p className="settings-note" role="status">
                  Finding your location…
                </p>
              )}
              {searching && <p role="status">Finding cities…</p>}
              {locations.length > 0 && (
                <ul
                  className="theme-location-results"
                  aria-label="Matching cities"
                >
                  {locations.map((location) => (
                    <li key={location.id}>
                      <button
                        className="button button--ghost"
                        type="button"
                        onClick={() => chooseLocation(location)}
                      >
                        {location.label} <small>{location.timezone}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searchComplete && !searching && locations.length === 0 && (
                <p role="status">
                  No matching city. Try a nearby city or add a country name.
                </p>
              )}
              {searchError && <p role="alert">{searchError}</p>}
            </div>
          )}
          <p className="settings-note theme-muted-note theme-saved-note">
            Weather data by{" "}
            <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
              Open-Meteo
            </a>{" "}
            ·{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY 4.0
            </a>
            . Conditions are adapted into background effects.
          </p>
        </section>
      </section>
      {theme.storageError && <p role="alert">{theme.storageError}</p>}
    </>
  );
}
