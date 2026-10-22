import {
  advanceRainMotion,
  createRainMotion,
  rainBeadsTouch,
  recordRainTrail,
  type RainMotion,
} from "./rain-motion";
import {
  advanceStormSurge,
  createStormSurge,
  type StormSurge,
} from "./storm-surge";

export type GlassWeatherKind = "rain" | "storm" | "snow";

export const STORM_IMPACT_ANGLE = -0.58;
export const STORM_SPLASH_COUNT = 3;
export const RAIN_SPLASH_COUNT = 2;

export interface GlassSplashDroplet {
  angle: number;
  distance: number;
  radius: number;
  offset: number;
  delay: number;
  duration: number;
  shape: number;
}

export interface GlassDroplet {
  x: number;
  y: number;
  originX: number;
  originY: number;
  radius: number;
  impactRadius: number;
  age: number;
  impactDuration: number;
  holdDuration: number;
  slideDuration: number;
  shape: number;
  tilt: number;
  aspect: number;
  stationary: boolean;
  impactDistance: number;
  splashlets: GlassSplashDroplet[];
  motion: RainMotion | null;
}

export interface GlassSnowflake {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  radius: number;
  age: number;
  flightDuration: number;
  holdDuration: number;
  meltDuration: number;
  approachDistance: number;
  drift: number;
}

export interface GlassWeatherScene {
  kind: GlassWeatherKind;
  width: number;
  height: number;
  droplets: GlassDroplet[];
  flakes: GlassSnowflake[];
  frost: number;
  rainHaze: number;
  time: number;
  nextLightning: number;
  lightningAge: number;
  lightningX: number;
  lightningY: number;
  stormSurge: StormSurge | null;
}

export function glassWeatherBudget(
  kind: GlassWeatherKind,
  compact: boolean,
  festive = false,
): number {
  if (kind === "snow") return compact ? 8 : festive ? 18 : 20;
  // Each storm impact owns three small splash beads, including on holiday scenes.
  if (kind === "storm") return compact ? (festive ? 2 : 28) : festive ? 5 : 72;
  return compact ? (festive ? 6 : 12) : festive ? 14 : 28;
}

function createDroplet(
  scene: Pick<GlassWeatherScene, "width" | "height" | "kind" | "stormSurge">,
  random: () => number,
  stationary: boolean,
): GlassDroplet {
  const storm = scene.kind === "storm";
  const intensity = scene.stormSurge?.intensity ?? 1;
  const x = scene.width * (0.025 + random() * 0.95);
  const y = scene.height * (0.04 + random() * 0.8);
  const radius =
    (4 + random() * (storm ? 7 : 9)) * (storm ? 0.85 + intensity * 0.25 : 1);
  return {
    x,
    y,
    originX: x,
    originY: y,
    radius,
    impactRadius: radius,
    age: 0,
    impactDuration: storm
      ? (0.09 + random() * 0.09) * (0.85 + (1 - intensity) * 0.75)
      : 0.6,
    holdDuration: storm ? 0.04 + random() * 0.08 : 2.5 + random() * 5,
    // Storm uses this final interval only to evaporate the impact, never to slide.
    slideDuration: storm
      ? (0.45 + random() * 0.35) * (1.2 - intensity * 0.4)
      : stationary
        ? 5 + random() * 6
        : 18 + random() * 14,
    shape: Math.floor(random() * 6),
    tilt: storm
      ? STORM_IMPACT_ANGLE + (random() - 0.5) * 0.14
      : (random() - 0.5) * 0.8,
    aspect: 0.8 + random() * 0.55,
    stationary: storm || stationary,
    impactDistance: storm
      ? (140 + random() * 160) * (0.8 + intensity * 0.5)
      : 0,
    splashlets:
      storm || random() < 0.35
        ? Array.from(
            { length: storm ? STORM_SPLASH_COUNT : RAIN_SPLASH_COUNT },
            () => {
              const splashRadius = storm
                ? 0.7 + random() * 1.5
                : Math.min(radius * 0.6, 2.4 + random() * 1.8);
              return {
                angle: random() * Math.PI * 2,
                distance: storm
                  ? (7 + random() * (radius * 3.5)) * (0.8 + intensity * 0.5)
                  : radius * (0.7 + random() * 1.1),
                radius: splashRadius,
                offset: storm
                  ? 0
                  : radius * (1.35 + random() * 0.35) + splashRadius * 1.25,
                delay: storm ? random() * 0.025 : 0.03 + random() * 0.07,
                duration: storm ? 0.18 + random() * 0.22 : 1.1 + random() * 0.9,
                shape: Math.floor(random() * 6),
              };
            },
          )
        : [],
    motion: storm ? null : createRainMotion(x, y, radius, random),
  };
}

