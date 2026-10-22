import { act, render } from "@testing-library/react";
import { AppearancePreferencesSchema } from "@streamer-ai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AmbientBackground } from "./AmbientBackground";
import { resolveTheme, type ResolvedTheme } from "./resolve-theme";

function festiveTheme(mode: "christmas" | "new-year"): ResolvedTheme {
  return resolveTheme({
    appearance: AppearancePreferencesSchema.parse({ mode, seasonalMode: mode }),
    instant: new Date("2026-06-01T12:00:00Z"),
    timeZone: "UTC",
    location: null,
    weather: null,
    realNow: new Date("2026-06-01T12:00:00Z"),
  });
}

function weatherTheme(
  weatherOverride: "rain" | "storm" | "snow",
): ResolvedTheme {
  return resolveTheme({
    appearance: AppearancePreferencesSchema.parse({
      mode: "autumn",
      weatherOverride,
    }),
    instant: new Date("2026-06-01T12:00:00Z"),
    timeZone: "UTC",
    location: null,
    weather: null,
    realNow: new Date("2026-06-01T12:00:00Z"),
  });
}

let reducedMotion = false;
let hidden = false;
let motionChange: (() => void) | undefined;
const requestFrame = vi.fn((_callback: FrameRequestCallback) => 1);
const cancelFrame = vi.fn();
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

beforeEach(() => {
  reducedMotion = false;
  hidden = false;
  motionChange = undefined;
  requestFrame.mockClear();
  cancelFrame.mockClear();
  vi.stubGlobal("CanvasRenderingContext2D", function () {});
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reducedMotion;
    },
    addEventListener: (_type: string, callback: () => void) => {
      motionChange = callback;
    },
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  const noop = () => undefined;
  const context = {
    translate: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    ellipse: noop,
    fill: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    arc: noop,
    fillRect: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    stroke: noop,
    setTransform: noop,
    clearRect: noop,
    save: noop,
    rotate: noop,
    drawImage: noop,
    restore: noop,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});

