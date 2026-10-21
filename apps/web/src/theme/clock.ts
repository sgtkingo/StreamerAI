import type { DeviceEnvironment } from "./storage";

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function detectedTimeZone(): string {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(timeZone) ? timeZone : "UTC";
  } catch {
    return "UTC";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function calendarDate(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function toDateTimeLocal(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export interface WallTimeCandidate {
  instant: string;
  offsetLabel: string;
}

export interface WallTimeResolution {
  status: "valid" | "ambiguous" | "nonexistent" | "invalid";
  candidates: WallTimeCandidate[];
}

/** Resolve a wall clock without relying on the browser's own timezone or DST rules. */
export function resolveWallTime(
  value: string,
  timeZone: string,
): WallTimeResolution {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match || !isValidTimeZone(timeZone)) {
    return { status: "invalid", candidates: [] };
  }
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
  ].map(Number);
  const wallMilliseconds = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wallMilliseconds);
  if (
    year < 1000 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return { status: "invalid", candidates: [] };
  }

  // Sample both sides of a transition. This also covers half-hour DST
  // transitions and IANA date-line changes, unlike a fixed-offset conversion.
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wallMilliseconds + hours * 60 * 60 * 1000;
    const local = zonedDateParts(new Date(sample), timeZone);
    offsets.add(
      Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
        local.second,
      ) - sample,
    );
  }
  const candidates = [...offsets]
    .map((offset) => ({ offset, instant: wallMilliseconds - offset }))
    .filter(
      ({ instant }) => toDateTimeLocal(new Date(instant), timeZone) === value,
    )
    .sort((a, b) => a.instant - b.instant)
    .map(({ offset, instant }) => {
      const minutes = Math.abs(Math.round(offset / 60_000));
      return {
        instant: new Date(instant).toISOString(),
        offsetLabel: `UTC${offset < 0 ? "−" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
      };
    });
  return {
    status:
      candidates.length > 1
        ? "ambiguous"
        : candidates.length === 1
          ? "valid"
          : "nonexistent",
    candidates,
  };
}

export function createClockAnchor(instant: Date, realNow = new Date()) {
  return { instant: instant.toISOString(), setAt: realNow.toISOString() };
}

export function effectiveClock(
  environment: DeviceEnvironment,
  realNow = new Date(),
): { instant: Date; timeZone: string } {
  const timeZone = environment.autoDetectTime
    ? detectedTimeZone()
    : environment.timeZone;
  const anchor = environment.manualClock;
  return {
    instant:
      !environment.autoDetectTime && anchor
        ? new Date(
            Date.parse(anchor.instant) +
              realNow.getTime() -
              Date.parse(anchor.setAt),
          )
        : new Date(realNow.getTime()),
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
  };
}

/** Use monotonic elapsed time while active; reconcile to the real anchor on resume. */
export function createAdvancingClock(
  environment: DeviceEnvironment,
  realNow: () => Date = () => new Date(),
  monotonicNow: () => number = () => performance.now(),
) {
  let effectiveAnchor = effectiveClock(
    environment,
    realNow(),
  ).instant.getTime();
  let monotonicAnchor = monotonicNow();
  return {
    now: () => new Date(effectiveAnchor + monotonicNow() - monotonicAnchor),
    reconcile: () => {
      effectiveAnchor = effectiveClock(
        environment,
        realNow(),
      ).instant.getTime();
      monotonicAnchor = monotonicNow();
    },
  };
}