function createSnowflake(
  scene: Pick<GlassWeatherScene, "width" | "height">,
  random: () => number,
): GlassSnowflake {
  let x = scene.width * (0.02 + random() * 0.96);
  // Most adhered crystals sit near the rim, keeping the reading area quiet.
  if (random() < 0.6)
    x =
      random() < 0.5
        ? scene.width * random() * 0.14
        : scene.width * (0.86 + random() * 0.14);
  const y = scene.height * (0.08 + random() * 0.8);
  const approachDistance = 45 + random() * Math.min(220, scene.height * 0.3);
  return {
    x,
    y: y - approachDistance,
    targetX: x,
    targetY: y,
    radius: 2.5 + random() * 4.5,
    age: 0,
    flightDuration: 2.4 + random() * 4,
    holdDuration: 8 + random() * 13,
    meltDuration: 4 + random() * 5,
    approachDistance,
    drift: -12 + random() * 24,
  };
}

export function dropletLifetime(drop: GlassDroplet): number {
  return drop.impactDuration + drop.holdDuration + drop.slideDuration;
}

export function dropletAppearance(drop: GlassDroplet) {
  if (drop.impactDistance > 0) {
    const contactAge = Math.max(0, drop.age - drop.impactDuration);
    const fade = Math.max(
      0,
      Math.min(1, (contactAge - drop.holdDuration) / drop.slideDuration),
    );
    // Settle the impact shape, then evaporate through opacity alone.
    const deformationAge = Math.min(contactAge, drop.holdDuration);
    const deformation =
      Math.sin(deformationAge * 24) * Math.exp(-deformationAge * 10);
    return {
      phase:
        drop.age < drop.impactDuration
          ? "impact"
          : fade > 0
            ? "fading"
            : "bead",
      opacity:
        Math.max(0, Math.min(1, drop.age / 0.025)) *
        (1 - fade * fade * (3 - 2 * fade)),
      scaleX: 0.28 + deformation * 0.1,
      scaleY:
        (drop.age < drop.impactDuration ? 3.2 : 2.6 + deformation * 0.9) *
        drop.aspect,
      rotation:
        drop.tilt +
        Math.sin(contactAge * 21 + drop.shape) *
          Math.exp(-contactAge * 9) *
          0.025,
      trailLength: 0,
      trailWidth: 0,
      trailAngle: drop.tilt,
    };
  }
  const slideStart = drop.impactDuration + drop.holdDuration;
  const slideAge = Math.max(0, drop.age - slideStart);
  const fadeDelay = drop.stationary ? 0 : drop.slideDuration * 0.55;
  const evaporation = Math.max(
    0,
    Math.min(1, (slideAge - fadeDelay) / (drop.slideDuration - fadeDelay)),
  );
  const fadeStart = slideStart + fadeDelay;
  const phase =
    drop.age < drop.impactDuration
      ? "impact"
      : drop.age < slideStart
        ? "bead"
        : !drop.stationary && drop.age < fadeStart
          ? "sliding"
          : "fading";
  const impactProgress = Math.min(1, drop.age / drop.impactDuration);
  // A brief damped squash settles into the bead's own irregular silhouette.
  const squash =
    Math.sin(impactProgress * Math.PI * 2) *
    Math.pow(1 - impactProgress, 2) *
    0.22;
  const sliding = drop.stationary
    ? 0
    : Math.min(1, (drop.motion?.speed ?? 0) / 140);
  const windAngle = -Math.atan2(
    drop.motion?.velocityX ?? 0,
    drop.motion?.velocityY || 1,
  );
  const wobble = Math.sin(slideAge * 13 + drop.shape * 1.7) * sliding * 0.035;
  const scaleX = 1 + squash - sliding * 0.15 + wobble;
  return {
    phase,
    opacity:
      Math.min(1, drop.age / 0.16) *
      (1 - evaporation * evaporation * (3 - 2 * evaporation)),
    scaleX,
    scaleY: drop.aspect * (1 - squash + sliding * 0.55 - wobble),
    rotation:
      drop.tilt * (1 - sliding * 0.7) + windAngle * sliding + wobble * 0.7,
    trailLength: drop.stationary ? 0 : (drop.motion?.trailDistance ?? 0),
    trailAngle: windAngle,
    trailWidth: drop.stationary ? 0 : drop.radius * 1.6 * scaleX,
  };
}

