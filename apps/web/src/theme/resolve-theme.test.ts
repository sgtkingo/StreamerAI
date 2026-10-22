import { describe, expect, it } from "vitest";
import type {
  AppearancePreferences,
  WeatherLocation,
  WeatherSnapshot,
} from "@streamer-ai/contracts";
import { AppearancePreferencesSchema } from "@streamer-ai/contracts";
import { resolveSeason, resolveTheme } from "./resolve-theme";

const location: WeatherLocation = {
  id: "prague",
  label: "Prague",
  latitude: 50.08,
  longitude: 14.42,
  timezone: "Europe/Prague",
};
const realNow = new Date("2026-10-20T12:00:00Z");
const weather: WeatherSnapshot = {
  condition: "rain",
  precipitation: 1.4,
  cloudCover: 95,
  observedAt: realNow.toISOString(),
  fetchedAt: realNow.toISOString(),
  isDay: true,
  timezone: "Europe/Prague",
  solar: [
    {
      date: "2026-10-20",
      sunrise: "2026-10-20T05:00:00Z",
      sunset: "2026-10-20T17:00:00Z",
    },
  ],
};
const appearance: AppearancePreferences = AppearancePreferencesSchema.parse({});
const params = {
  appearance,
  instant: realNow,
  timeZone: "Europe/Prague",
  location,
  weather,
  realNow,
};

describe("seasonal calendar", () => {
  it.each([
    ["2026-01-01", "new-year"],
    ["2026-01-02", "winter"],
    ["2026-02-28", "winter"],
    ["2028-02-29", "winter"],
    ["2026-03-01", "spring"],
    ["2026-05-31", "spring"],
    ["2026-06-01", "summer"],
    ["2026-08-31", "summer"],
    ["2026-09-01", "autumn"],
    ["2026-11-30", "autumn"],
    ["2026-12-01", "winter"],
    ["2026-12-19", "winter"],
    ["2026-12-20", "christmas"],
    ["2026-12-30", "christmas"],
    ["2026-12-31", "new-year"],
  ])("resolves %s as %s", (date, season) => {
    expect(resolveSeason(new Date(`${date}T12:00:00Z`), "UTC")).toBe(season);
  });

  it("evaluates holiday boundaries in the selected zone", () => {
    const instant = new Date("2026-12-30T23:30:00Z");
    expect(resolveSeason(instant, "Europe/Prague")).toBe("new-year");
    expect(resolveSeason(instant, "America/New_York")).toBe("christmas");
  });

  it("reverses seasons in the southern hemisphere and keeps calendar holidays", () => {
    expect(resolveSeason(new Date("2026-03-01T12:00:00Z"), "UTC", -33)).toBe(
      "autumn",
    );
    expect(resolveSeason(new Date("2026-06-01T12:00:00Z"), "UTC", -33)).toBe(
      "winter",
    );
    expect(resolveSeason(new Date("2026-09-01T12:00:00Z"), "UTC", -33)).toBe(
      "spring",
    );
    expect(resolveSeason(new Date("2026-12-01T12:00:00Z"), "UTC", -33)).toBe(
      "summer",
    );
    expect(resolveSeason(new Date("2026-12-25T12:00:00Z"), "UTC", -33)).toBe(
      "christmas",
    );
  });
});

