import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDeviceEnvironment } from "./storage";
import { useLocalClock } from "./useLocalClock";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("live local clock", () => {
  it("ticks on second boundaries and removes its timer on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:34:56.250Z"));
    const environment = defaultDeviceEnvironment();
    const { result, unmount } = renderHook(() => useLocalClock(environment));
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.toISOString()).toBe("2026-10-21T12:34:57.000Z");
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.toISOString()).toBe("2026-10-21T12:34:59.000Z");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("advances the manual clock and immediately follows a changed anchor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    const initial = {
      ...defaultDeviceEnvironment(),
      autoDetectTime: false,
      timeZone: "Europe/Prague",
      manualClock: {
        instant: "2026-12-24T18:30:00Z",
        setAt: "2026-10-21T12:00:00Z",
      },
    };
    const { result, rerender } = renderHook(
      (environment) => useLocalClock(environment),
      { initialProps: initial },
    );
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.toISOString()).toBe("2026-12-24T18:30:03.000Z");
    rerender({
      ...initial,
      manualClock: {
        instant: "2027-01-01T00:00:00Z",
        setAt: "2026-10-21T12:00:03Z",
      },
    });
    expect(result.current.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("stops ticking while hidden and catches up on visibility or focus", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const environment = defaultDeviceEnvironment();
    const { result } = renderHook(() => useLocalClock(environment));
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.toISOString()).toBe("2026-10-21T12:01:00.000Z");
    vi.setSystemTime(new Date("2026-10-21T12:03:00Z"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current.toISOString()).toBe("2026-10-21T12:03:00.000Z");
    expect(vi.getTimerCount()).toBe(1);
  });
});