/** Splash beads scatter from an impact and evaporate without shrinking. */
export function splashDropletAppearance(
  drop: GlassDroplet,
  splash: GlassSplashDroplet,
) {
  const storm = drop.impactDistance > 0;
  const age = drop.age - (storm ? drop.impactDuration : 0) - splash.delay;
  if (age < 0 || age >= splash.duration) return null;
  const progress = age / splash.duration;
  const travel = (1 - Math.exp(-age * (storm ? 22 : 6))) * splash.distance;
  const ringX = Math.cos(splash.angle) * splash.offset;
  const ringY = Math.sin(splash.angle) * splash.offset * drop.aspect;
  return {
    x:
      drop.originX +
      ringX * Math.cos(drop.tilt) -
      ringY * Math.sin(drop.tilt) +
      Math.cos(splash.angle) * travel -
      Math.sin(drop.tilt) * travel * (storm ? 0.25 : 0.06),
    y:
      drop.originY +
      ringX * Math.sin(drop.tilt) +
      ringY * Math.cos(drop.tilt) +
      Math.sin(splash.angle) * travel * 0.75 +
      age * age * (storm ? 12 : 1.3),
    opacity: Math.min(1, age / (storm ? 0.018 : 0.12)) * (1 - progress) ** 1.4,
    radius: splash.radius,
    rotation: storm ? splash.angle - Math.PI / 2 : drop.tilt * 0.2,
  };
}

export function snowflakeAppearance(flake: GlassSnowflake) {
  const meltStart = flake.flightDuration + flake.holdDuration;
  return {
    phase:
      flake.age < flake.flightDuration
        ? "flight"
        : flake.age < meltStart
          ? "stuck"
          : "melting",
    opacity:
      flake.age < flake.flightDuration
        ? 0.35
        : Math.max(
            0,
            1 - Math.max(0, flake.age - meltStart) / flake.meltDuration,
          ) * 0.68,
  };
}

export function createGlassWeather(
  kind: GlassWeatherKind,
  width: number,
  height: number,
  compact: boolean,
  festive = false,
  random: () => number = Math.random,
): GlassWeatherScene {
  const scene: GlassWeatherScene = {
    kind,
    width,
    height,
    droplets: [],
    flakes: [],
    frost: kind === "snow" ? 0.16 : 0,
    rainHaze: 0,
    time: 0,
    nextLightning: 5 + random() * 5,
    lightningAge: -1,
    lightningX: width * 0.75,
    lightningY: height * 0.22,
    stormSurge: kind === "storm" ? createStormSurge(random) : null,
  };
  const budget = glassWeatherBudget(kind, compact, festive);
  if (kind === "snow") {
    scene.flakes = Array.from({ length: budget }, () => {
      const flake = createSnowflake(scene, random);
      flake.age = random() * (flake.flightDuration + flake.holdDuration);
      return flake;
    });
  } else {
    scene.droplets = Array.from({ length: budget }, (_, index) => {
      const drop = createDroplet(scene, random, index % 2 === 0);
      drop.age =
        random() *
        (kind === "storm"
          ? dropletLifetime(drop)
          : drop.impactDuration + drop.holdDuration);
      if (
        kind === "storm" &&
        index >= stormActiveSlots(budget, scene.stormSurge)
      )
        drop.age = -0.01 - random() * 0.12;
      return drop;
    });
  }
  advanceGlassWeather(scene, 0, random);
  return scene;
}

