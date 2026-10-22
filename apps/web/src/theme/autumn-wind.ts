export type LeafFlightPhase = "sweep" | "glide" | "loop" | "exit";
interface Point {
  x: number;
  y: number;
}

interface LeafCurve {
  from: Point;
  first: Point;
  second: Point;
  to: Point;
  duration: number;
  phase: LeafFlightPhase;
}

export interface WindLeaf {
  age: number;
  duration: number;
  curves: LeafCurve[];
  size: number;
  variant: number;
  depthPhase: number;
  depthRate: number;
  flutterPhase: number;
  flutterRate: number;
  spin: number;
}

export interface AutumnWindScene {
  width: number;
  height: number;
  compact: boolean;
  busy: boolean;
  time: number;
  nextArrival: number;
  maxLeaves: number;
  leaves: WindLeaf[];
}

export function createAutumnWind(
  width: number,
  height: number,
  compact: boolean,
  busy = false,
  random: () => number = Math.random,
): AutumnWindScene {
  return {
    width,
    height,
    compact,
    busy,
    time: 0,
    nextArrival: 0.7 + random() * 1.5,
    maxLeaves: compact || busy ? 1 : 2,
    leaves: [],
  };
}

function createLeaf(scene: AutumnWindScene, random: () => number): WindLeaf {
  const { width, height, compact } = scene;
  const direction = random() < 0.5 ? 1 : -1;
  const vertical = random() < 0.5 ? 1 : -1;
  const margin = compact ? 100 : 150;
  const entry = {
    x: direction > 0 ? -margin : width + margin,
    y: height * (0.25 + random() * 0.45),
  };
  const shoulder = {
    x: width * (direction > 0 ? 0.24 : 0.76),
    y: entry.y + (random() - 0.5) * height * 0.14,
  };
  const loopStart = {
    x: width * (direction > 0 ? 0.41 : 0.59),
    y: Math.max(
      height * 0.25,
      Math.min(height * 0.75, shoulder.y + (random() - 0.5) * height * 0.18),
    ),
  };
  const radiusX = width * (0.055 + random() * 0.05) * direction;
  const radiusY = height * (0.06 + random() * 0.07) * vertical;
  const curves: LeafCurve[] = [];
  const add = (
    from: Point,
    first: Point,
    second: Point,
    to: Point,
    duration: number,
    phase: LeafFlightPhase,
  ) => curves.push({ from, first, second, to, duration, phase });
  add(
    entry,
    { x: entry.x + direction * width * 0.16, y: entry.y - height * 0.05 },
    { x: shoulder.x - direction * width * 0.11, y: shoulder.y },
    shoulder,
    0.9 + random(),
    "sweep",
  );
  add(
    shoulder,
    { x: shoulder.x + direction * width * 0.1, y: shoulder.y },
    { x: loopStart.x, y: loopStart.y - radiusY * 0.45 },
    loopStart,
    2 + random() * 1.7,
    "glide",
  );
  const k = 0.55228475;
  const a = loopStart;
  const b = { x: a.x + radiusX, y: a.y + radiusY };
  const c = { x: a.x + radiusX * 2, y: a.y };
  const d = { x: a.x + radiusX, y: a.y - radiusY };
  const loops = random() < 0.3 ? 2 : 1;
  const quarter = 0.48 + random() * 0.26;
  for (let loop = 0; loop < loops; loop += 1) {
    add(
      a,
      { x: a.x, y: a.y + radiusY * k },
      { x: b.x - radiusX * k, y: b.y },
      b,
      quarter,
      "loop",
    );
    add(
      b,
      { x: b.x + radiusX * k, y: b.y },
      { x: c.x, y: c.y + radiusY * k },
      c,
      quarter,
      "loop",
    );
    add(
      c,
      { x: c.x, y: c.y - radiusY * k },
      { x: d.x + radiusX * k, y: d.y },
      d,
      quarter,
      "loop",
    );
    add(
      d,
      { x: d.x - radiusX * k, y: d.y },
      { x: a.x, y: a.y - radiusY * k },
      a,
      quarter,
      "loop",
    );
  }
  const departure = {
    x: width * (direction > 0 ? 0.7 : 0.3),
    y: Math.max(height * 0.1, Math.min(height * 0.9, a.y + radiusY * 0.6)),
  };
  const exit = {
    x: direction > 0 ? width + margin : -margin,
    y: departure.y + (random() - 0.5) * height * 0.22,
  };
  add(
    a,
    { x: a.x, y: a.y + radiusY * 0.45 },
    { x: departure.x - direction * width * 0.1, y: departure.y },
    departure,
    1.4 + random() * 1.3,
    "glide",
  );
  add(
    departure,
    { x: departure.x + direction * width * 0.12, y: departure.y },
    { x: exit.x - direction * width * 0.12, y: exit.y },
    exit,
    1 + random() * 1.1,
    "exit",
  );
  return {
    age: 0,
    duration: curves.reduce((sum, curve) => sum + curve.duration, 0),
    curves,
    size: compact ? 46 + random() * 26 : 66 + random() * 38,
    variant: Math.floor(random() * 3),
    depthPhase: random() * Math.PI * 2,
    depthRate: 0.5 + random() * 0.35,
    flutterPhase: random() * Math.PI * 2,
    flutterRate: 1.4 + random() * 1.2,
    spin: (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.7),
  };
}

