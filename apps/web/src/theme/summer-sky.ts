// Mean-lunation approximation for decoration, not an astronomical ephemeris.
// Phase geometry: https://aa.usno.navy.mil/faq/moon_phases
// Reference new moon: 2000-01-06 18:14 UTC; mean synodic month 29.530588853 d.
const NEW_MOON = Date.parse("2000-01-06T18:14:00Z");
const LUNATION_MS = 29.530588853 * 86_400_000;

/** 0=new, .25=first quarter, .5=full, .75=last quarter. */
export function lunarPhase(instant: Date): number {
  const cycles = (instant.getTime() - NEW_MOON) / LUNATION_MS;
  return cycles - Math.floor(cycles);
}

/** Project the illuminated hemisphere, with a curved terminator at every phase. */
export function moonIlluminationPath(phase: number, radius = 34): string {
  const normalized = ((phase % 1) + 1) % 1;
  const side = normalized < 0.5 ? 1 : -1;
  const terminator = Math.cos(normalized * Math.PI * 2);
  const points: string[] = [];
  for (let step = 0; step <= 48; step++) {
    const angle = -Math.PI / 2 + (step / 48) * Math.PI;
    points.push(
      `${(side * radius * Math.cos(angle)).toFixed(3)},${(radius * Math.sin(angle)).toFixed(3)}`,
    );
  }
  for (let step = 48; step >= 0; step--) {
    const angle = -Math.PI / 2 + (step / 48) * Math.PI;
    points.push(
      `${(side * terminator * radius * Math.cos(angle)).toFixed(3)},${(radius * Math.sin(angle)).toFixed(3)}`,
    );
  }
  return `M ${points.join(" L ")} Z`;
}

/** Stable positions prevent clock renders from rearranging the sky. */
export const SUMMER_STARS = Array.from({ length: 64 }, (_, index) => {
  const noise = (seed: number) => {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  return {
    x: 2 + noise(index + 1) * 96,
    y: 3 + noise(index + 101) * 85,
    size: index % 9 === 0 ? 2.2 : 0.9 + noise(index + 201) * 0.8,
    opacity: 0.4 + noise(index + 301) * 0.55,
    bright: index % 9 === 0,
  };
});

export interface SummerMeteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  duration: number;
  tail: number;
}

export interface SummerNight {
  width: number;
  height: number;
  compact: boolean;
  nextMeteor: number;
  meteor: SummerMeteor | null;
}

export function createSummerNight(
  width: number,
  height: number,
  random: () => number = Math.random,
): SummerNight {
  return {
    width,
    height,
    compact: width < 768,
    nextMeteor: 5 + random() * 5,
    meteor: null,
  };
}

export function advanceSummerNight(
  scene: SummerNight,
  elapsed: number,
  random: () => number = Math.random,
) {
  const delta = Math.max(0, Math.min(0.08, elapsed));
  if (!delta) return;
  if (scene.meteor) {
    scene.meteor.age += delta;
    if (scene.meteor.age >= scene.meteor.duration) scene.meteor = null;
  }
  scene.nextMeteor -= delta;
  if (scene.meteor || scene.nextMeteor > 0) return;
  const direction = random() < 0.25 ? -1 : 1;
  const speed = scene.compact ? 240 + random() * 130 : 450 + random() * 230;
  const angle = 0.3 + random() * 0.3;
  scene.meteor = {
    x:
      scene.width *
      (direction === 1 ? 0.08 + random() * 0.5 : 0.6 + random() * 0.32),
    y: scene.height * (0.04 + random() * 0.26),
    vx: Math.cos(angle) * speed * direction,
    vy: Math.sin(angle) * speed,
    age: 0,
    duration: 0.8 + random() * 0.5,
    tail: scene.compact ? 55 + random() * 55 : 110 + random() * 110,
  };
  scene.nextMeteor = 14 + random() * 21;
}

export function meteorAppearance(meteor: SummerMeteor) {
  const progress = Math.max(0, Math.min(1, meteor.age / meteor.duration));
  const speed = Math.hypot(meteor.vx, meteor.vy);
  const tail = meteor.tail * Math.min(1, progress * 6);
  const x = meteor.x + meteor.vx * meteor.age;
  const y = meteor.y + meteor.vy * meteor.age;
  return {
    x,
    y,
    tailX: x - (meteor.vx / speed) * tail,
    tailY: y - (meteor.vy / speed) * tail,
    opacity: Math.sin(progress * Math.PI) * 0.85,
  };
}