function stormActiveSlots(budget: number, surge: StormSurge | null) {
  return Math.ceil(budget * (0.12 + (surge?.intensity ?? 1) * 0.88));
}

function mergeRainDroplets(scene: GlassWeatherScene, random: () => number) {
  for (let i = 0; i < scene.droplets.length; i += 1) {
    const a = scene.droplets[i];
    if (
      !a.motion ||
      a.motion.cooldown > 0 ||
      a.age < a.impactDuration ||
      dropletAppearance(a).opacity < 0.15
    )
      continue;
    for (let j = i + 1; j < scene.droplets.length; j += 1) {
      const b = scene.droplets[j];
      if (
        !b.motion ||
        b.motion.cooldown > 0 ||
        b.age < b.impactDuration ||
        dropletAppearance(b).opacity < 0.15
      )
        continue;
      const aMoving = !a.stationary && a.motion.speed > 3;
      const bMoving = !b.stationary && b.motion.speed > 3;
      if ((!aMoving && !bMoving) || !rainBeadsTouch(a, b)) continue;
      const absorber = !aMoving
        ? b
        : !bMoving
          ? a
          : a.motion.mass >= b.motion.mass
            ? a
            : b;
      const donor = absorber === a ? b : a;
      const motion = absorber.motion,
        donorMotion = donor.motion;
      if (!motion || !donorMotion) continue;
      const totalMass = motion.mass + donorMotion.mass;
      absorber.x =
        (absorber.x * motion.mass + donor.x * donorMotion.mass) / totalMass;
      absorber.y =
        (absorber.y * motion.mass + donor.y * donorMotion.mass) / totalMass;
      motion.mass = Math.min(22 * 22, totalMass);
      motion.speed = Math.max(motion.speed, donorMotion.speed) * 1.12;
      motion.fast = true;
      motion.remaining = 0.18 + random() * 0.22;
      motion.targetSpeed = Math.max(140, motion.targetSpeed);
      motion.cooldown = 0.7;
      absorber.slideDuration = Math.min(40, absorber.slideDuration + 2);
      recordRainTrail(motion, absorber.x, absorber.y);
      scene.droplets[donor === a ? i : j] = createDroplet(
        scene,
        random,
        donor.stationary,
      );
      break;
    }
  }
}

