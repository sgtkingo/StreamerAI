import { describe, expect, it } from "vitest";
import {
  calendarDate,
  createAdvancingClock,
  createClockAnchor,
  effectiveClock,
  isValidTimeZone,
  resolveWallTime,
  toDateTimeLocal,
  zonedDateParts,
} from "./clock";
import { defaultDeviceEnvironment } from "./storage";

describe("environment clock", () => {
  it("formats an instant in the selected IANA zone independently of the runtime zone", () => {
    const instant = new Date("2026-06-01T00:00:00Z");
    expect(toDateTimeLocal(instant, "America/Los_Angeles")).toBe(
      "2026-05-31T17:00",
    );
    expect(calendarDate(instant, "America/Los_Angeles")).toBe("2026-05-31");
    expect(zonedDateParts(instant, "Asia/Kathmandu")).toMatchObject({
      hour: 5,
      minute: 45,
    });
    expect(isValidTimeZone("Invalid/Zone")).toBe(false);
    expect(toDateTimeLocal(instant, "Invalid/Zone")).toBe("2026-06-01T00:00");
  });

  it("rejects a nonexistent Prague spring time and invalid calendar dates", () => {
    expect(resolveWallTime("2026-03-29T02:30", "Europe/Prague")).toEqual({
      status: "nonexistent",
      candidates: [],
    });
    expect(resolveWallTime("2026-02-29T12:00", "Europe/Prague").status).toBe(
      "invalid",
    );
    expect(resolveWallTime("2026-02-01T25:00", "Europe/Prague").status).toBe(
      "invalid",
    );
    expect(resolveWallTime("bad", "UTC").status).toBe("invalid");
    expect(resolveWallTime("2026-02-01T12:00", "Invalid/Zone").status).toBe(
      "invalid",
    );
  });

  it("returns both ordered UTC offsets for the repeated Prague autumn time", () => {
    expect(resolveWallTime("2026-10-25T02:30", "Europe/Prague")).toEqual({
      status: "ambiguous",
      candidates: [
        { instant: "2026-10-25T00:30:00.000Z", offsetLabel: "UTC+02:00" },
        { instant: "2026-10-25T01:30:00.000Z", offsetLabel: "UTC+01:00" },
      ],
    });
  });

  it("supports fractional offsets and half-hour DST transitions", () => {
    expect(resolveWallTime("2026-06-01T12:00", "Asia/Kathmandu")).toEqual({
      status: "valid",
      candidates: [
        { instant: "2026-06-01T06:15:00.000Z", offsetLabel: "UTC+05:45" },
      ],
    });
    expect(
      resolveWallTime("2026-04-05T01:45", "Australia/Lord_Howe"),
    ).toMatchObject({
      status: "ambiguous",
      candidates: [{ offsetLabel: "UTC+11:00" }, { offsetLabel: "UTC+10:30" }],
    });
    expect(
      resolveWallTime("2026-10-04T02:15", "Australia/Lord_Howe").status,
    ).toBe("nonexistent");
    expect(resolveWallTime("2011-12-30T12:00", "Pacific/Apia").status).toBe(
      "nonexistent",
    );
  });

  it("advances a saved manual instant across reload and DST without changing its zone", () => {
    const environment = {
      ...defaultDeviceEnvironment(),
      autoDetectTime: false,
      timeZone: "Europe/Prague",
      manualClock: createClockAnchor(
        new Date("2026-03-29T00:59:00Z"),
        new Date("2026-10-20T12:00:00Z"),
      ),
    };
    const result = effectiveClock(
      environment,
      new Date("2026-10-20T12:02:00Z"),
    );
    expect(result.instant.toISOString()).toBe("2026-03-29T01:01:00.000Z");
    expect(toDateTimeLocal(result.instant, result.timeZone)).toBe(
      "2026-03-29T03:01",
    );
    const rezoned = effectiveClock(
      { ...environment, timeZone: "America/New_York" },
      new Date("2026-10-20T12:02:00Z"),
    );
    expect(rezoned.instant).toEqual(result.instant);
    expect(rezoned.timeZone).toBe("America/New_York");
  });

  it("uses monotonic elapsed time while active and the saved real anchor after resume", () => {
    let realNow = new Date("2026-10-20T12:00:00Z");
    let monotonic = 100;
    const environment = {
      ...defaultDeviceEnvironment(),
      autoDetectTime: false,
      manualClock: createClockAnchor(new Date("2026-12-25T12:00:00Z"), realNow),
    };
    const clock = createAdvancingClock(
      environment,
      () => realNow,
      () => monotonic,
    );
    monotonic += 60_000;
    realNow = new Date("2026-10-20T14:00:00Z");
    expect(clock.now().toISOString()).toBe("2026-12-25T12:01:00.000Z");
    clock.reconcile();
    expect(clock.now().toISOString()).toBe("2026-12-25T14:00:00.000Z");
  });

  it("returns to real device time when autodetection is enabled", () => {
    const realNow = new Date("2026-10-20T12:00:00Z");
    const environment = {
      ...defaultDeviceEnvironment(),
      manualClock: createClockAnchor(new Date("2026-12-25T12:00:00Z"), realNow),
    };
    expect(effectiveClock(environment, realNow).instant).toEqual(realNow);
  });
});
