import { describe, expect, it } from "vitest";
import {
  advanceGlassWeather,
  createGlassWeather,
  dropletAppearance,
  dropletLifetime,
  glassWeatherBudget,
  lightningOpacity,
  snowflakeAppearance,
  STORM_IMPACT_ANGLE,
  STORM_SPLASH_COUNT,
  RAIN_SPLASH_COUNT,
  splashDropletAppearance,
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
    drop.age = dropletLifetime(drop);
    expect(dropletAppearance(drop).opacity).toBe(0);
  });

  it("keeps half the beads stationary without trails and splashes only selected impacts", () => {
    let seed = 42;
    const seededRandom = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (const kind of ["rain"] as const) {
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
      expect(scene.droplets.some((drop) => drop.splashlets.length > 0)).toBe(
        true,
      );
      expect(scene.droplets.some((drop) => drop.splashlets.length === 0)).toBe(
        true,
      );
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
      }
      for (let step = 0; step < 600; step += 1)
        advanceGlassWeather(scene, 0.08, seededRandom);
      expect(scene.droplets.filter((drop) => drop.stationary)).toHaveLength(
        scene.droplets.length / 2,
      );
    }
  });

  it("makes selected rain splashes larger, gentler and longer-lived than storm spray", () => {
    const rain = createGlassWeather(
      "rain",
      1440,
      900,
      false,
      false,
      () => 0.25,
    );
    const storm = createGlassWeather(
      "storm",
      1440,
      900,
      false,
      false,
      () => 0.25,
    );
    const rainDrop = rain.droplets[0];
    const stormDrop = storm.droplets[0];
    expect(rainDrop.splashlets).toHaveLength(RAIN_SPLASH_COUNT);
    const rainSplash = rainDrop.splashlets[0];
    const stormSplash = stormDrop.splashlets[0];
    rainDrop.age = rainSplash.delay + 0.02;
    stormDrop.age = stormDrop.impactDuration + stormSplash.delay + 0.02;
    const rainStart = splashDropletAppearance(rainDrop, rainSplash);
    const stormStart = splashDropletAppearance(stormDrop, stormSplash);
    if (!rainStart || !stormStart)
      throw new Error("Both splashes should have started");
    expect(
      Math.hypot(
        rainStart.x - rainDrop.originX,
        rainStart.y - rainDrop.originY,
      ),
    ).toBeGreaterThan(rainDrop.impactRadius + rainStart.radius);
    rainDrop.age = rainSplash.delay + 0.12;
    stormDrop.age = stormDrop.impactDuration + stormSplash.delay + 0.12;
    const rainLook = splashDropletAppearance(rainDrop, rainSplash);
    const stormLook = splashDropletAppearance(stormDrop, stormSplash);
    if (!rainLook || !stormLook)
      throw new Error("Both splashes should be visible after impact");
    expect(rainLook.radius).toBeGreaterThan(stormLook.radius);
    expect(
      Math.hypot(rainLook.x - rainStart.x, rainLook.y - rainStart.y),
    ).toBeLessThan(
      Math.hypot(stormLook.x - stormStart.x, stormLook.y - stormStart.y),
    );
    rainDrop.age = rainSplash.delay + stormSplash.duration + 0.1;
    stormDrop.age =
      stormDrop.impactDuration + stormSplash.delay + stormSplash.duration + 0.1;
    expect(
      splashDropletAppearance(rainDrop, rainSplash)?.opacity,
    ).toBeGreaterThan(0);
    expect(splashDropletAppearance(rainDrop, rainSplash)?.radius).toBe(
      rainLook.radius,
    );
    expect(splashDropletAppearance(stormDrop, stormSplash)).toBeNull();
    rainDrop.age = rainSplash.delay + rainSplash.duration + 0.001;
    expect(splashDropletAppearance(rainDrop, rainSplash)).toBeNull();
  });

  it("gradually fogs the whole rainy glass independently of individual impacts", () => {
    const scene = createGlassWeather(
      "rain",
      1440,
      900,
      false,
      false,
      () => 0.25,
    );
    const empty = createGlassWeather("rain", 1440, 900, false, false, random);
    const storm = createGlassWeather("storm", 1440, 900, false, false, random);
    empty.droplets = [];
    expect(scene.rainHaze).toBe(0);
    advanceGlassWeather(scene, 0.08, random);
    advanceGlassWeather(empty, 0.08, random);
    expect(scene.rainHaze).toBeLessThan(0.01);
    for (let step = 0; step < 124; step += 1) {
      advanceGlassWeather(scene, 0.08, random);
      advanceGlassWeather(empty, 0.08, random);
      advanceGlassWeather(storm, 0.08, random);
    }
    expect(scene.rainHaze).toBeGreaterThan(0.3);
    expect(scene.rainHaze).toBeLessThan(0.6);
    expect(empty.rainHaze).toBe(scene.rainHaze);
    expect(storm.rainHaze).toBe(0);
    const beforePause = scene.rainHaze;
    advanceGlassWeather(scene, 0, random);
    expect(scene.rainHaze).toBe(beforePause);
    for (let step = 0; step < 125; step += 1)
      advanceGlassWeather(scene, 0.08, random);
    expect(scene.rainHaze).toBeGreaterThan(beforePause);
    expect(scene.rainHaze).toBeLessThan(0.8);
  });

  it("travels hundreds of pixels with abrupt slips, brakes and bends before evaporating", () => {
    let seed = 37;
    const seededRandom = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const scene = createGlassWeather(
      "rain",
      1440,
      5000,
      false,
      false,
      seededRandom,
    );
    const drop = scene.droplets[1];
    const motion = drop.motion;
    if (!motion) throw new Error("Rain needs surface motion");
    scene.droplets = [drop];
    drop.x = drop.originX = 700;
    drop.y = drop.originY = 100;
    drop.age = drop.impactDuration + drop.holdDuration;
    const speeds: number[] = [];
    const turns: number[] = [];
    for (let frame = 0; frame < 300; frame += 1) {
      const previousY = drop.y;
      advanceGlassWeather(scene, 0.04, seededRandom);
      speeds.push(motion.speed);
      turns.push(Math.abs(motion.turn));
      expect(drop.y).toBeGreaterThanOrEqual(previousY);
    }
    expect(drop.y - drop.originY).toBeGreaterThan(300);
    expect(Math.max(...speeds)).toBeGreaterThan(100);
    expect(Math.min(...speeds.slice(20))).toBeLessThan(12);
    expect(
      speeds.some(
        (speed, index) => index > 0 && Math.abs(speed - speeds[index - 1]) > 40,
      ),
    ).toBe(true);
    expect(Math.max(...turns)).toBeGreaterThan(0.2);
    expect(motion.trail.length).toBeLessThanOrEqual(64);
    expect(motion.trailDistance).toBeLessThanOrEqual(280);
    expect(dropletAppearance(drop).opacity).toBeGreaterThan(0.5);
    const frozen = JSON.stringify(drop);
    advanceGlassWeather(scene, 0, seededRandom);
    expect(JSON.stringify(drop)).toBe(frozen);
  });

  it("merges beads crossed during a fast slip without growing the particle pool", () => {
    const scene = createGlassWeather("rain", 1440, 900, false, false, random);
    const target = scene.droplets[0];
    const drop = scene.droplets[1];
    const motion = drop.motion,
      targetMotion = target.motion;
    if (!motion || !targetMotion) throw new Error("Rain needs surface motion");
    scene.droplets = [target, drop];
    target.radius = 6;
    targetMotion.mass = 36;
    targetMotion.cooldown = 0;
    target.x = target.originX = 250;
    target.y = target.originY = 116;
    drop.radius = 8;
    motion.mass = 64;
    motion.cooldown = 0;
    motion.speed = motion.targetSpeed = 400;
    motion.turn = motion.targetTurn = 0;
    motion.remaining = 0.5;
    drop.x = drop.originX = 250;
    drop.y = drop.originY = 100;
    drop.age = drop.impactDuration + drop.holdDuration + 0.1;
    target.age = target.impactDuration + 1;
    const impact = [drop.originX, drop.originY, drop.impactRadius];
    advanceGlassWeather(scene, 0.08, random);
    expect(scene.droplets).toHaveLength(2);
    expect(scene.droplets[0]).not.toBe(target);
    expect(scene.droplets[1]).toBe(drop);
    expect(scene.droplets[0].stationary).toBe(true);
    expect(motion.mass).toBe(100);
    expect(motion.cooldown).toBeGreaterThan(0);
    advanceGlassWeather(scene, 0.08, random);
    expect(drop.radius).toBeGreaterThan(8);
    expect(drop.radius).toBeLessThanOrEqual(10);
    expect([drop.originX, drop.originY, drop.impactRadius]).toEqual(impact);
  });

  it("hits the glass from a shared angle, deforms and splashes without sliding or tails", () => {
    let seed = 73;
    const seededRandom = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const storm = createGlassWeather(
      "storm",
      1440,
      900,
      false,
      false,
      seededRandom,
    );
    for (const bead of storm.droplets) {
      expect(Math.abs(bead.tilt - STORM_IMPACT_ANGLE)).toBeLessThan(0.08);
      expect(bead.splashlets).toHaveLength(STORM_SPLASH_COUNT);
    }
    const drop = storm.droplets[1];
    drop.originX = 500;
    drop.originY = 300;
    drop.age = drop.impactDuration * 0.25;
    advanceGlassWeather(storm, 0, random);
    expect(drop.x).toBeLessThan(drop.originX);
    expect(drop.y).toBeLessThan(drop.originY);
    expect(dropletAppearance(drop).trailLength).toBe(0);
    expect(
      drop.splashlets.every(
        (splash) => splashDropletAppearance(drop, splash) === null,
      ),
    ).toBe(true);

    drop.age = drop.impactDuration + 0.07;
    advanceGlassWeather(storm, 0, random);
    const contact = dropletAppearance(drop);
    expect([drop.x, drop.y]).toEqual([drop.originX, drop.originY]);
    expect(contact.scaleY / contact.scaleX).toBeGreaterThan(6);
    const fragments = drop.splashlets.map((splash) =>
      splashDropletAppearance(drop, splash),
    );
    expect(
      fragments.every(
        (fragment) =>
          fragment && fragment.opacity > 0 && fragment.radius < drop.radius,
      ),
    ).toBe(true);
    expect(
      new Set(fragments.map((fragment) => `${fragment?.x},${fragment?.y}`))
        .size,
    ).toBe(STORM_SPLASH_COUNT);
    advanceGlassWeather(storm, 0.08, random);
    expect([drop.x, drop.y]).toEqual([drop.originX, drop.originY]);
    expect(dropletAppearance(drop).trailLength).toBe(0);
    expect(dropletAppearance(drop).trailWidth).toBe(0);
    drop.age =
      drop.impactDuration + drop.holdDuration + drop.slideDuration * 0.25;
    const evaporating = dropletAppearance(drop);
    advanceGlassWeather(storm, 0.08, random);
    expect(dropletAppearance(drop).scaleX).toBe(evaporating.scaleX);
    expect(dropletAppearance(drop).scaleY).toBe(evaporating.scaleY);
    expect(dropletAppearance(drop).opacity).toBeLessThan(evaporating.opacity);
    drop.age = dropletLifetime(drop);
    expect(dropletAppearance(drop).opacity).toBe(0);
    expect(
      drop.splashlets.every(
        (splash) => splashDropletAppearance(drop, splash) === null,
      ),
    ).toBe(true);
    for (let step = 0; step < 600; step += 1)
      advanceGlassWeather(storm, 0.08, seededRandom);
    expect(storm.droplets).toHaveLength(glassWeatherBudget("storm", false));
    expect(
      storm.droplets.every(
        (bead) => bead.splashlets.length === STORM_SPLASH_COUNT,
      ),
    ).toBe(true);
  });

  it("surges abruptly with sustained randomized peaks while keeping the storm pool bounded", () => {
    let seed = 23;
    const seededRandom = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const scene = createGlassWeather(
      "storm",
      1440,
      900,
      false,
      false,
      seededRandom,
    );
    const surge = scene.stormSurge;
    if (!surge) throw new Error("Storm needs gust dynamics");
    const intensities: number[] = [];
    const active: number[] = [];
    const peakLengths: number[] = [];
    const peakLevels = new Set<number>();
    let peakAge = 0;
    for (let frame = 0; frame < 1000; frame += 1) {
      advanceGlassWeather(scene, 0.04, seededRandom);
      intensities.push(surge.intensity);
      active.push(scene.droplets.filter((drop) => drop.age >= 0).length);
      if (surge.phase === "peak") {
        peakAge += 0.04;
        peakLevels.add(Math.round(surge.high * 1000));
      } else if (peakAge > 0) {
        peakLengths.push(peakAge);
        peakAge = 0;
      }
      expect(scene.droplets).toHaveLength(glassWeatherBudget("storm", false));
    }
    expect(Math.max(...intensities)).toBeGreaterThan(0.9);
    expect(Math.min(...intensities)).toBeLessThan(0.45);
    expect(
      intensities.some(
        (value, index) => index > 0 && value - intensities[index - 1] > 0.15,
      ),
    ).toBe(true);
    expect(peakLengths.length).toBeGreaterThan(4);
    expect(
      peakLengths.every((length) => length >= 0.96 && length <= 2.04),
    ).toBe(true);
    expect(peakLevels.size).toBeGreaterThan(3);
    expect(Math.max(...active)).toBeGreaterThan(60);
    expect(Math.min(...active)).toBeLessThan(45);
    expect(
      scene.droplets.every(
        (drop) =>
          Number.isFinite(dropletAppearance(drop).opacity) &&
          dropletAppearance(drop).opacity >= 0,
      ),
    ).toBe(true);
    expect(createGlassWeather("rain", 1440, 900, false).stormSurge).toBeNull();
  });

  it("recycles droplets without growing the scene and makes storm visibly denser", () => {
    const rain = createGlassWeather("rain", 1440, 900, false, false, random);
    const storm = createGlassWeather("storm", 1440, 900, false, false, random);
    expect(storm.droplets.length).toBeGreaterThan(rain.droplets.length);
    expect(storm.droplets[0].impactDuration).toBeLessThan(
      rain.droplets[0].impactDuration,
    );
    expect(dropletLifetime(storm.droplets[0])).toBeLessThan(
      dropletLifetime(rain.droplets[0]),
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

  it("separates stronger storm flashes with a fast crest and smooth afterglow", () => {
    const scene = createGlassWeather("storm", 1440, 900, false, false, random);
    expect(lightningOpacity(scene)).toBe(0);
    scene.time = scene.nextLightning - 0.04;
    advanceGlassWeather(scene, 0.08, random);
    expect(scene.lightningAge).toBe(0);
    expect(scene.nextLightning - scene.time).toBeGreaterThanOrEqual(7);
    expect(lightningOpacity(scene)).toBe(0);
    scene.lightningAge = 0.03;
    const rising = lightningOpacity(scene);
    scene.lightningAge = 0.12;
    expect(lightningOpacity(scene)).toBeGreaterThan(rising);
    expect(lightningOpacity(scene)).toBeGreaterThan(0.6);
    expect(lightningOpacity(scene)).toBeLessThanOrEqual(0.72);
    scene.lightningAge = 0.95;
    expect(lightningOpacity(scene)).toBeLessThan(rising);
    scene.lightningAge = 1.2;
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
          glassWeatherBudget(kind, compact, true) *
            (kind === "storm"
              ? 1 + STORM_SPLASH_COUNT
              : kind === "rain"
                ? 1 + RAIN_SPLASH_COUNT
                : 1);
        expect(total).toBeLessThanOrEqual(compact ? 72 : 160);
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
