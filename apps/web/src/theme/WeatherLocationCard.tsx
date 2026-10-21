import type {
  EnvironmentWeatherResponse,
  WeatherCondition,
  WeatherLocation,
  WeatherOverride,
  WeatherSnapshot,
} from "@streamer-ai/contracts";

const conditions: Record<WeatherCondition, string> = {
  clear: "Clear",
  cloudy: "Cloudy",
  fog: "Fog",
  rain: "Rain",
  snow: "Snow",
  storm: "Storm",
  unknown: "Unknown conditions",
};

function ConditionIcon({ condition }: { condition: WeatherCondition }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {condition === "clear" ? (
        <>
          <circle cx="20" cy="20" r="7" />
          <path d="M20 5v4m0 22v4M5 20h4m22 0h4M9.4 9.4l2.9 2.9m15.4 15.4 2.9 2.9M9.4 30.6l2.9-2.9m15.4-15.4 2.9-2.9" />
        </>
      ) : (
        <>
          <path d="M11 26a6 6 0 0 1-1-11.9A9 9 0 0 1 27.5 12 7 7 0 0 1 29 26H11Z" />
          {condition === "rain" && <path d="m13 30-2 5m10-5-2 5m10-5-2 5" />}
          {condition === "snow" && (
            <path d="M13 29v7m-3.1-5.3 6.2 3.6m0-3.6-6.2 3.6M27 29v7m-3.1-5.3 6.2 3.6m0-3.6-6.2 3.6" />
          )}
          {condition === "fog" && <path d="M8 30h24M12 35h16" />}
          {condition === "storm" && <path d="m22 26-5 7h6l-4 6" />}
        </>
      )}
    </svg>
  );
}

function ageLabel(instant: string, now: Date): string {
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(instant)) / 60_000),
  );
  if (minutes === 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

function countryName(location: WeatherLocation, locale: string): string {
  if (location.country) return location.country;
  if (location.countryCode) {
    try {
      return (
        new Intl.DisplayNames([locale], { type: "region" }).of(
          location.countryCode,
        ) ?? location.countryCode
      );
    } catch {
      return location.countryCode;
    }
  }
  return "Country unavailable";
}

export function WeatherLocationCard({
  location,
  weather,
  status,
  enabled,
  cinematic,
  preview,
  locale,
  timeZone,
  onRefresh,
  error = "",
  now = new Date(),
}: {
  location: WeatherLocation | null;
  weather: WeatherSnapshot | null;
  status: "disabled" | "loading" | EnvironmentWeatherResponse["status"];
  enabled: boolean;
  cinematic: boolean;
  preview: WeatherOverride;
  locale: "en" | "cs" | "de";
  timeZone: string;
  onRefresh: () => void;
  error?: string;
  now?: Date;
}) {
  const active = enabled && location !== null && !cinematic;
  const observation = active ? weather : null;
  const age = observation
    ? now.getTime() - Date.parse(observation.observedAt)
    : Infinity;
  const usableObservation = observation && age >= -300_000 && age <= 7_200_000;
  const stale = status !== "fresh" || age > 15 * 60_000;
  const state = !enabled
    ? "Local weather is off."
    : !location
      ? "Choose a city to see local weather."
      : cinematic
        ? "Weather requests are paused in Cinematic."
        : status === "loading"
          ? "Checking local weather…"
          : !usableObservation || status === "unavailable"
            ? "Current weather is unavailable."
            : stale
              ? "Showing an older observation. Refresh for the latest weather."
              : "Local weather is up to date.";
  return (
    <article
      className="weather-location-card"
      aria-label="Weather at selected location"
    >
      <div className="weather-location-card__identity">
        <div className="weather-location-card__icon">
          <ConditionIcon
            condition={usableObservation ? observation.condition : "unknown"}
          />
        </div>
        <div className="weather-location-card__place">
          <h4>{location?.name ?? location?.label ?? "No location selected"}</h4>
          <p>
            {location?.address ??
              (location
                ? `${location.latitude.toFixed(2)}, ${location.longitude.toFixed(2)}`
                : "Select a city or use your approximate location.")}
          </p>
          {location && (
            <p className="weather-location-card__country">
              {countryName(location, locale)}
            </p>
          )}
        </div>
        <button
          className="text-button weather-location-card__refresh"
          type="button"
          disabled={!active || status === "loading"}
          onClick={onRefresh}
        >
          Refresh weather
        </button>
      </div>
      <p className="weather-location-card__state" role="status">
        {state}
      </p>
      {observation && (
        <>
          <p className="weather-location-card__observation">
            <span>
              {usableObservation && status !== "unavailable"
                ? "Observed weather"
                : "Last observed weather"}
            </span>
            <strong>{conditions[observation.condition]}</strong>
          </p>
          <p className="weather-location-card__measurements">
            Precipitation {observation.precipitation.toLocaleString(locale)} mm
            · Cloud cover {observation.cloudCover.toLocaleString(locale)}%
          </p>
          <p className="weather-location-card__age">
            {stale || !usableObservation ? "Stale" : "Fresh"} · Observed{" "}
            {ageLabel(observation.observedAt, now)} at{" "}
            <time dateTime={observation.observedAt}>
              {new Date(observation.observedAt).toLocaleTimeString(locale, {
                timeZone,
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            {" · "}Updated {ageLabel(observation.fetchedAt, now)}
          </p>
        </>
      )}
      {!cinematic && preview !== "auto" && (
        <p className="weather-location-card__preview">
          Background preview: {conditions[preview]}. This does not change the
          weather observation.
        </p>
      )}
      {active && error && (
        <p className="weather-location-card__error">{error}</p>
      )}
    </article>
  );
}
