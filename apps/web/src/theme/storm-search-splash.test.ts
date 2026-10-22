import { describe, expect, it } from "vitest";
import { STORM_IMPACT_ANGLE } from "./glass-weather";
import {
  advanceSearchSplash,
  createSearchSplash,
  searchImpactAppearance,
} from "./storm-search-splash";

describe("storm impacts on the search surface", () => {
  it.each([0.5, 0.1])(
    "strikes an exposed edge and reflects outwards (%s)",
    (seed) => {
      const scene = createSearchSplash(900, 74);
      advanceSearchSplash(scene, 0.08, 1, () => seed);
      const impact = scene.impacts[0];
      const before = searchImpactAppearance(impact);
      expect(before.incoming).toBe(true);
      expect(before.x).toBeLessThan(impact.x);
      expect(before.y).toBeLessThan(impact.y);
      expect(before.beads).toHaveLength(0);
      expect(impact.tilt).toBeCloseTo(STORM_IMPACT_ANGLE + (seed - 0.5) * 0.12);
      impact.age = impact.approach + 0.1;
      const after = searchImpactAppearance(impact);
      expect(after.incoming).toBe(false);
      expect(after.beads).toHaveLength(5);
      if (seed === 0.5) {
        expect(impact.y).toBe(0);
        expect(impact.x).toBeGreaterThan(14);
        expect(impact.x).toBeLessThan(886);
        expect(after.beads.every((bead) => bead.y < 0)).toBe(true);
      } else {
        expect(impact.x).toBe(0);
        expect(after.beads.every((bead) => bead.x < 0)).toBe(true);
      }
    },
  );

  it("evaporates spray through opacity while preserving bead size", () => {
    const scene = createSearchSplash(900, 74);
    advanceSearchSplash(scene, 0.08, 1, () => 0.5);
    const impact = scene.impacts[0];
    impact.age = impact.approach + 0.05;
    const early = searchImpactAppearance(impact).beads[0];
    impact.age += 0.2;
    const later = searchImpactAppearance(impact).beads[0];
    expect(later.radius).toBe(early.radius);
    expect(later.opacity).toBeLessThan(early.opacity);
    expect(later.x).not.toBe(early.x);
    impact.age += 0.5;
    expect(
      searchImpactAppearance(impact).beads.every((bead) => bead.opacity === 0),
    ).toBe(true);
  });

  it("increases arrival frequency and force during the shared storm peak", () => {
    const quiet = createSearchSplash(900, 74);
    const peak = createSearchSplash(900, 74);
    advanceSearchSplash(quiet, 0.08, 0.2, () => 0.5);
    advanceSearchSplash(peak, 0.08, 1, () => 0.5);
    expect(peak.nextImpact).toBeLessThan(quiet.nextImpact);
    expect(peak.impacts[0].distance).toBeGreaterThan(quiet.impacts[0].distance);
    expect(peak.impacts[0].approach).toBeLessThan(quiet.impacts[0].approach);
    expect(Math.abs(peak.impacts[0].beads[0].vy)).toBeGreaterThan(
      Math.abs(quiet.impacts[0].beads[0].vy),
    );
  });

  it("bounds impact storage and slows compact screen arrivals", () => {
    const desktop = createSearchSplash(900, 74);
    const compact = createSearchSplash(340, 74);
    advanceSearchSplash(desktop, 0.08, 1, () => 0.5);
    advanceSearchSplash(compact, 0.08, 1, () => 0.5);
    expect(compact.nextImpact).toBeGreaterThan(desktop.nextImpact);
    for (let frame = 0; frame < 10000; frame++) {
      advanceSearchSplash(desktop, 1 / 30, 1, () => 0);
      expect(desktop.impacts.length).toBeLessThanOrEqual(14);
    }
    expect(
      desktop.impacts.every((impact) => impact.age < impact.approach + 0.65),
    ).toBe(true);
  });

  it("freezes with the ambient clock and clamps delayed frames", () => {
    const scene = createSearchSplash(900, 74);
    advanceSearchSplash(scene, 0.08, 1, () => 0.5);
    const snapshot = structuredClone(scene);
    advanceSearchSplash(scene, 0, 1);
    expect(scene).toEqual(snapshot);
    advanceSearchSplash(scene, 30, 1, () => 0.5);
    expect(scene.impacts[0].age).toBe(0.08);
  });
});