export function advanceGlassWeather(
  scene: GlassWeatherScene,
  elapsed: number,
  random: () => number = Math.random,
): void {
  const delta = Math.max(0, Math.min(elapsed, 0.08));
  scene.time += delta;
  if (scene.kind === "rain" && delta > 0) {
    // Humidity builds across the whole glass, independently of individual impacts.
    const humidity = 0.62 + Math.sin(scene.time / 18) * 0.1;
    scene.rainHaze += (humidity - scene.rainHaze) * (1 - Math.exp(-delta / 10));
  }
  if (scene.stormSurge) advanceStormSurge(scene.stormSurge, delta, random);
  const activeSlots =
    scene.kind === "storm"
      ? stormActiveSlots(scene.droplets.length, scene.stormSurge)
      : scene.droplets.length;
  for (let index = 0; index < scene.droplets.length; index += 1) {
    let drop = scene.droplets[index];
    if (scene.kind === "storm" && drop.age < 0) {
      if (delta <= 0 || index >= activeSlots) continue;
      const age = drop.age + delta;
      if (age < 0) {
        drop.age = age;
        continue;
      }
      // Birth uses the current gust strength; parked slots never retain a stale force.
      drop = createDroplet(scene, random, drop.stationary);
      drop.age = age;
      scene.droplets[index] = drop;
    } else drop.age += delta;
    const slideAge = Math.max(
      0,
      drop.age - drop.impactDuration - drop.holdDuration,
    );
    if (drop.motion && delta > 0) {
      const motion = drop.motion;
      motion.previousX = drop.x;
      motion.previousY = drop.y;
      motion.cooldown = Math.max(0, motion.cooldown - delta);
      drop.radius +=
        (Math.sqrt(motion.mass) - drop.radius) * (1 - Math.exp(-delta * 10));
      if (!drop.stationary && slideAge > 0) {
        const movement = advanceRainMotion(
          motion,
          drop.radius,
          Math.min(delta, slideAge),
          random,
        );
        drop.x += movement.dx;
        drop.y += movement.dy;
        recordRainTrail(motion, drop.x, drop.y);
      }
    }
    // All storm arrivals share the wind direction. After impact they stay put.
    if (drop.impactDistance > 0) {
      drop.x = drop.originX;
      drop.y = drop.originY;
    }
    if (drop.age < drop.impactDuration && drop.impactDistance > 0) {
      const distance =
        drop.impactDistance * (1 - drop.age / drop.impactDuration) ** 2;
      drop.x = drop.originX + Math.sin(drop.tilt) * distance;
      drop.y = drop.originY - Math.cos(drop.tilt) * distance;
    }
    const offscreenMargin = drop.motion ? 320 : drop.impactDistance + 40;
    if (
      drop.age > dropletLifetime(drop) ||
      drop.y > scene.height + offscreenMargin ||
      drop.x < -offscreenMargin ||
      drop.x > scene.width + offscreenMargin
    ) {
      if (scene.kind === "storm") drop.age = -0.01 - random() * 0.12;
      else
        scene.droplets[index] = createDroplet(scene, random, drop.stationary);
    }
  }
  if (scene.kind === "rain" && delta > 0) mergeRainDroplets(scene, random);
  for (let index = 0; index < scene.flakes.length; index += 1) {
    const flake = scene.flakes[index];
    const previousAge = flake.age;
    flake.age += delta;
    const progress = Math.min(1, flake.age / flake.flightDuration);
    flake.x = flake.targetX + (1 - progress) * flake.drift;
    flake.y = flake.targetY - (1 - progress) * flake.approachDistance;
    if (previousAge < flake.flightDuration && flake.age >= flake.flightDuration)
      scene.frost = Math.min(0.58, scene.frost + 0.012);
    if (
      flake.age >
      flake.flightDuration + flake.holdDuration + flake.meltDuration
    )
      scene.flakes[index] = createSnowflake(scene, random);
  }
  if (scene.kind === "snow")
    scene.frost = Math.min(0.58, Math.max(0.16, scene.frost - delta * 0.0009));
  if (scene.kind === "storm") {
    if (scene.lightningAge >= 0) scene.lightningAge += delta;
    if (scene.time >= scene.nextLightning) {
      scene.lightningAge = 0;
      scene.lightningX = scene.width * (0.15 + random() * 0.7);
      scene.lightningY = scene.height * (0.04 + random() * 0.34);
      scene.nextLightning = scene.time + 7 + random() * 11;
    }
  }
}

const smoothStep = (value: number) => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
};

/** An isolated, stronger flash with one bright crest and a smooth afterglow. */
export function lightningOpacity(scene: GlassWeatherScene): number {
  if (
    scene.kind !== "storm" ||
    scene.lightningAge < 0 ||
    scene.lightningAge > 1.1
  )
    return 0;
  return (
    smoothStep(scene.lightningAge / 0.08) *
    (1 - smoothStep((scene.lightningAge - 0.16) / 0.94)) *
    0.72
  );
}
