import {
  EnvironmentTimezoneSchema,
  WeatherLocationSchema,
  WeatherSnapshotSchema,
  type WeatherCondition,
  type WeatherLocation,
  type WeatherSnapshot,
} from "@streamer-ai/contracts";
import {
  ProviderRequestError,
  isAbortFailure,
  providerFailureForStatus,
} from "./provider-http.js";

export type EnvironmentFetch = typeof fetch;
export class EnvironmentRequestError extends ProviderRequestError {
  constructor(
    kind: ConstructorParameters<typeof ProviderRequestError>[1],
    readonly retryAfterSeconds = 30,
    status?: number,
  ) {
    super("open-meteo", kind, true, status);
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_ID = "open-meteo";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function instant(value: unknown): string | null {
  if (!finite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function dateInZone(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  return ["year", "month", "day"]
    .map((part) => parts.find((item) => item.type === part)?.value)
    .join("-");
}

export function conditionForWeatherCode(code: number): WeatherCondition {
  if (code === 0) return "clear";
  if ([1, 2, 3].includes(code)) return "cloudy";
  if ([45, 48].includes(code)) return "fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code))
    return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 97, 99].includes(code)) return "storm";
  return "unknown";
}

export function normalizeWeather(value: unknown, now: Date): WeatherSnapshot {
  const root = object(value);
  const current = object(root?.current);
  const timezone = EnvironmentTimezoneSchema.safeParse(root?.timezone);
  const observedAt = instant(current?.time);
  if (
    !timezone.success ||
    !current ||
    !observedAt ||
    Date.parse(observedAt) > now.getTime() + 5 * 60_000 ||
    !finite(current.weather_code) ||
    !Number.isInteger(current.weather_code) ||
    !finite(current.precipitation) ||
    !finite(current.cloud_cover) ||
    (current.is_day !== 0 && current.is_day !== 1)
  ) {
    throw new EnvironmentRequestError("invalid-response");
  }
  const daily = object(root?.daily);
  const times = Array.isArray(daily?.time) ? daily.time : [];
  const rises = Array.isArray(daily?.sunrise) ? daily.sunrise : [];
  const sets = Array.isArray(daily?.sunset) ? daily.sunset : [];
  const solar: WeatherSnapshot["solar"] = [];
  for (let index = 0; index < Math.min(7, times.length); index += 1) {
    const midnight = instant(times[index]);
    if (!midnight) continue;
    const date = dateInZone(midnight, timezone.data);
    if (solar.some((item) => item.date === date)) continue;
    const rise = instant(rises[index]);
    const set = instant(sets[index]);
    // Unix instants stay absolute. Calendar keys belong to the location's zone.
    solar.push({
      date,
      sunrise: rise && dateInZone(rise, timezone.data) === date ? rise : null,
      sunset: set && dateInZone(set, timezone.data) === date ? set : null,
    });
  }
  const result = WeatherSnapshotSchema.safeParse({
    condition: conditionForWeatherCode(current.weather_code),
    precipitation: current.precipitation,
    cloudCover: current.cloud_cover,
    observedAt,
    fetchedAt: now.toISOString(),
    isDay: current.is_day === 1,
    timezone: timezone.data,
    solar,
  });
  if (!result.success) throw new EnvironmentRequestError("invalid-response");
  return result.data;
}

function normalizeLocations(value: unknown): WeatherLocation[] {
  const root = object(value);
  if (!root || root.error === true)
    throw new EnvironmentRequestError("invalid-response");
  const results = root.results;
  if (results === undefined) return [];
  if (!Array.isArray(results))
    throw new EnvironmentRequestError("invalid-response");
  const items: WeatherLocation[] = [];
  for (const value of results.slice(0, 10)) {
    const row = object(value);
    if (
      !row ||
      !finite(row.id) ||
      !Number.isInteger(row.id) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      !finite(row.latitude) ||
      !finite(row.longitude)
    )
      continue;
    const name = locationText(row.name, 120);
    if (!name) continue;
    const admin1 = locationText(row.admin1, 120);
    const admin2 = locationText(row.admin2, 120);
    const country = locationText(row.country, 120);
    const rawCountryCode = locationText(row.country_code, 2)?.toUpperCase();
    const countryCode =
      rawCountryCode && /^[A-Z]{2}$/.test(rawCountryCode)
        ? rawCountryCode
        : undefined;
    const label = uniqueLocationParts([name, admin1, country]).join(", ");
    // Open-Meteo supplies administrative areas, not streets. Do not infer an
    // address or country from coordinates, the display label or the timezone.
    const address = locationText(
      uniqueLocationParts([admin2, admin1]).join(", "),
      240,
    );
    const location = WeatherLocationSchema.safeParse({
      id: String(row.id),
      label,
      name,
      ...(address ? { address } : {}),
      ...(country ? { country } : {}),
      ...(countryCode ? { countryCode } : {}),
      latitude: Math.round(row.latitude * 100) / 100,
      longitude: Math.round(row.longitude * 100) / 100,
      timezone: row.timezone,
    });
    if (location.success && !items.some((item) => item.id === location.data.id))
      items.push(location.data);
    if (items.length === 5) break;
  }
  return items;
}

function locationText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= limit ? text : undefined;
}

function uniqueLocationParts(parts: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  return parts.filter((part): part is string => {
    if (!part) return false;
    const key = part.toLocaleLowerCase("en");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class OpenMeteoClient {
  private readonly fetcher: EnvironmentFetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  constructor(
    options: {
      fetch?: EnvironmentFetch;
      timeoutMs?: number;
      now?: () => Date;
    } = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5_000, 5_000));
    this.now = options.now ?? (() => new Date());
  }

  async weather(latitude: number, longitude: number): Promise<WeatherSnapshot> {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: latitude.toFixed(2),
      longitude: longitude.toFixed(2),
      current: "weather_code,is_day,precipitation,cloud_cover",
      daily: "sunrise,sunset",
      forecast_days: "2",
      timezone: "auto",
      timeformat: "unixtime",
    }).toString();
    return normalizeWeather(await this.request(url), this.now());
  }

  async locations(query: string, language: string): Promise<WeatherLocation[]> {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.search = new URLSearchParams({
      name: query,
      count: "5",
      language,
      format: "json",
    }).toString();
    return normalizeLocations(await this.request(url));
  }

  private async request(url: URL): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new EnvironmentRequestError("timeout"));
      }, this.timeoutMs);
    });
    const operation = async () => {
      const response = await this.fetcher(url.toString(), {
        signal: controller.signal,
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const raw = response.headers.get("retry-after");
          const seconds =
            raw && /^\d+$/.test(raw)
              ? Number(raw)
              : raw
                ? (Date.parse(raw) - this.now().getTime()) / 1000
                : 60;
          throw new EnvironmentRequestError(
            "rate-limited",
            Number.isFinite(seconds)
              ? Math.min(3600, Math.max(1, Math.ceil(seconds)))
              : 60,
            429,
          );
        }
        throw providerFailureForStatus(PROVIDER_ID, response.status);
      }
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new EnvironmentRequestError("invalid-response");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new EnvironmentRequestError("invalid-response");
      const decoder = new TextDecoder();
      let total = 0;
      let body = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new EnvironmentRequestError("invalid-response");
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new EnvironmentRequestError("invalid-response");
      }
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new EnvironmentRequestError(
        isAbortFailure(error) ? "timeout" : "network",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
