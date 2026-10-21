import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentWeatherResponseSchema } from "@streamer-ai/contracts";
import {
  OpenMeteoClient,
  conditionForWeatherCode,
  normalizeWeather,
} from "../src/integrations/open-meteo-client.js";
import { EnvironmentWeatherService } from "../src/services/environment-weather.js";
import { registerEnvironmentRoutes } from "../src/routes/environment.js";
import { createApp } from "../src/app.js";

const initialTime = Date.parse("2026-10-20T12:00:00Z");
const seconds = (date: string) => Date.parse(date) / 1000;
function fixture(observedAt = initialTime, code = 61) {
  return {
    timezone: "Europe/Prague",
    current: {
      time: observedAt / 1000,
      weather_code: code,
      is_day: 1,
      precipitation: 1.2,
      cloud_cover: 70,
    },
    daily: {
      time: [seconds("2026-10-19T22:00:00Z"), seconds("2026-10-20T22:00:00Z")],
      sunrise: [
        seconds("2026-10-20T05:30:00Z"),
        seconds("2026-10-21T05:32:00Z"),
      ],
      sunset: [
        seconds("2026-10-20T16:00:00Z"),
        seconds("2026-10-21T15:58:00Z"),
      ],
    },
  };
}

describe("Open-Meteo adapter", () => {
  it("requests fixed hosts, coarse coordinates and Unix solar instants in the location timezone", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(fixture()));
    const client = new OpenMeteoClient({
      fetch: fetcher,
      now: () => new Date(initialTime),
    });
    const weather = await client.weather(50.0871, 14.4207);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.searchParams.get("latitude")).toBe("50.09");
    expect(url.searchParams.get("longitude")).toBe("14.42");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("timeformat")).toBe("unixtime");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(weather).toMatchObject({
      condition: "rain",
      observedAt: "2026-10-20T12:00:00.000Z",
      timezone: "Europe/Prague",
    });
    expect(weather.solar[0]).toEqual({
      date: "2026-10-20",
      sunrise: "2026-10-20T05:30:00.000Z",
      sunset: "2026-10-20T16:00:00.000Z",
    });
  });

  it("normalizes WMO classes and safely neutralizes unknown codes", () => {
    expect(
      [0, 3, 45, 56, 85, 97, 99, 999].map(conditionForWeatherCode),
    ).toEqual([
      "clear",
      "cloudy",
      "fog",
      "rain",
      "snow",
      "storm",
      "storm",
      "unknown",
    ]);
    expect(
      normalizeWeather(fixture(initialTime, 999), new Date(initialTime))
        .condition,
    ).toBe("unknown");
  });

  it("rejects invalid conditions independently of optional/polar solar values", () => {
    const source = fixture();
    const polar = {
      ...source,
      daily: {
        time: source.daily.time,
        sunrise: [null, "bad"],
        sunset: [null],
      },
    };
    expect(normalizeWeather(polar, new Date(initialTime)).solar).toEqual([
      { date: "2026-10-20", sunrise: null, sunset: null },
      { date: "2026-10-21", sunrise: null, sunset: null },
    ]);
    for (const current of [
      { ...source.current, time: Infinity },
      { ...source.current, precipitation: -1 },
      { ...source.current, cloud_cover: 200 },
      { ...source.current, is_day: 2 },
      { ...source.current, time: initialTime / 1000 + 3600 },
    ]) {
      expect(() =>
        normalizeWeather({ ...source, current }, new Date(initialTime)),
      ).toThrow(/invalid-response/);
    }
    expect(() =>
      normalizeWeather(
        { ...source, timezone: "Unknown/Timezone" },
        new Date(initialTime),
      ),
    ).toThrow(/invalid-response/);
  });

  it("validates, deduplicates and limits city results", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            id: 1,
            name: "Praha",
            admin1: "Praha",
            country_code: "CZ",
            country: "Česko",
            latitude: 50.0871,
            longitude: 14.4207,
            timezone: "Europe/Prague",
          },
          {
            id: 1,
            name: "duplicate",
            latitude: 50,
            longitude: 14,
            timezone: "Europe/Prague",
          },
          {
            id: 2,
            name: "invalid",
            latitude: 100,
            longitude: 14,
            timezone: "Europe/Prague",
          },
          {
            id: 3,
            name: "invalid zone",
            latitude: 50,
            longitude: 14,
            timezone: "invalid",
          },
        ],
      }),
    );
    const items = await new OpenMeteoClient({ fetch: fetcher }).locations(
      "Praha",
      "cs",
    );
    expect(items).toEqual([
      {
        id: "1",
        label: "Praha, Česko",
        name: "Praha",
        address: "Praha",
        country: "Česko",
        countryCode: "CZ",
        latitude: 50.09,
        longitude: 14.42,
        timezone: "Europe/Prague",
      },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).origin).toBe(
      "https://geocoding-api.open-meteo.com",
    );
  });

  it("returns only supplied administrative and country metadata without guessing street addresses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            id: 1,
            name: "  Brno  ",
            admin2: "Brno-město",
            admin1: "Jihomoravský kraj",
            country: "Česko",
            country_code: "cz",
            latitude: 49.1951,
            longitude: 16.6068,
            timezone: "Europe/Prague",
          },
          {
            id: 2,
            name: "Small place",
            latitude: 50,
            longitude: 14,
            timezone: "Europe/Prague",
          },
          {
            id: 3,
            name: "Duplicate areas",
            admin2: "  Prague ",
            admin1: "prague",
            country: " ",
            country_code: "invalid",
            latitude: 50,
            longitude: 14,
            timezone: "Europe/Prague",
          },
          {
            id: 4,
            name: "Malformed optional metadata",
            admin2: 42,
            admin1: "x".repeat(121),
            country: "x".repeat(121),
            country_code: "C1",
            latitude: 50,
            longitude: 14,
            timezone: "Europe/Prague",
          },
        ],
      }),
    );
    const items = await new OpenMeteoClient({ fetch: fetcher }).locations(
      "places",
      "cs",
    );
    expect(items[0]).toMatchObject({
      name: "Brno",
      address: "Brno-město, Jihomoravský kraj",
      country: "Česko",
      countryCode: "CZ",
      latitude: 49.2,
      longitude: 16.61,
    });
    expect(items[1]).toEqual({
      id: "2",
      label: "Small place",
      name: "Small place",
      latitude: 50,
      longitude: 14,
      timezone: "Europe/Prague",
    });
    expect(items[2]?.address).toBe("Prague");
    expect(items[2]).not.toHaveProperty("country");
    expect(items[2]).not.toHaveProperty("countryCode");
    expect(items[3]).not.toHaveProperty("address");
    expect(items[3]).not.toHaveProperty("country");
    expect(items[3]).not.toHaveProperty("countryCode");
  });

  it("bounds response bytes without exposing provider bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret".repeat(50_000)));
    await expect(
      new OpenMeteoClient({ fetch: fetcher }).weather(50, 14),
    ).rejects.toThrow("invalid-response");
    fetcher.mockResolvedValueOnce(
      new Response("private upstream error", { status: 500 }),
    );
    await expect(
      new OpenMeteoClient({ fetch: fetcher }).weather(50, 14),
    ).rejects.toThrow("open-meteo request failed (upstream).");
  });

  it("enforces a five-second deadline even with an unresponsive injected transport", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise(() => {}));
      const client = new OpenMeteoClient({ fetch: fetcher });
      const result = expect(client.weather(50, 14)).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(5_001);
      await result;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("environment weather service", () => {
  function setup() {
    let time = initialTime;
    const now = () => new Date(time);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(fixture(time)));
    const service = new EnvironmentWeatherService(
      new OpenMeteoClient({ fetch: fetcher, now }),
      { now, random: () => 0 },
    );
    return {
      fetcher,
      service,
      advance: (milliseconds: number) => {
        time += milliseconds;
      },
    };
  }

  it("deduplicates coordinates and refreshes only after the real fifteen-minute TTL", async () => {
    const { fetcher, service, advance } = setup();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => service.weather(50.001, 14.001)),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((item) => item.status === "fresh")).toBe(true);
    advance(14 * 60_000);
    await service.weather(50, 14);
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(60_000);
    await service.weather(50, 14);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports successfully fetched old observations as stale, then retains only neutral conditions and solar", async () => {
    const { fetcher, service, advance } = setup();
    fetcher.mockImplementation(async () =>
      Response.json(fixture(initialTime - 30 * 60_000)),
    );
    expect((await service.weather(50, 14)).status).toBe("stale");
    advance(2 * 60 * 60_000);
    const result = await service.weather(50, 14);
    expect(result.status).toBe("unavailable");
    expect(result.weather).toMatchObject({
      condition: "unknown",
      precipitation: 0,
      cloudCover: 0,
    });
    expect(result.weather?.solar).toHaveLength(2);
    expect(EnvironmentWeatherResponseSchema.safeParse(result).success).toBe(
      true,
    );
  });

  it("shares provider failure backoff across locations while retaining stale data", async () => {
    const { fetcher, service, advance } = setup();
    await service.weather(50, 14);
    advance(16 * 60_000);
    fetcher.mockRejectedValueOnce(new Error("private URL must never escape"));
    const result = await service.weather(50, 14);
    expect(result).toMatchObject({ status: "stale", retryAfterSeconds: 30 });
    expect(await service.weather(51, 15)).toMatchObject({
      status: "unavailable",
      weather: null,
      retryAfterSeconds: 30,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    advance(30_001);
    expect((await service.weather(51, 15)).status).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("honors provider Retry-After for all clients", async () => {
    const { fetcher, service, advance } = setup();
    fetcher.mockResolvedValueOnce(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );
    expect(await service.weather(50, 14)).toMatchObject({
      retryAfterSeconds: 120,
    });
    advance(119_000);
    await service.weather(51, 15);
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(1_001);
    expect((await service.weather(51, 15)).status).toBe("fresh");
  });

  it("bounds installation requests even across distinct coordinates", async () => {
    const { fetcher, service } = setup();
    for (let index = 0; index < 35; index += 1)
      await service.weather(index, 14);
    expect(fetcher).toHaveBeenCalledTimes(30);
    expect(await service.weather(40, 14)).toMatchObject({
      status: "unavailable",
      retryAfterSeconds: 60,
    });
  });

  it("allows at most two forecasts and one city lookup in flight", async () => {
    let weather = 0;
    let locations = 0;
    let maxWeather = 0;
    let maxLocations = 0;
    let maxTotal = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const search = String(input).includes("geocoding-api");
      if (search) locations += 1;
      else weather += 1;
      maxWeather = Math.max(maxWeather, weather);
      maxLocations = Math.max(maxLocations, locations);
      maxTotal = Math.max(maxTotal, weather + locations);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (search) locations -= 1;
      else weather -= 1;
      return Response.json(search ? { results: [] } : fixture());
    });
    const now = () => new Date(initialTime);
    const service = new EnvironmentWeatherService(
      new OpenMeteoClient({ fetch: fetcher, now }),
      { now },
    );
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        service.weather(40 + index, 14),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        service.locations(`City ${index}`),
      ),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(maxWeather).toBe(2);
    expect(maxLocations).toBe(1);
    expect(maxTotal).toBe(3);
  });

  it("bounds waiting forecasts instead of growing an unlimited request queue", async () => {
    const { fetcher, service } = setup();
    fetcher.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return Response.json(fixture());
    });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => service.weather(index, 14)),
    );
    expect(
      results.filter((result) => result.status === "unavailable").length,
    ).toBeGreaterThanOrEqual(22);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(18);
  });

  it("evicts the oldest weather entry at 256 locations", async () => {
    const { fetcher, service, advance } = setup();
    for (let index = 0; index < 257; index += 1) {
      if (index > 0 && index % 29 === 0) advance(60_001);
      await service.weather(index / 100, 14);
    }
    expect(fetcher).toHaveBeenCalledTimes(257);
    await service.weather(0, 14);
    expect(fetcher).toHaveBeenCalledTimes(258);
  });

  it("caches and deduplicates city search independently of weather", async () => {
    const { fetcher, service } = setup();
    fetcher.mockImplementation(async () => Response.json({ results: [] }));
    await Promise.all([
      service.locations("Praha", "cs"),
      service.locations("Praha", "cs"),
    ]);
    await service.locations("praha", "cs");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await service.locations("Praha", "en");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await service.locations("a", "cs");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("environment endpoints", () => {
  it("reports unavailable city search separately from a successful empty result", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private upstream URL and response"));
    let time = initialTime;
    const now = () => new Date(time);
    const app = Fastify({ logger: false });
    registerEnvironmentRoutes(
      app,
      new EnvironmentWeatherService(
        new OpenMeteoClient({ fetch: fetcher, now }),
        { now, random: () => 0 },
      ),
    );
    try {
      const failed = await app.inject({
        url: "/api/v1/environment/locations?q=Prague",
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.headers["retry-after"]).toBe("30");
      expect(failed.json()).toEqual({
        error: {
          code: "ENVIRONMENT_LOCATIONS_UNAVAILABLE",
          message: "City search is temporarily unavailable. Try again later.",
        },
      });
      expect(failed.body).not.toContain("private upstream");
      const duringBackoff = await app.inject({
        url: "/api/v1/environment/locations?q=Berlin",
      });
      expect(duringBackoff.statusCode).toBe(503);
      expect(fetcher).toHaveBeenCalledTimes(1);
      time += 30_001;
      fetcher.mockResolvedValueOnce(Response.json({ results: [] }));
      const empty = await app.inject({
        url: "/api/v1/environment/locations?q=NoMatchingCity",
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ items: [] });
      expect(empty.headers["retry-after"]).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("validates bounded input without contacting providers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const app = Fastify({ logger: false });
    registerEnvironmentRoutes(
      app,
      new EnvironmentWeatherService(new OpenMeteoClient({ fetch: fetcher })),
    );
    try {
      for (const url of [
        "/api/v1/environment/weather?latitude=91&longitude=14",
        "/api/v1/environment/weather?latitude=NaN&longitude=14",
        "/api/v1/environment/weather?latitude=50&longitude=-181",
        `/api/v1/environment/locations?q=${"x".repeat(101)}`,
        "/api/v1/environment/locations?q=x",
        "/api/v1/environment/locations?q=Praha&language=xxx",
      ])
        expect((await app.inject({ url })).statusCode).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("works before profile selection and includes provider attribution", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(fixture()));
    const app = createApp({
      environment: "test",
      logger: false,
      environmentFetch: fetcher,
      now: () => new Date(initialTime),
    });
    try {
      const response = await app.inject({
        url: "/api/v1/environment/weather?latitude=50&longitude=14",
      });
      expect(response.statusCode).toBe(200);
      expect(
        EnvironmentWeatherResponseSchema.parse(response.json()),
      ).toMatchObject({
        status: "fresh",
        attribution: {
          name: "Open-Meteo",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        },
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await app.close();
    }
  });
});