describe("glass weather accessibility and pause", () => {
  it.each(["none", "cloudy", "snow", "rain", "storm", "fog"] as const)(
    "uses winter sun only for a clear day, with frost in %s",
    (weatherEffect) => {
      const theme = {
        ...weatherTheme("snow"),
        id: "winter" as const,
        period: "day" as const,
        weatherEffect,
      };
      const { container } = render(
        <AmbientBackground theme={theme} enabled={false} />,
      );
      expect(Boolean(container.querySelector(".summer-sun"))).toBe(
        weatherEffect === "none",
      );
      expect(Boolean(container.querySelector(".winter-clouds"))).toBe(
        weatherEffect !== "none",
      );
      expect(
        container.querySelector(".theme-ambient__frost-rim"),
      ).not.toBeNull();
      expect(
        document.documentElement.style.getPropertyValue("--winter-icicles"),
      ).toBe("0.55");
      expect(
        Number(
          document.documentElement.style.getPropertyValue("--winter-snow"),
        ),
      ).toBe(weatherEffect === "snow" ? 0.4 : 0);
      expect(requestFrame).not.toHaveBeenCalled();
    },
  );

  it("keeps winter moon phases and brighter stars without restarting the sky", () => {
    const theme = {
      ...weatherTheme("snow"),
      id: "winter" as const,
      period: "night" as const,
      weatherEffect: "none" as const,
      moonPhase: 0.25,
    };
    const { container, rerender } = render(<AmbientBackground theme={theme} />);
    expect(container.querySelectorAll(".summer-star")).toHaveLength(64);
    expect(container.querySelector(".summer-moon")).toHaveAttribute(
      "data-phase",
      "0.2500",
    );
    const contexts = vi.mocked(HTMLCanvasElement.prototype.getContext).mock
      .calls.length;
    rerender(<AmbientBackground theme={{ ...theme, moonPhase: 0.75 }} />);
    expect(container.querySelector(".summer-moon")).toHaveAttribute(
      "data-phase",
      "0.7500",
    );
    expect(
      vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls,
    ).toHaveLength(contexts);
  });

  it("preserves winter accumulation on pause, weather and viewport changes and removes global styles on exit", () => {
    const theme = { ...weatherTheme("snow"), id: "winter" as const };
    const { rerender, unmount } = render(<AmbientBackground theme={theme} />);
    const tick = (time: number) =>
      act(() => requestFrame.mock.calls.at(-1)?.[0](time));
    for (let frame = 0; frame < 20; frame++) tick(1000 + frame * 50);
    const snow = () =>
      Number(document.documentElement.style.getPropertyValue("--winter-snow"));
    const accumulated = snow();
    expect(accumulated).toBeGreaterThan(0);
    rerender(<AmbientBackground theme={theme} paused />);
    const frozen = snow();
    tick(5000);
    expect(snow()).toBe(frozen);
    act(() => window.dispatchEvent(new Event("resize")));
    rerender(<AmbientBackground theme={{ ...theme, weatherEffect: "none" }} />);
    expect(snow()).toBeGreaterThanOrEqual(accumulated);
    reducedMotion = true;
    act(() => motionChange?.());
    expect(
      Number(
        document.documentElement.style.getPropertyValue("--winter-icicles"),
      ),
    ).toBeGreaterThanOrEqual(0.55);
    unmount();
    expect(
      document.documentElement.style.getPropertyValue("--winter-snow"),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--winter-icicles"),
    ).toBe("");
  });

  it.each(["day", "night"] as const)(
    "keeps summer %s sky static with motion disabled",
    (period) => {
      const theme = resolveTheme({
        appearance: AppearancePreferencesSchema.parse({
          mode: "summer",
          daylightOverride: period,
        }),
        instant: new Date("2026-06-29T23:57:00Z"),
        timeZone: "UTC",
        location: null,
        weather: null,
        realNow: new Date(),
      });
      const { container } = render(
        <AmbientBackground theme={theme} enabled={false} />,
      );
      expect(Boolean(container.querySelector(".summer-sun"))).toBe(
        period === "day",
      );
      expect(container.querySelectorAll(".summer-star")).toHaveLength(
        period === "night" ? 64 : 0,
      );
      expect(Boolean(container.querySelector(".summer-moon"))).toBe(
        period === "night",
      );
      expect(requestFrame).not.toHaveBeenCalled();
    },
  );

  it("updates moon illumination without restarting the night simulation", () => {
    const theme = {
      ...weatherTheme("rain"),
      id: "summer" as const,
      period: "night" as const,
      moonPhase: 0.25,
    };
    const { container, rerender } = render(<AmbientBackground theme={theme} />);
    const contexts = vi.mocked(HTMLCanvasElement.prototype.getContext).mock
      .calls.length;
    expect(container.querySelector(".summer-moon")).toHaveAttribute(
      "data-phase",
      "0.2500",
    );
    rerender(<AmbientBackground theme={{ ...theme, moonPhase: 0.75 }} />);
    expect(container.querySelector(".summer-moon")).toHaveAttribute(
      "data-phase",
      "0.7500",
    );
    expect(
      vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls,
    ).toHaveLength(contexts);
  });

  it.each([false, true])(
    "retains spring twigs without animation (reduced motion: %s)",
    (reduce) => {
      reducedMotion = reduce;
      const theme = { ...weatherTheme("rain"), id: "spring" as const };
      const { container } = render(
        <AmbientBackground theme={theme} enabled={reduce} />,
      );
      expect(container.querySelectorAll(".spring-branch")).toHaveLength(4);
      expect(container.querySelectorAll(".spring-branch__catkin")).toHaveLength(
        36,
      );
      expect(container.querySelector(".theme-ambient")).toHaveAttribute(
        "data-static",
        "true",
      );
      expect(requestFrame).not.toHaveBeenCalled();
    },
  );

  it("advances spring growth only with ambient motion and preserves it on resize and weather changes", () => {
    const theme = { ...weatherTheme("rain"), id: "spring" as const };
    const { container, rerender } = render(<AmbientBackground theme={theme} />);
    const tick = (time: number) =>
      act(() => requestFrame.mock.calls.at(-1)?.[0](time));
    tick(1000);
    tick(1060);
    const layer = container.querySelector<HTMLElement>(".theme-ambient")!;
    const growth = layer.style.getPropertyValue("--spring-growth");
    expect(Number(growth)).toBeGreaterThan(0);
    rerender(<AmbientBackground theme={theme} paused />);
    tick(2000);
    expect(layer.style.getPropertyValue("--spring-growth")).toBe(growth);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(layer.style.getPropertyValue("--spring-growth")).toBe(growth);
    rerender(
      <AmbientBackground theme={{ ...theme, weatherEffect: "storm" }} />,
    );
    expect(layer.style.getPropertyValue("--spring-growth")).toBe(growth);
    tick(3000);
    tick(3060);
    expect(
      Number(layer.style.getPropertyValue("--spring-growth")),
    ).toBeGreaterThan(Number(growth));
    rerender(<AmbientBackground theme={weatherTheme("rain")} />);
    expect(container.querySelector(".theme-ambient__spring")).toBeNull();
  });

  it("hides search spray on reduced motion, weather changes and unmount", () => {
    const form = document.createElement("form");
    form.className = "composer-form";
    const surface = document.createElement("canvas");
    surface.className = "theme-search-splash";
    form.append(surface);
    document.body.append(form);
    const bounds = vi.spyOn(form, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 250,
      right: 900,
      bottom: 324,
      width: 800,
      height: 74,
    } as DOMRect);
    const { rerender, unmount } = render(
      <AmbientBackground theme={weatherTheme("storm")} />,
    );
    expect(surface.style.visibility).toBe("visible");
    bounds.mockReturnValue({
      left: 20,
      top: 250,
      right: 340,
      bottom: 324,
      width: 320,
      height: 74,
    } as DOMRect);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(surface.style.width).toBe("440px");
    reducedMotion = true;
    act(() => motionChange?.());
    expect(surface.style.visibility).toBe("hidden");
    reducedMotion = false;
    act(() => motionChange?.());
    // Weather cleanup hides the local canvas even though it belongs to Home.
    rerender(<AmbientBackground theme={weatherTheme("rain")} />);
    expect(surface.style.visibility).toBe("hidden");
    rerender(<AmbientBackground theme={weatherTheme("storm")} />);
    expect(surface.style.visibility).toBe("visible");
    unmount();
    expect(surface.style.visibility).toBe("hidden");
    form.remove();
  });

  it("keeps autumn foliage static when motion is disabled", () => {
    const theme = { ...weatherTheme("rain"), weatherEffect: "none" as const };
    const { container } = render(
      <AmbientBackground theme={theme} enabled={false} />,
    );
    expect(
      container.querySelectorAll(".theme-ambient__autumn-leaves > span"),
    ).toHaveLength(2);
    expect(container.querySelector(".theme-ambient")).toHaveAttribute(
      "data-static",
      "true",
    );
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it.each(["rain", "storm"] as const)(
    "retains static %s glass beads when motion is disabled",
    (condition) => {
      const { container } = render(
        <AmbientBackground theme={weatherTheme(condition)} enabled={false} />,
      );
      expect(container.querySelector(".theme-ambient")).toHaveAttribute(
        "data-static",
        "true",
      );
      expect(
        container.querySelectorAll(".theme-ambient__wet-glass > span"),
      ).toHaveLength(16);
      expect(requestFrame).not.toHaveBeenCalled();
      if (condition === "rain") {
        expect(
          container.querySelector(".theme-ambient__haze"),
        ).toBeInTheDocument();
      } else {
        expect(
          container.querySelector(".theme-ambient__haze"),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("keeps snow frost static under reduced motion", () => {
    reducedMotion = true;
    const { container } = render(
      <AmbientBackground theme={weatherTheme("snow")} />,
    );
    expect(
      container.querySelector(".theme-ambient__frost-rim"),
    ).toBeInTheDocument();
    expect(container.querySelector(".theme-ambient")).toHaveAttribute(
      "data-static",
      "true",
    );
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("schedules no storm droplets or lightning while paused and stops on hidden pages", () => {
    const theme = weatherTheme("storm");
    const { rerender } = render(<AmbientBackground theme={theme} paused />);
    expect(requestFrame).not.toHaveBeenCalled();
    rerender(<AmbientBackground theme={theme} paused={false} />);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(cancelFrame).toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it("honors reduced-motion changes after switching from rain to storm", () => {
    const { container, rerender } = render(
      <AmbientBackground theme={weatherTheme("rain")} />,
    );
    rerender(<AmbientBackground theme={weatherTheme("storm")} />);
    const frames = requestFrame.mock.calls.length;
    reducedMotion = true;
    act(() => motionChange?.());
    expect(container.querySelector(".theme-ambient")).toHaveAttribute(
      "data-static",
      "true",
    );
    expect(container.querySelector("canvas")).toHaveStyle({
      visibility: "hidden",
    });
    expect(requestFrame).toHaveBeenCalledTimes(frames);
    reducedMotion = false;
    act(() => motionChange?.());
    expect(container.querySelector(".theme-ambient")).toHaveAttribute(
      "data-static",
      "false",
    );
    expect(container.querySelector("canvas")).toHaveStyle({
      visibility: "visible",
    });
    expect(requestFrame).toHaveBeenCalledTimes(frames + 1);
  });

  it("preserves accumulated glass state across clock renders and playback pause", () => {
    const theme = weatherTheme("snow");
    const { rerender } = render(<AmbientBackground theme={theme} />);
    const contexts = vi.mocked(HTMLCanvasElement.prototype.getContext).mock
      .calls.length;
    rerender(
      <AmbientBackground theme={{ ...theme, palette: { ...theme.palette } }} />,
    );
    expect(
      vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls,
    ).toHaveLength(contexts);
    rerender(<AmbientBackground theme={theme} paused />);
    expect(cancelFrame).toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls,
    ).toHaveLength(contexts);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
  else Reflect.deleteProperty(document, "hidden");
});

describe("festive ambient rendering", () => {
  it.each(["christmas", "new-year"] as const)(
    "retains decorative %s snow with no weather and motion disabled",
    (mode) => {
      const theme = festiveTheme(mode);
      const { container } = render(
        <AmbientBackground theme={theme} enabled={false} />,
      );
      const layer = container.querySelector(".theme-ambient");
      expect(theme.weatherEffect).toBe("none");
      expect(layer).toHaveAttribute("data-static", "true");
      expect(layer).toHaveAttribute("aria-hidden", "true");
      expect(
        layer?.querySelector(".theme-ambient__festive-snow"),
      ).toBeInTheDocument();
      expect(requestFrame).not.toHaveBeenCalled();
      if (mode === "christmas")
        expect(
          layer?.querySelectorAll(".theme-ambient__light-string > span"),
        ).toHaveLength(14);
      else
        expect(
          layer?.querySelectorAll(".theme-ambient__firework"),
        ).toHaveLength(2);
    },
  );

  it("stops scheduling during playback or a hidden page and resumes when visible", () => {
    const theme = festiveTheme("new-year");
    const { rerender } = render(<AmbientBackground theme={theme} paused />);
    expect(requestFrame).not.toHaveBeenCalled();
    rerender(<AmbientBackground theme={theme} paused={false} />);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(cancelFrame).toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });

  it("switches running festive effects to static treatment when reduced motion is enabled", () => {
    const { container } = render(
      <AmbientBackground theme={festiveTheme("new-year")} />,
    );
    expect(requestFrame).toHaveBeenCalledTimes(1);
    reducedMotion = true;
    act(() => {
      motionChange?.();
    });
    expect(cancelFrame).toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".theme-ambient")).toHaveAttribute(
      "data-static",
      "true",
    );
    expect(container.querySelector("canvas")).toHaveStyle({
      visibility: "hidden",
    });
  });
});
