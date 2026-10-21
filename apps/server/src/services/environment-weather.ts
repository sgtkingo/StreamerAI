import type {
  EnvironmentWeatherResponse,
  WeatherLocation,
  WeatherSnapshot,
} from "@streamer-ai/contracts";
import {
  EnvironmentRequestError,
  OpenMeteoClient,
} from "../integrations/open-meteo-client.js";

export const WEATHER_TTL_MS = 15 * 60_000;
export const WEATHER_MAX_AGE_MS = 2 * 60 * 60_000;
export const WEATHER_ATTRIBUTION = {
  name: "Open-Meteo",
  url: "https://open-meteo.com/",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export class EnvironmentLocationsUnavailableError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("City search is temporarily unavailable.");
    this.name = "EnvironmentLocationsUnavailableError";
  }
}

type RequestKind = "weather" | "locations";
type PendingRequest = {
  start: () => void;
  reject: (error: Error) => void;
  queuedAt: number;
};

/** Shared installation budget; no client identity or forwarded headers are used. */
class EnvironmentRequestGate {
  private readonly queues: Record<RequestKind, PendingRequest[]> = {
    weather: [],
    locations: [],
  };
  private readonly active: Record<RequestKind, number> = {
    weather: 0,
    locations: 0,
  };
  private readonly budgets = [
    { duration: 60_000, limit: 30, start: 0, count: 0 },
    { duration: 60 * 60_000, limit: 500, start: 0, count: 0 },
    { duration: 24 * 60 * 60_000, limit: 8_000, start: 0, count: 0 },
  ];
  private nextKind: RequestKind = "weather";
  constructor(private readonly now: () => Date) {}

  run<T>(kind: RequestKind, operation: () => Promise<T>): Promise<T> {
    if (this.queues[kind].length >= (kind === "weather" ? 16 : 8))
      return Promise.reject(new EnvironmentRequestError("rate-limited", 30));
    return new Promise<T>((resolve, reject) => {
      this.queues[kind].push({
        queuedAt: this.now().getTime(),
        reject,
        start: () => {
          this.active[kind] += 1;
          void (async () => {
            try {
              this.consumeBudget();
              resolve(await operation());
            } catch (error) {
              reject(error);
            } finally {
              this.active[kind] -= 1;
              this.pump();
            }
          })();
        },
      });
      this.pump();
    });
  }

  private consumeBudget(): void {
    const now = this.now().getTime();
    for (const budget of this.budgets) {
      if (now < budget.start || now - budget.start >= budget.duration) {
        budget.start = now;
        budget.count = 0;
      }
      if (budget.count >= budget.limit)
        throw new EnvironmentRequestError(
          "rate-limited",
          Math.min(
            3600,
            Math.max(
              1,
              Math.ceil((budget.start + budget.duration - now) / 1000),
            ),
          ),
        );
    }
    for (const budget of this.budgets) budget.count += 1;
  }

  private pump(): void {
    for (const kind of [
      this.nextKind,
      this.nextKind === "weather" ? "locations" : "weather",
    ] as const) {
      const limit = kind === "weather" ? 2 : 1;
      while (this.active[kind] < limit && this.queues[kind].length > 0) {
        const pending = this.queues[kind].shift();
        if (!pending) break;
        if (this.now().getTime() - pending.queuedAt > 5_000) {
          pending.reject(new EnvironmentRequestError("rate-limited", 30));
          continue;
        }
        this.nextKind = kind === "weather" ? "locations" : "weather";
        pending.start();
      }
    }
  }
}

