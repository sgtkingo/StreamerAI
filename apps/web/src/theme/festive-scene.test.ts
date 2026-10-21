import { describe, expect, it } from "vitest";
import {
  advanceFireworkBurst,
  createFireworkBurst,
  festiveSceneBudget,
  fireworkOpacity,
} from "./festive-scene";

describe("festive background simulation", () => {
  it("bounds simultaneous New Year sparks, decorative snow and weather on both layouts", () => {
    for (const compact of [false, true]) {
      const budget = festiveSceneBudget(compact);
      const active =
        budget.snow + budget.bursts * budget.sparksPerBurst + budget.weather;
      expect(active).toBeLessThanOrEqual(compact ? 52 : 120);
      expect(budget.snow).toBeGreaterThan(0);
    }
    expect(createFireworkBurst(1440, 900, 10_000).sparks).toHaveLength(42);
  });

  it("spreads sparks radially, retains trails and adds gentle downward drift", () => {
    const burst = createFireworkBurst(1440, 900, 20, () => 0.5);
    const origin = { x: burst.sparks[0].x, y: burst.sparks[0].y };
    advanceFireworkBurst(burst, 0.05);
    expect(burst.sparks.some((spark) => spark.x > origin.x)).toBe(true);
    expect(burst.sparks.some((spark) => spark.x < origin.x)).toBe(true);
    expect(burst.sparks.some((spark) => spark.y > origin.y)).toBe(true);
    expect(burst.sparks.some((spark) => spark.y < origin.y)).toBe(true);
    expect(
      burst.sparks.every(
        (spark) => spark.previousX === origin.x && spark.previousY === origin.y,
      ),
    ).toBe(true);
  });

  it("fades in gradually and reaches zero after the burst lifespan", () => {
    const burst = createFireworkBurst(1440, 900, 20, () => 0.5);
    expect(fireworkOpacity(burst)).toBe(0);
    burst.age = 0.05;
    const first = fireworkOpacity(burst);
    burst.age = 0.35;
    expect(fireworkOpacity(burst)).toBeGreaterThan(first);
    burst.age = burst.duration - 0.1;
    expect(fireworkOpacity(burst)).toBeLessThan(first);
    burst.age = burst.duration;
    expect(fireworkOpacity(burst)).toBe(0);
  });

  it("bounds elapsed work after a long interruption", () => {
    const burst = createFireworkBurst(390, 844, 32, () => 0.5);
    advanceFireworkBurst(burst, 60);
    expect(burst.age).toBe(0.08);
    expect(
      burst.sparks.every(
        (spark) => Number.isFinite(spark.x) && Number.isFinite(spark.y),
      ),
    ).toBe(true);
  });
});
