export interface StormSurge {
  phase: "quiet" | "rise" | "peak" | "fall";
  age: number;
  intensity: number;
  low: number;
  high: number;
  quietDuration: number;
  riseDuration: number;
  peakDuration: number;
  fallDuration: number;
}

function cycle(random: () => number) {
  return {
    low: 0.2 + random() * 0.25,
    high: 0.9 + random() * 0.1,
    quietDuration: 1.5 + random() * 3.5,
    riseDuration: 0.06 + random() * 0.1,
    peakDuration: 1 + random(),
    fallDuration: 0.18 + random() * 0.32,
  };
}

export function createStormSurge(
  random: () => number = Math.random,
): StormSurge {
  const timing = cycle(random);
  return { ...timing, phase: "quiet", age: 0, intensity: timing.low };
}

/** Sharp gusts use simulation time, so pauses never skip into a peak. */
export function advanceStormSurge(
  surge: StormSurge,
  elapsed: number,
  random: () => number = Math.random,
) {
  if (elapsed <= 0) return;
  surge.age += elapsed;
  const duration = () => surge[`${surge.phase}Duration`];
  while (surge.age >= duration()) {
    surge.age -= duration();
    if (surge.phase === "quiet") surge.phase = "rise";
    else if (surge.phase === "rise") surge.phase = "peak";
    else if (surge.phase === "peak") surge.phase = "fall";
    else {
      Object.assign(surge, cycle(random));
      surge.phase = "quiet";
    }
  }
  const progress = Math.min(1, surge.age / duration());
  const smooth = progress * progress * (3 - 2 * progress);
  surge.intensity =
    surge.phase === "quiet"
      ? surge.low
      : surge.phase === "peak"
        ? surge.high
        : surge.phase === "rise"
          ? surge.low + (surge.high - surge.low) * smooth
          : surge.high + (surge.low - surge.high) * smooth;
}