export function advanceAutumnWind(
  scene: AutumnWindScene,
  elapsed: number,
  random: () => number = Math.random,
) {
  const delta = Math.max(0, Math.min(0.08, elapsed));
  if (!delta) return;
  scene.time += delta;
  for (let index = scene.leaves.length - 1; index >= 0; index -= 1) {
    scene.leaves[index].age += delta;
    if (scene.leaves[index].age >= scene.leaves[index].duration)
      scene.leaves.splice(index, 1);
  }
  if (scene.time >= scene.nextArrival) {
    if (scene.leaves.length < scene.maxLeaves) {
      scene.leaves.push(createLeaf(scene, random));
      scene.nextArrival =
        scene.time + (scene.compact || scene.busy ? 11 : 8) + random() * 10;
    } else scene.nextArrival = scene.time + 2 + random() * 4;
  }
}

export function windLeafAppearance(leaf: WindLeaf) {
  let age = Math.max(0, Math.min(leaf.duration, leaf.age));
  let curve = leaf.curves[leaf.curves.length - 1];
  for (const segment of leaf.curves) {
    curve = segment;
    if (age <= segment.duration) break;
    age -= segment.duration;
  }
  const t = Math.max(0, Math.min(1, age / curve.duration));
  const u = 1 - t;
  const x =
    u ** 3 * curve.from.x +
    3 * u * u * t * curve.first.x +
    3 * u * t * t * curve.second.x +
    t ** 3 * curve.to.x;
  const y =
    u ** 3 * curve.from.y +
    3 * u * u * t * curve.first.y +
    3 * u * t * t * curve.second.y +
    t ** 3 * curve.to.y;
  const dx =
    3 * u * u * (curve.first.x - curve.from.x) +
    6 * u * t * (curve.second.x - curve.first.x) +
    3 * t * t * (curve.to.x - curve.second.x);
  const dy =
    3 * u * u * (curve.first.y - curve.from.y) +
    6 * u * t * (curve.second.y - curve.first.y) +
    3 * t * t * (curve.to.y - curve.second.y);
  const depth =
    0.5 + Math.sin(leaf.age * leaf.depthRate + leaf.depthPhase) * 0.42;
  const fade =
    Math.min(1, leaf.age / 0.4) *
    Math.max(0, Math.min(1, (leaf.duration - leaf.age) / 0.35));
  return {
    x,
    y,
    phase: curve.phase,
    depth,
    size: leaf.size * (0.5 + depth * 1.7),
    blurLevel: (1 - depth) * 3,
    opacity: fade * (0.13 + depth * 0.37),
    rotation:
      (dy / Math.max(1, Math.hypot(dx, dy))) * 0.35 +
      leaf.age * leaf.spin +
      Math.sin(leaf.age * 1.9 + leaf.flutterPhase) * 0.5,
    foreshortening:
      0.22 +
      Math.abs(Math.cos(leaf.age * leaf.flutterRate + leaf.flutterPhase)) *
        0.78,
    tilt: 0.84 + Math.cos(leaf.age * 0.8 + leaf.flutterPhase) * 0.16,
  };
}