function readLru<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}
function writeLru<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export class EnvironmentWeatherService {
  private readonly weatherCache = new Map<string, WeatherSnapshot>();
  private readonly locationCache = new Map<
    string,
    { items: WeatherLocation[]; fetchedAt: number }
  >();
  private readonly weatherInflight = new Map<
    string,
    Promise<EnvironmentWeatherResponse>
  >();
  private readonly locationInflight = new Map<
    string,
    Promise<WeatherLocation[]>
  >();
  private readonly backoff: Record<
    RequestKind,
    { until: number; failures: number }
  > = {
    weather: { until: 0, failures: 0 },
    locations: { until: 0, failures: 0 },
  };
  private readonly gate: EnvironmentRequestGate;
  private readonly now: () => Date;
  private readonly random: () => number;
  constructor(
    private readonly client: OpenMeteoClient,
    options: { now?: () => Date; random?: () => number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.gate = new EnvironmentRequestGate(this.now);
  }

  async weather(
    latitude: number,
    longitude: number,
  ): Promise<EnvironmentWeatherResponse> {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const previous = readLru(this.weatherCache, key);
    if (
      previous &&
      this.now().getTime() - Date.parse(previous.fetchedAt) < WEATHER_TTL_MS
    )
      return this.response(previous);
    const existing = this.weatherInflight.get(key);
    if (existing) return existing;
    const retryAfter = this.retryAfter("weather");
    if (retryAfter) return this.response(previous, retryAfter);
    const pending = this.fetchWeather(key, latitude, longitude, previous);
    this.weatherInflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.weatherInflight.delete(key);
    }
  }

  private async fetchWeather(
    key: string,
    latitude: number,
    longitude: number,
    previous: WeatherSnapshot | undefined,
  ): Promise<EnvironmentWeatherResponse> {
    try {
      const snapshot = await this.gate.run("weather", () => {
        if (this.retryAfter("weather"))
          throw new EnvironmentRequestError(
            "rate-limited",
            this.retryAfter("weather"),
          );
        return this.client.weather(latitude, longitude);
      });
      writeLru(this.weatherCache, key, snapshot, 256);
      this.backoff.weather = { until: 0, failures: 0 };
      return this.response(snapshot);
    } catch (error) {
      return this.response(previous, this.recordFailure("weather", error));
    }
  }

  async locations(query: string, language = "en"): Promise<WeatherLocation[]> {
    const clean = query.trim();
    if (clean.length < 2) return [];
    const key = `${language}:${clean.toLocaleLowerCase("en")}`;
    const cached = readLru(this.locationCache, key);
    if (cached && this.now().getTime() - cached.fetchedAt < 6 * 60 * 60_000)
      return cached.items;
    const existing = this.locationInflight.get(key);
    if (existing) return existing;
    const retryAfter = this.retryAfter("locations");
    if (retryAfter) throw new EnvironmentLocationsUnavailableError(retryAfter);
    const pending = this.fetchLocations(key, clean, language);
    this.locationInflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.locationInflight.delete(key);
    }
  }

  private async fetchLocations(
    key: string,
    query: string,
    language: string,
  ): Promise<WeatherLocation[]> {
    try {
      const items = await this.gate.run("locations", () => {
        if (this.retryAfter("locations"))
          throw new EnvironmentRequestError(
            "rate-limited",
            this.retryAfter("locations"),
          );
        return this.client.locations(query, language);
      });
      writeLru(
        this.locationCache,
        key,
        { items, fetchedAt: this.now().getTime() },
        64,
      );
      this.backoff.locations = { until: 0, failures: 0 };
      return items;
    } catch (error) {
      throw new EnvironmentLocationsUnavailableError(
        this.recordFailure("locations", error),
      );
    }
  }

  private response(
    snapshot: WeatherSnapshot | undefined,
    retryAfterSeconds?: number,
  ): EnvironmentWeatherResponse {
    const now = this.now().getTime();
    const age = snapshot ? now - Date.parse(snapshot.observedAt) : Infinity;
    const usable =
      snapshot !== undefined && age <= WEATHER_MAX_AGE_MS && age >= -5 * 60_000;
    return {
      status: !usable
        ? "unavailable"
        : retryAfterSeconds ||
            age > WEATHER_TTL_MS ||
            now - Date.parse(snapshot.fetchedAt) >= WEATHER_TTL_MS
          ? "stale"
          : "fresh",
      // Old solar instants remain useful for a location/date. Old conditions and
      // polar isDay must never be treated as current by the theme resolver.
      weather: snapshot
        ? usable
          ? snapshot
          : {
              ...snapshot,
              condition: "unknown",
              precipitation: 0,
              cloudCover: 0,
            }
        : null,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      attribution: WEATHER_ATTRIBUTION,
    };
  }

  private retryAfter(kind: RequestKind): number {
    return Math.min(
      3600,
      Math.max(
        0,
        Math.ceil((this.backoff[kind].until - this.now().getTime()) / 1000),
      ),
    );
  }
  private recordFailure(kind: RequestKind, error: unknown): number {
    const state = this.backoff[kind];
    state.failures = Math.min(state.failures + 1, 5);
    const delay =
      Math.min(300, 30 * 2 ** (state.failures - 1)) * (1 + this.random() * 0.2);
    const seconds = Math.min(
      3600,
      Math.max(
        Math.ceil(delay),
        error instanceof EnvironmentRequestError ? error.retryAfterSeconds : 0,
      ),
    );
    state.until = Math.max(state.until, this.now().getTime() + seconds * 1000);
    return this.retryAfter(kind);
  }
}
