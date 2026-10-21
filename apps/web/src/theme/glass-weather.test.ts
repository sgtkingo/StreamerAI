import { describe, expect, it } from "vitest";
import {
  advanceGlassWeather,
  createGlassWeather,
  dropletAppearance,
  dropletLifetime,
  glassWeatherBudget,
  lightningOpacity,
  snowflakeAppearance,
} from "./glass-weather";
import { festiveSceneBudget } from "./festive-scene";

const random = () => 0.5;

describe("glass weather simulation", () => {
  it("holds rain beads on glass before slowly sliding and fading them", () => {
    const scene = createGlassWeather(
      "rain",
      1440,
      900,
      false,
      false,
      () => 0.25,
    );
    const drop = scene.droplets[1];
    drop.age = 0.1;
    expect(dropletAppearance(drop)).toMatchObject({ phase: "impact" });
    expect(dropletAppearance(drop).condensationOpacity).toBeGreaterThan(0);
    const impact = { x: drop.originX, y: drop.originY };
    drop.age = drop.impactDuration + 0.1;
    advanceGlassWeather(scene, 0.05, random);
    expect(dropletAppearance(drop).phase).toBe("bead");
    expect(drop.y).toBe(drop.originY);
    drop.age = drop.impactDuration + drop.holdDuration + 1;
    advanceGlassWeather(scene, 0.05, random);
    expect(dropletAppearance(drop).phase).toBe("sliding");
    expect(drop.y).toBeGreaterThan(drop.originY);
    expect({ x: drop.originX, y: drop.originY }).toEqual(impact);
    expect(dropletAppearance(drop).scaleY).toBeGreaterThan(drop.aspect);
    expect(dropletAppearance(drop).trailLength).toBeGreaterThan(0);
    drop.age = dropletLifetime(drop) - 0.7;
    expect(dropletAppearance(drop)).toMatchObject({
      phase: "fading",
    });
    expect(dropletAppearance(drop).opacity).toBeLessThan(0.5);
    const previousY = drop.y;
    const fading = dropletAppearance(drop);
    advanceGlassWeather(scene, 0.08, random);
    expect(drop.y).toBeGreaterThan(previousY);
    expect(dropletAppearance(drop).opacity).toBeLessThan(fading.opacity);
    expect(dropletAppearance(drop).rotation).not.toBe(fading.rotation);
    expect(dropletAppearance(drop).scaleX).toBeLessThan(fading.scaleX);
    drop.age = dropletLifetime(drop);
    expect(dropletAppearance(drop).opacity).toBe(0);
    expect(dropletAppearance(drop).condensationOpacity).toBe(0);
  });

  it("keeps half the beads stationary without trails and mists only selected impacts", () => {
    let seed = 42;
    const seededRandom = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (const kind of ["rain", "storm"] as const) {
      const scene = createGlassWeather(
        kind,
        1440,
        900,
        false,
        false,
        seededRandom,
      );
      expect(scene.droplets.filter((drop) => drop.stationary)).toHaveLength(
        scene.droplets.length / 2,
      );
      expect(scene.droplets.some((drop) => drop.condensation)).toBe(true);
      expect(scene.droplets.some((drop) => !drop.condensation)).toBe(true);
      for (const drop of scene.droplets) {
        drop.age =
          drop.impactDuration + drop.holdDuration + drop.slideDuration * 0.75;
      }
      advanceGlassWeather(scene, 0.08, seededRandom);
      for (const drop of scene.droplets) {
        const look = dropletAppearance(drop);
        if (drop.stationary) {
          expect([drop.x, drop.y]).toEqual([drop.originX, drop.originY]);
          expect(look.trailLength).toBe(0);
          expect(look.trailWidth).toBe(0);
          expect(look.opacity).toBeGreaterThan(0);
          expect(look.opacity).toBeLessThan(0.5);
        }
        if (!drop.condensation) expect(look.condensationOpacity).toBe(0);
      }
      for (let step = 0; step < 600; step += 1)
        advanceGlassWeather(scene, 0.08, seededRandom);
      expect(scene.droplets.filter((drop) => drop.stationary)).toHaveLength(
        scene.droplets.length / 2,
      );
    }
  });

  it("recycles droplets without growing the scene and makes storm visibly denser", () => {
    const rain = createGlassWeather("rain", 1440, 900, false, false, random);
    const storm = createGlassWeather("storm", 1440, 900, false, false, random);
    expect(storm.droplets.length).toBeGreaterThan(rain.droplets.length);
    expect(storm.droplets[0].slideSpeed).toBeGreaterThan(
      rain.droplets[0].slideSpeed,
    );
    const old = rain.droplets[0];
    old.age = dropletLifetime(old) - 0.01;
    advanceGlassWeather(rain, 0.08, random);
    expect(rain.droplets[0]).not.toBe(old);
    expect(rain.droplets).toHaveLength(glassWeatherBudget("rain", false));
    expect(rain.droplets[0].age).toBe(0);
  });

  it("lands flakes on glass, holds their position and grows bounded rim frost", () => {
    const scene = createGlassWeather("snow", 1440, 900, false, false, random);
    const flake = scene.flakes[0];
    flake.age = flake.flightDuration - 0.01;
    const previousFrost = scene.frost;
    advanceGlassWeather(scene, 0.04, random);
    expect(snowflakeAppearance(flake).phase).toBe("stuck");
    expect(flake.x).toBe(flake.targetX);
    expect(flake.y).toBe(flake.targetY);
    expect(scene.frost).toBeGreaterThan(previousFrost);
    const position = { x: flake.x, y: flake.y };
    advanceGlassWeather(scene, 0.08, random);
    expect(flake).toMatchObject(position);
    flake.age = flake.flightDuration + flake.holdDuration + 1;
    expect(snowflakeAppearance(flake).phase).toBe("melting");
    for (let step = 0; step < 8_000; step += 1)
      advanceGlassWeather(scene, 0.08, random);
    expect(scene.frost).toBeLessThanOrEqual(0.58);
    expect(scene.flakes).toHaveLength(20);
  });

  it("separates localized storm illuminations and uses a smooth bounded envelope", () => {
    const scene = createGlassWeather("storm", 1440, 900, false, false, random);
    expect(lightningOpacity(scene)).toBe(0);
    scene.time = scene.nextLightning - 0.04;
    advanceGlassWeather(scene, 0.08, random);
    expect(scene.lightningAge).toBe(0);
    expect(scene.nextLightning - scene.time).toBeGreaterThanOrEqual(7);
    expect(lightningOpacity(scene)).toBe(0);
    scene.lightningAge = 0.1;
    const rising = lightningOpacity(scene);
    scene.lightningAge = 0.4;
    expect(lightningOpacity(scene)).toBeGreaterThan(rising);
    expect(lightningOpacity(scene)).toBeLessThanOrEqual(0.22);
    scene.lightningAge = 1.4;
    expect(lightningOpacity(scene)).toBeLessThan(rising);
    scene.lightningAge = 1.6;
    expect(lightningOpacity(scene)).toBe(0);
    expect(lightningOpacity(createGlassWeather("rain", 1440, 900, false))).toBe(
      0,
    );
  });

  it("keeps the combined New Year fireworks, holiday snow and glass effects bounded", () => {
    for (const compact of [false, true]) {
      const festive = festiveSceneBudget(compact);
      for (const kind of ["rain", "storm", "snow"] as const) {
        const total =
          festive.snow +
          festive.bursts * festive.sparksPerBurst +
          glassWeatherBudget(kind, compact, true);
        expect(total).toBeLessThanOrEqual(compact ? 56 : 132);
      }
    }
  });

  it("does not advance effects with zero elapsed time and bounds delayed frames", () => {
    const scene = createGlassWeather("storm", 390, 844, true, false, random);
    const serialized = JSON.stringify(scene);
    advanceGlassWeather(scene, 0, random);
    expect(JSON.stringify(scene)).toBe(serialized);
    advanceGlassWeather(scene, 60, random);
    expect(scene.time).toBe(0.08);
  });
});