describe("theme composition", () => {
  it("composes honey summer days and dark starry nights with a date-driven moon", () => {
    const summer = {
      ...params,
      location: null,
      weather: null,
      appearance: {
        ...appearance,
        mode: "summer" as const,
        daylightOverride: "day" as const,
      },
      instant: new Date("2026-06-29T23:57:00Z"),
    };
    const day = resolveTheme(summer);
    const night = resolveTheme({
      ...summer,
      appearance: { ...summer.appearance, daylightOverride: "night" },
    });
    expect(day.palette.background).toBe("#2a200d");
    expect(day.palette.accent).toBe("#ffe1a0");
    expect(night.palette.background).not.toBe(day.palette.background);
    expect(night.palette.accent).toBe(day.palette.accent);
    expect(night.moonPhase).toBeCloseTo(0.5, 1);
    expect(night.moonPhase).toBe(day.moonPhase);
    expect(
      resolveTheme({ ...summer, instant: new Date("2026-06-15T02:54:00Z") })
        .moonPhase,
    ).not.toBe(day.moonPhase);
  });

  it.each([
    ["clear", "none"],
    ["cloudy", "cloudy"],
    ["fog", "fog"],
    ["rain", "rain"],
    ["snow", "snow"],
    ["storm", "storm"],
  ] as const)(
    "applies manual %s weather without a location or forecast",
    (weatherOverride, weatherEffect) => {
      const resolved = resolveTheme({
        ...params,
        appearance: { ...appearance, weatherOverride },
        location: null,
        weather: null,
      });
      expect(resolved).toMatchObject({
        id: "autumn",
        period: "day",
        approximateDaylight: true,
        weatherEffect,
      });
    },
  );

  it("uses a current forecast only when weather is automatic and keeps its observation unchanged", () => {
    const pinned = resolveTheme({
      ...params,
      appearance: { ...appearance, weatherOverride: "snow" },
    });
    const automatic = resolveTheme({
      ...params,
      appearance: { ...appearance, weatherOverride: "auto" },
    });
    expect(pinned.weatherEffect).toBe("snow");
    expect(automatic.weatherEffect).toBe("rain");
    expect(weather.condition).toBe("rain");
    expect(
      resolveTheme({
        ...params,
        location: null,
        appearance: { ...appearance, weatherOverride: "auto" },
      }).weatherEffect,
    ).toBe("none");
  });

  it.each(["day", "night"] as const)(
    "pins %s independently of weather and solar data",
    (daylightOverride) => {
      expect(
        resolveTheme({
          ...params,
          instant: new Date("2026-10-20T23:00:00Z"),
          appearance: { ...appearance, daylightOverride },
        }),
      ).toMatchObject({
        period: daylightOverride,
        approximateDaylight: false,
        weatherEffect: "rain",
      });
      expect(
        resolveTheme({
          ...params,
          appearance: {
            ...appearance,
            daylightOverride,
            weatherOverride: "fog",
          },
          location: null,
          weather: null,
        }),
      ).toMatchObject({
        period: daylightOverride,
        approximateDaylight: false,
        weatherEffect: "fog",
      });
    },
  );

  it("fixes the current three axes across calendar, weather, timezone and location changes", () => {
    const current = resolveTheme(params);
    const fixed: AppearancePreferences = {
      ...appearance,
      mode: current.id,
      weatherOverride:
        current.weatherEffect === "none" ? "clear" : current.weatherEffect,
      daylightOverride: current.period,
    };
    const later = new Date("2027-12-31T23:00:00Z");
    expect(
      resolveTheme({
        ...params,
        appearance: fixed,
        instant: later,
        realNow: later,
        timeZone: "Pacific/Auckland",
        location: { ...location, latitude: -33 },
        weather: {
          ...weather,
          condition: "storm",
          observedAt: later.toISOString(),
          solar: [],
        },
      }),
    ).toMatchObject({
      id: current.id,
      period: current.period,
      weatherEffect: current.weatherEffect,
      palette: current.palette,
      approximateDaylight: false,
    });
    const clear = resolveTheme({ ...params, weather: null });
    expect(
      resolveTheme({
        ...params,
        appearance: {
          ...fixed,
          weatherOverride:
            clear.weatherEffect === "none" ? "clear" : clear.weatherEffect,
        },
      }).weatherEffect,
    ).toBe("none");
  });

  it("uses festive Christmas colors and New Year fireworks without inventing forecast snow", () => {
    const christmas = resolveTheme({
      ...params,
      appearance: {
        ...appearance,
        mode: "christmas",
        weatherOverride: "clear",
        daylightOverride: "day",
      },
    });
    const newYear = resolveTheme({
      ...params,
      appearance: {
        ...appearance,
        mode: "new-year",
        weatherOverride: "clear",
        daylightOverride: "day",
      },
    });
    expect(christmas).toMatchObject({
      id: "christmas",
      motif: "lights",
      weatherEffect: "none",
    });
    expect(christmas.palette).toMatchObject({
      background: "#071d12",
      surface: "#173b26",
      accent: "#f1ce82",
      glow: "#c63d4b",
    });
    expect(newYear).toMatchObject({
      id: "new-year",
      motif: "fireworks",
      weatherEffect: "none",
    });
    expect(newYear.palette).toMatchObject({
      background: "#10112a",
      surface: "#262044",
      accent: "#f2d393",
      glow: "#9d64d8",
    });
    expect(weather.condition).toBe("rain");
  });

  it("fuses autumn and rain without replacing the seasonal palette", () => {
    const rainy = resolveTheme(params);
    const clear = resolveTheme({
      ...params,
      weather: { ...weather, condition: "clear" },
    });
    expect(rainy).toMatchObject({
      id: "autumn",
      motif: "leaves",
      period: "day",
      weatherEffect: "rain",
      approximateDaylight: false,
    });
    expect(rainy.palette.accent).toBe(clear.palette.accent);
    expect(rainy.palette.background).not.toBe(clear.palette.background);
  });

  it("pins a chosen base while retaining weather and daylight", () => {
    expect(
      resolveTheme({
        ...params,
        appearance: { ...appearance, mode: "spring" },
        weather: { ...weather, condition: "fog" },
      }),
    ).toMatchObject({
      id: "spring",
      motif: "petals",
      period: "day",
      weatherEffect: "fog",
    });
  });

  it("uses absolute solar instants even when display and location zones disagree", () => {
    const instant = new Date("2026-10-20T06:00:00Z");
    expect(
      resolveTheme({ ...params, instant, timeZone: "America/New_York" }),
    ).toMatchObject({ period: "day", approximateDaylight: false });
    const sydneyWeather = {
      ...weather,
      timezone: "Australia/Sydney",
      solar: [
        {
          date: "2026-10-21",
          sunrise: "2026-10-20T19:00:00Z",
          sunset: "2026-10-21T08:00:00Z",
        },
      ],
    };
    expect(
      resolveTheme({
        ...params,
        instant: new Date("2026-10-20T23:30:00Z"),
        weather: sydneyWeather,
      }),
    ).toMatchObject({ period: "day", approximateDaylight: false });
  });

  it("uses inclusive sunrise and exclusive sunset boundaries", () => {
    expect(
      resolveTheme({ ...params, instant: new Date("2026-10-20T05:00:00Z") })
        .period,
    ).toBe("day");
    expect(
      resolveTheme({ ...params, instant: new Date("2026-10-20T17:00:00Z") })
        .period,
    ).toBe("night");
  });

  it.each([
    ["2026-10-20T06:59:00Z", "night"],
    ["2026-10-20T07:00:00Z", "day"],
    ["2026-10-20T18:59:00Z", "day"],
    ["2026-10-20T19:00:00Z", "night"],
  ])("falls back to 07–19 local time at %s", (instant, period) => {
    expect(
      resolveTheme({
        ...params,
        instant: new Date(instant),
        timeZone: "UTC",
        weather: null,
      }),
    ).toMatchObject({ period, approximateDaylight: true });
  });

  it("uses fresh current is_day for polar cases but ignores it for simulated dates", () => {
    const polar = {
      ...weather,
      isDay: false,
      solar: [{ date: "2026-10-20", sunrise: null, sunset: null }],
    };
    expect(resolveTheme({ ...params, weather: polar })).toMatchObject({
      period: "night",
      approximateDaylight: false,
    });
    expect(
      resolveTheme({
        ...params,
        weather: polar,
        instant: new Date("2026-10-21T12:00:00Z"),
      }),
    ).toMatchObject({ period: "day", approximateDaylight: true });
    expect(
      resolveTheme({
        ...params,
        weather: { ...polar, observedAt: "2026-10-20T10:00:00Z" },
      }),
    ).toMatchObject({ period: "day", approximateDaylight: true });
  });

  it("discards conditions older than two real hours while keeping usable solar data", () => {
    expect(
      resolveTheme({
        ...params,
        weather: { ...weather, observedAt: "2026-10-20T09:59:59Z" },
      }),
    ).toMatchObject({
      weatherEffect: "none",
      period: "day",
      approximateDaylight: false,
    });
    expect(
      resolveTheme({ ...params, instant: new Date("2027-12-25T12:00:00Z") }),
    ).toMatchObject({
      id: "christmas",
      weatherEffect: "rain",
      approximateDaylight: true,
    });
  });

  it("does not assume snow from a winter date and ignores weather without a location", () => {
    expect(
      resolveTheme({
        ...params,
        appearance: { ...appearance, mode: "winter" },
        weather: { ...weather, condition: "clear" },
      }),
    ).toMatchObject({ id: "winter", motif: "crystals", weatherEffect: "none" });
    expect(resolveTheme({ ...params, location: null })).toMatchObject({
      weatherEffect: "none",
      approximateDaylight: true,
    });
  });

  it("preserves the Cinematic palette and disables all ambient effects", () => {
    const cinematic = resolveTheme({
      ...params,
      appearance: {
        ...appearance,
        mode: "cinematic",
        weatherOverride: "snow",
        daylightOverride: "night",
      },
    });
    expect(cinematic).toMatchObject({
      id: "cinematic",
      motif: "none",
      weatherEffect: "none",
      ambientOpacity: 0,
    });
    expect(cinematic.cssVariables).toMatchObject({
      "--black": "#000000",
      "--surface": "#1a1a1a",
      "--white": "#ffffff",
      "--accent": "#f2f2f2",
    });
    expect(cinematic.cssVariables).not.toHaveProperty("--error");
  });
});
