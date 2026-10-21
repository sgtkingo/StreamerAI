export const CHRISTMAS_LIGHT_COLORS = [
  "#f16c72",
  "#f3d16e",
  "#69c98e",
  "#80b5f1",
  "#d997e8",
] as const;

export const FIREWORK_COLORS = [
  "#efc878",
  "#ed93bf",
  "#95b9f5",
  "#a48be8",
  "#8fd4bd",
] as const;

export interface FireworkSpark {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  velocityX: number;
  velocityY: number;
  color: string;
  size: number;
}

export interface FireworkBurst {
  age: number;
  duration: number;
  sparks: FireworkSpark[];
}

export function festiveSceneBudget(compact: boolean) {
  return compact
    ? { snow: 16, lights: 10, bursts: 1, sparksPerBurst: 32, weather: 4 }
    : { snow: 28, lights: 18, bursts: 2, sparksPerBurst: 42, weather: 8 };
}

/** A bounded radial burst. Its fade-in avoids a sudden central flash. */
export function createFireworkBurst(
  width: number,
  height: number,
  sparkCount: number,
  random: () => number = Math.random,
): FireworkBurst {
  const x = width * (0.12 + random() * 0.76);
  const y = height * (0.14 + random() * 0.4);
  const color = FIREWORK_COLORS[Math.floor(random() * FIREWORK_COLORS.length)];
  const count = Math.min(42, Math.max(0, Math.floor(sparkCount)));
  return {
    age: 0,
    duration: 3.6 + random() * 1.2,
    sparks: Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 + random() * 0.06;
      const speed = (width < 768 ? 28 : 42) + random() * 34;
      return {
        x,
        y,
        previousX: x,
        previousY: y,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed,
        color: index % 7 === 0 ? "#f4dfb3" : color,
        size: 0.8 + random() * 0.8,
      };
    }),
  };
}

export function advanceFireworkBurst(
  burst: FireworkBurst,
  elapsed: number,
): void {
  // Bound resumed-tab work and prevent large jumps if a frame was delayed.
  const delta = Math.max(0, Math.min(elapsed, 0.08));
  const waiting = burst.age < 0;
  burst.age += delta;
  if (waiting) return;
  for (const spark of burst.sparks) {
    spark.previousX = spark.x;
    spark.previousY = spark.y;
    const drag = Math.exp(-delta * 0.45);
    spark.velocityX *= drag;
    spark.velocityY = spark.velocityY * drag + delta * 11;
    spark.x += spark.velocityX * delta;
    spark.y += spark.velocityY * delta;
  }
}

export function fireworkOpacity(burst: FireworkBurst): number {
  if (burst.age < 0 || burst.age >= burst.duration) return 0;
  const fadeIn = Math.min(1, burst.age / 0.35);
  const fadeOut = Math.max(0, 1 - burst.age / burst.duration);
  return fadeIn * fadeOut * fadeOut * 0.62;
}
