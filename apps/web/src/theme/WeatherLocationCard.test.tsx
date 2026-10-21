import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  WeatherLocationSchema,
  WeatherSnapshotSchema,
} from "@streamer-ai/contracts";
import { WeatherLocationCard } from "./WeatherLocationCard";

const now = new Date("2026-10-21T12:00:00.000Z");
const location = WeatherLocationSchema.parse({
  id: "prague",
  label: "Prague, Czechia",
  name: "Prague",
  address: "Prague, Central Bohemia",
  country: "Czechia",
  countryCode: "CZ",
  latitude: 50.08,
  longitude: 14.44,
  timezone: "Europe/Prague",
});
const weather = WeatherSnapshotSchema.parse({
  condition: "rain",
  precipitation: 0.6,
  cloudCover: 90,
  observedAt: "2026-10-21T11:55:00.000Z",
  fetchedAt: "2026-10-21T11:58:00.000Z",
  isDay: true,
  timezone: "Europe/Prague",
  solar: [],
});

function renderCard(
  overrides: Partial<Parameters<typeof WeatherLocationCard>[0]> = {},
) {
  const onRefresh = vi.fn();
  const props = {
    location,
    weather,
    status: "fresh" as const,
    enabled: true,
    cinematic: false,
    preview: "auto" as const,
    locale: "en" as const,
    timeZone: "UTC",
    onRefresh,
    now,
    ...overrides,
  };
  return { ...render(<WeatherLocationCard {...props} />), onRefresh, props };
}

describe("weather location card", () => {
  it("shows supplied place facts, the observed weather, real freshness and a refresh action", () => {
    const { onRefresh } = renderCard();
    const card = screen.getByRole("article", {
      name: "Weather at selected location",
    });
    expect(
      within(card).getByRole("heading", { name: "Prague", level: 4 }),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("Prague, Central Bohemia"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Czechia")).toBeInTheDocument();
    expect(within(card).getByText("Rain")).toBeInTheDocument();
    expect(card).toHaveTextContent("Precipitation 0.6 mm · Cloud cover 90%");
    expect(card).toHaveTextContent("Fresh · Observed 5 min ago");
    expect(card).toHaveTextContent("Updated 2 min ago");
    expect(card.querySelector("time")).toHaveAttribute(
      "datetime",
      weather.observedAt,
    );
    expect(card.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(
      within(card).getByRole("button", { name: "Refresh weather" }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps manual background weather separate from the real observation", () => {
    renderCard({ preview: "snow" });
    expect(screen.getByText("Rain")).toBeInTheDocument();
    expect(screen.getByText(/Background preview: Snow/)).toHaveTextContent(
      "does not change the weather observation",
    );
    expect(screen.queryByText("Snow", { exact: true })).not.toBeInTheDocument();
  });

  it("marks an old observed instant stale even if the latest transport response said fresh", () => {
    renderCard({
      weather: { ...weather, observedAt: "2026-10-21T11:40:00.000Z" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("older observation");
    expect(screen.getByText(/Stale · Observed 20 min ago/)).toBeInTheDocument();
  });

  it("labels expired observations as unavailable instead of presenting current conditions", () => {
    renderCard({
      weather: { ...weather, observedAt: "2026-10-21T08:00:00.000Z" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Current weather is unavailable",
    );
    expect(screen.getByText("Last observed weather")).toBeInTheDocument();
    expect(
      screen.getByText(/Stale · Observed 4 hours ago/),
    ).toBeInTheDocument();
  });

  it.each([
    {
      enabled: false,
      status: "disabled" as const,
      text: "Local weather is off.",
    },
    {
      cinematic: true,
      status: "disabled" as const,
      text: "paused in Cinematic",
    },
    {
      weather: null,
      status: "loading" as const,
      text: "Checking local weather",
    },
    {
      weather: null,
      status: "unavailable" as const,
      text: "Current weather is unavailable",
    },
  ])(
    "represents $text without inventing an observation",
    ({ text, ...overrides }) => {
      renderCard(overrides);
      expect(screen.getByRole("status")).toHaveTextContent(text);
      expect(screen.queryByText("Rain")).not.toBeInTheDocument();
      if (overrides.status === "disabled" || overrides.status === "loading") {
        expect(
          screen.getByRole("button", { name: "Refresh weather" }),
        ).toBeDisabled();
      }
    },
  );

  it("retains meaningful fallbacks for old city and coarse device location records", () => {
    const oldLocation = WeatherLocationSchema.parse({
      id: "device-location",
      label: "Current approximate location",
      latitude: 50.08,
      longitude: 14.44,
      timezone: "Europe/Prague",
    });
    renderCard({ location: oldLocation, weather: null, status: "unavailable" });
    expect(
      screen.getByRole("heading", { name: "Current approximate location" }),
    ).toBeInTheDocument();
    expect(screen.getByText("50.08, 14.44")).toBeInTheDocument();
    expect(screen.getByText("Country unavailable")).toBeInTheDocument();
  });
});
