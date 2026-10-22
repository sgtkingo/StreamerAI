import { describe, expect, it } from "vitest";
import {
  advanceWinterIce,
  createWinterIce,
  createIcicleLayout,
  icicleLengthLimit,
} from "./winter-ice";

function seconds(
  ice: ReturnType<typeof createWinterIce>,
  duration: number,
  snowing: boolean,
) {
  for (let frame = 0; frame < duration * 30; frame++)
    advanceWinterIce(ice, 1 / 30, snowing);
}

describe("winter frost and search accumulation", () => {
  it("concentrates a sparse, varied icicle layout at the edges and keeps center nubs short", () => {
    let seed = 937;
    const layout = createIcicleLayout(
      () => (seed = (seed * 16807) % 2147483647) / 2147483647,
    );
    expect(layout).toHaveLength(12);
    expect(
      layout.filter(
        (ice) => !ice.center && (ice.position < 20 || ice.position > 80),
      ),
    ).toHaveLength(10);
    expect(
      layout
        .filter((ice) => ice.center)
        .every((ice) => ice.length <= 18 && ice.round),
    ).toBe(true);
    expect(layout.some((ice) => ice.round && ice.length < 12)).toBe(true);
    expect(layout.some((ice) => !ice.round && ice.length > 50)).toBe(true);
    expect(new Set(layout.map((ice) => ice.duration)).size).toBe(12);
    expect(
      Math.max(...layout.map((ice) => ice.duration)) -
        Math.min(...layout.map((ice) => ice.duration)),
    ).toBeGreaterThan(50);
    expect(new Set(layout.map((ice) => ice.delay)).size).toBe(12);
  });

  it("limits intersecting tips to the button midpoint and leaves clear edge space available", () => {
    const buttons = [{ left: 200, right: 400, top: 114, height: 44 }];
    expect(icicleLengthLimit(90, 300, 10, 100, buttons)).toBe(34);
    expect(icicleLengthLimit(90, 197, 10, 100, buttons)).toBe(34);
    expect(icicleLengthLimit(90, 120, 10, 100, buttons)).toBe(90);
    expect(icicleLengthLimit(12, 300, 10, 100, buttons)).toBe(12);
    expect(
      icicleLengthLimit(90, 300, 10, 100, [{ ...buttons[0], top: 60 }]),
    ).toBe(0);
  });

  it("slowly grows bounded frost and icicles even when it is clear", () => {
    const ice = createWinterIce();
    seconds(ice, 15, false);
    expect(ice.icicles).toBeGreaterThan(0.2);
    expect(ice.icicles).toBeLessThan(0.3);
    expect(ice.frost).toBeGreaterThan(0.18);
    expect(ice.snow).toBe(0);
    seconds(ice, 600, false);
    expect(ice.icicles).toBeLessThanOrEqual(1);
    expect(ice.frost).toBeLessThanOrEqual(0.6);
  });

  it("accumulates snow only during snowfall and melts without resetting the ice", () => {
    const ice = createWinterIce();
    seconds(ice, 30, true);
    const snow = ice.snow,
      icicles = ice.icicles;
    expect(snow).toBeGreaterThan(0.6);
    seconds(ice, 15, false);
    expect(ice.snow).toBeLessThan(snow);
    expect(ice.snow).toBeGreaterThan(0.5);
    expect(ice.icicles).toBeGreaterThan(icicles);
    seconds(ice, 200, false);
    expect(ice.snow).toBe(0);
  });

  it("freezes with ambient time and clamps a delayed frame", () => {
    const ice = createWinterIce();
    seconds(ice, 20, true);
    const snapshot = { ...ice };
    advanceWinterIce(ice, 0, true);
    expect(ice).toEqual(snapshot);
    advanceWinterIce(ice, 100, true);
    expect(ice.age - snapshot.age).toBeCloseTo(0.08);
  });
});
