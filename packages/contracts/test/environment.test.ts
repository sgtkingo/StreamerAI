import { describe, expect, it } from "vitest";
import {
  EnvironmentLocationsResponseSchema,
  WeatherLocationSchema,
} from "../src/environment.js";

const legacyLocation = {
  id: "3067696",
  label: "Prague, Czechia",
  latitude: 50.09,
  longitude: 14.42,
  timezone: "Europe/Prague",
};

describe("environment location metadata", () => {
  it("keeps persisted legacy and device locations valid without invented metadata", () => {
    expect(WeatherLocationSchema.parse(legacyLocation)).toEqual(legacyLocation);
    const deviceLocation = {
      ...legacyLocation,
      id: "device-location",
      label: "Current approximate location",
    };
    expect(WeatherLocationSchema.parse(deviceLocation)).toEqual(deviceLocation);
    expect(WeatherLocationSchema.parse(deviceLocation)).not.toHaveProperty(
      "country",
    );
  });

  it("preserves available place, administrative address and country metadata through serialization", () => {
    const enriched = {
      ...legacyLocation,
      name: "Prague",
      address: "Hlavní město Praha",
      country: "Czechia",
      countryCode: "CZ",
    };
    const saved = JSON.parse(
      JSON.stringify(WeatherLocationSchema.parse(enriched)),
    );
    expect(
      EnvironmentLocationsResponseSchema.parse({ items: [saved] }),
    ).toEqual({ items: [enriched] });
  });

  it("bounds optional metadata and requires a two-letter uppercase country code", () => {
    for (const patch of [
      { name: "x".repeat(121) },
      { name: " " },
      { address: "x".repeat(241) },
      { address: " " },
      { country: "x".repeat(121) },
      { country: " " },
      { countryCode: "CZE" },
      { countryCode: "cz" },
      { countryCode: "C1" },
    ]) {
      expect(
        WeatherLocationSchema.safeParse({ ...legacyLocation, ...patch })
          .success,
      ).toBe(false);
    }
  });
});
