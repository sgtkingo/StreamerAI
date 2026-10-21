export type GlassWeatherKind = "rain" | "storm" | "snow";

export interface GlassDroplet {
  x: number;
  y: number;
  originX: number;
  originY: number;
  radius: number;
  age: number;
  impactDuration: number;
  holdDuration: number;
  slideDuration: number;
  slideSpeed: number;
  drift: number;
  shape: number;
  tilt: number;
  aspect: number;
  stationary: boolean;
  condensation: boolean;
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
  time: number;
  nextLightning: number;
  lightningAge: number;
  lightningX: number;
  lightningY: number;
}

export function glassWeatherBudget(
  kind: GlassWeatherKind,
  compact: boolean,
  festive = false,
): number {
  if (kind === "snow") return compact ? 8 : festive ? 18 : 20;
  if (kind === "storm") return compact ? (festive ? 8 : 14) : festive ? 20 : 36;
  return compact ? (festive ? 6 : 12) : festive ? 14 : 28;
}

function createDroplet(
  scene: Pick<GlassWeatherScene, "width" | "height" | "kind">,
  random: () => number,
  stationary: boolean,
): GlassDroplet {
  const storm = scene.kind === "storm";
  const x = scene.width * (0.025 + random() * 0.95);
  const y = scene.height * (0.04 + random() * 0.8);
  return {
    x,
    y,
    originX: x,
    originY: y,
    radius: (storm ? 5 : 4) + random() * (storm ? 11 : 9),
    age: 0,
    impactDuration: storm ? 0.38 : 0.6,
    holdDuration: (storm ? 0.8 : 2.5) + random() * (storm ? 2 : 5),
    slideDuration: 3 + random() * 5,
    slideSpeed: (storm ? 11 : 4) + random() * (storm ? 18 : 10),
    drift: -0.5 + random(),
    shape: Math.floor(random() * 6),
    tilt: (random() - 0.5) * 0.8,
    aspect: 0.8 + random() * 0.55,
    stationary,
    condensation: random() < 0.35,
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
  const slideStart = drop.impactDuration + drop.holdDuration;
  const slideAge = Math.max(0, drop.age - slideStart);
  const evaporation = Math.min(1, slideAge / drop.slideDuration);
  const fadeStart = slideStart + drop.slideDuration * 0.6;
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
  const sliding = drop.stationary ? 0 : Math.min(1, slideAge / 0.8);
  const wobble = Math.sin(slideAge * 2.4 + drop.shape * 1.7) * sliding * 0.045;
  const shrink = 1 - evaporation * 0.45;
  const scaleX = (1 + squash - sliding * 0.12 + wobble) * shrink;
  return {
    phase,
    opacity:
      Math.min(1, drop.age / 0.16) *
      (1 - evaporation * evaporation * (3 - 2 * evaporation)),
    scaleX,
    scaleY: drop.aspect * (1 - squash + sliding * 0.32 - wobble) * shrink,
    rotation: drop.tilt * (1 - sliding * 0.65) + wobble * 0.7,
    // Condensation stays at the impact site rather than spreading as a wave.
    condensationOpacity:
      Number(drop.condensation) *
      Math.min(1, drop.age / 0.45) *
      Math.max(0, 1 - Math.max(0, drop.age - slideStart * 0.7) / 5) *
      (1 - evaporation),
    trailLength: drop.stationary
      ? 0
      : Math.min(105, Math.max(0, drop.y - drop.originY)),
    trailWidth: drop.stationary ? 0 : drop.radius * 1.6 * scaleX,
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
    time: 0,
    nextLightning: 5 + random() * 5,
    lightningAge: -1,
    lightningX: width * 0.75,
    lightningY: height * 0.22,
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
      drop.age = random() * (drop.impactDuration + drop.holdDuration);
      return drop;
    });
  }
  advanceGlassWeather(scene, 0, random);
  return scene;
}

export function advanceGlassWeather(
  scene: GlassWeatherScene,
  elapsed: number,
  random: () => number = Math.random,
): void {
  const delta = Math.max(0, Math.min(elapsed, 0.08));
  scene.time += delta;
  for (let index = 0; index < scene.droplets.length; index += 1) {
    const drop = scene.droplets[index];
    drop.age += delta;
    const slideAge = Math.max(
      0,
      drop.age - drop.impactDuration - drop.holdDuration,
    );
    // Keep moving through evaporation. Recycled slots retain their behavior,
    // keeping exactly half of the droplets stationary.
    drop.y = drop.originY + (drop.stationary ? 0 : slideAge * drop.slideSpeed);
    drop.x = drop.originX + (drop.stationary ? 0 : slideAge * drop.drift);
    if (drop.age > dropletLifetime(drop) || drop.y > scene.height + 25)
      scene.droplets[index] = createDroplet(scene, random, drop.stationary);
  }
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

/** One slow diffuse illumination, separated by at least seven seconds. */
export function lightningOpacity(scene: GlassWeatherScene): number {
  if (
    scene.kind !== "storm" ||
    scene.lightningAge < 0 ||
    scene.lightningAge > 1.5
  )
    return 0;
  return (
    smoothStep(scene.lightningAge / 0.35) *
    (1 - smoothStep((scene.lightningAge - 0.45) / 1.05)) *
    0.22
  );
}
