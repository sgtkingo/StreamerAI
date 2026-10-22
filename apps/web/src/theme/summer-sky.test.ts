import { describe, expect, it } from "vitest";
import {
  advanceSummerNight,
  createSummerNight,
  lunarPhase,
  meteorAppearance,
  moonIlluminationPath,
} from "./summer-sky";

describe("decorative lunar phase", () => {
  it("tracks new and full moons without weather or a timezone", () => {
    // Independent calendar dates: https://catalina.lpl.arizona.edu/moon-phases/month/2026-06
    const newMoon = lunarPhase(new Date("2026-06-15T02:54:00Z"));
    expect(Math.min(newMoon, 1 - newMoon)).toBeLessThan(0.04);
    expect(lunarPhase(new Date("2026-06-29T23:57:00Z"))).toBeCloseTo(0.5, 1);
    expect(lunarPhase(new Date("2026-06-30T01:57:00+02:00"))).toBe(
      lunarPhase(new Date("2026-06-29T23:57:00Z")),
    );
    expect(lunarPhase(new Date("1990-01-01T00:00:00Z"))).toBeGreaterThanOrEqual(
      0,
    );
    expect(lunarPhase(new Date("1990-01-01T00:00:00Z"))).toBeLessThan(1);
  });

  it.each([0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9])(
    "projects the illuminated area and correct side at phase %s",
    (phase) => {
      const points = [
        ...moonIlluminationPath(phase).matchAll(/(-?[\d.]+),(-?[\d.]+)/g),
      ].map((match) => [Number(match[1]), Number(match[2])]);
      const area =
        Math.abs(
          points.reduce((sum, point, index) => {
            const next = points[(index + 1) % points.length];
            return sum + point[0] * next[1] - next[0] * point[1];
          }, 0),
        ) / 2;
      expect(area / (Math.PI * 34 ** 2)).toBeCloseTo(
        (1 - Math.cos(phase * Math.PI * 2)) / 2,
        2,
      );
      if (phase > 0 && phase < 0.5) expect(points[24][0]).toBe(34);
      if (phase > 0.5) expect(points[24][0]).toBe(-34);
    },
  );
});

describe("occasional summer meteors", () => {
  it("waits before the first meteor, bounds the pool and removes faded meteors", () => {
    const scene = createSummerNight(1440, 960, () => 0.5);
    expect(scene.nextMeteor).toBe(7.5);
    for (let frame = 0; frame < 180; frame++)
      advanceSummerNight(scene, 1 / 30, () => 0.5);
    expect(scene.meteor).toBeNull();
    scene.nextMeteor = 0;
    advanceSummerNight(scene, 1 / 30, () => 0.5);
    expect(scene.meteor).not.toBeNull();
    expect(scene.nextMeteor).toBe(24.5);
    const meteor = scene.meteor!;
    for (let frame = 0; frame < 15; frame++)
      advanceSummerNight(scene, 1 / 30, () => 0.5);
    expect(scene.meteor).toBe(meteor);
    for (let frame = 0; frame < 30; frame++)
      advanceSummerNight(scene, 1 / 30, () => 0.5);
    expect(scene.meteor).toBeNull();
  });

  it("moves the head and keeps a fading tail behind it, in both directions", () => {
    for (const seed of [0.1, 0.8]) {
      const scene = createSummerNight(1440, 960, () => seed);
      scene.nextMeteor = 0;
      advanceSummerNight(scene, 0.08, () => seed);
      const meteor = scene.meteor!;
      expect(meteorAppearance(meteor).opacity).toBe(0);
      meteor.age = meteor.duration / 2;
      const look = meteorAppearance(meteor);
      expect(look.opacity).toBeCloseTo(0.85);
      expect((look.x - look.tailX) * meteor.vx).toBeGreaterThan(0);
      expect(look.y).toBeGreaterThan(look.tailY);
      meteor.age = meteor.duration;
      expect(meteorAppearance(meteor).opacity).toBeCloseTo(0);
    }
  });

  it("uses shorter trails on mobile and pauses without skipping time", () => {
    const desktop = createSummerNight(1440, 960, () => 0.5);
    const compact = createSummerNight(390, 844, () => 0.5);
    desktop.nextMeteor = compact.nextMeteor = 0;
    advanceSummerNight(desktop, 0.08, () => 0.5);
    advanceSummerNight(compact, 0.08, () => 0.5);
    expect(compact.meteor!.tail).toBeLessThan(desktop.meteor!.tail);
    const before = structuredClone(compact);
    advanceSummerNight(compact, 0);
    expect(compact).toEqual(before);
    advanceSummerNight(compact, 30);
    expect(compact.meteor!.age).toBe(0.08);
  });
});
