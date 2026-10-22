import { describe, expect, it } from "vitest";
import {
  advanceAutumnWind,
  createAutumnWind,
  windLeafAppearance,
} from "./autumn-wind";

describe("wind-blown autumn leaves", () => {
  it.each([0.25, 0.75])(
    "enters from a side, glides, loops and exits without jumps (%s)",
    (value) => {
      const random = () => value;
      const scene = createAutumnWind(1440, 960, false, false, random);
      while (!scene.leaves.length) advanceAutumnWind(scene, 0.04, random);
      const leaf = scene.leaves[0];
      const start = windLeafAppearance(leaf);
      expect(value < 0.5 ? start.x < 0 : start.x > 1440).toBe(true);
      const phases = new Set<string>();
      let previous = start;
      let reversesX = false,
        reversesY = false;
      for (let age = 0.04; age < leaf.duration; age += 0.04) {
        leaf.age = age;
        const look = windLeafAppearance(leaf);
        phases.add(look.phase);
        expect(
          Math.hypot(look.x - previous.x, look.y - previous.y),
        ).toBeLessThan(65);
        expect(Math.abs(look.rotation - previous.rotation)).toBeLessThan(0.25);
        if (look.phase === "loop") {
          if ((look.x - previous.x) * (value < 0.5 ? 1 : -1) < -0.1)
            reversesX = true;
          if (look.y - previous.y < -0.1) reversesY = true;
        }
        previous = look;
      }
      expect(phases).toEqual(new Set(["sweep", "glide", "loop", "exit"]));
      expect(reversesX).toBe(true);
      expect(reversesY).toBe(true);
      leaf.age = leaf.duration;
      const end = windLeafAppearance(leaf);
      expect(value < 0.5 ? end.x > 1440 : end.x < 0).toBe(true);
      expect(end.opacity).toBe(0);
    },
  );

  it("makes distant leaves smaller and more diffuse, and near leaves larger and sharper", () => {
    const scene = createAutumnWind(1440, 960, false, false, () => 0.75);
    while (!scene.leaves.length) advanceAutumnWind(scene, 0.08, () => 0.75);
    const leaf = scene.leaves[0];
    const samples = [];
    for (let age = 1; age < leaf.duration - 1; age += 0.1) {
      leaf.age = age;
      samples.push(windLeafAppearance(leaf));
    }
    samples.sort((a, b) => a.depth - b.depth);
    const far = samples[0],
      near = samples[samples.length - 1];
    expect(near.size).toBeGreaterThan(far.size * 2);
    expect(near.blurLevel).toBeLessThan(far.blurLevel);
    expect(near.opacity).toBeGreaterThan(far.opacity);
    expect(
      samples.every((sample) => sample.blurLevel >= 0 && sample.blurLevel <= 3),
    ).toBe(true);
    expect(
      samples.every(
        (sample) => sample.foreshortening >= 0.22 && sample.foreshortening <= 1,
      ),
    ).toBe(true);
  });

  it.each([
    [false, false, 2],
    [true, false, 1],
    [false, true, 1],
  ] as const)(
    "bounds occasional arrivals (compact=%s, weather=%s)",
    (compact, busy, budget) => {
      let seed = 123;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const scene = createAutumnWind(
        compact ? 390 : 1440,
        960,
        compact,
        busy,
        random,
      );
      const seen = new Set();
      let emptyFrames = 0;
      for (let frame = 0; frame < 1500; frame += 1) {
        advanceAutumnWind(scene, 0.08, random);
        expect(scene.leaves.length).toBeLessThanOrEqual(budget);
        if (!scene.leaves.length) emptyFrames++;
        for (const leaf of scene.leaves) {
          seen.add(leaf);
          expect(Number.isFinite(windLeafAppearance(leaf).x)).toBe(true);
        }
      }
      expect(seen.size).toBeGreaterThan(3);
      expect(seen.size).toBeLessThan(20);
      expect(emptyFrames).toBeGreaterThan(0);
    },
  );

  it("freezes all progress at zero elapsed time and bounds delayed frames", () => {
    const scene = createAutumnWind(1440, 960, false, false, () => 0.5);
    const initial = JSON.stringify(scene);
    advanceAutumnWind(scene, 0, () => 0.5);
    expect(JSON.stringify(scene)).toBe(initial);
    advanceAutumnWind(scene, 60, () => 0.5);
    expect(scene.time).toBe(0.08);
    expect(scene.leaves).toHaveLength(0);
  });
});
