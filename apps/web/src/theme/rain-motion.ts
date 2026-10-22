export interface RainTrailPoint {
  x: number;
  y: number;
}

export interface RainMotion {
  previousX: number;
  previousY: number;
  speed: number;
  targetSpeed: number;
  turn: number;
  targetTurn: number;
  velocityX: number;
  velocityY: number;
  remaining: number;
  fast: boolean;
  mass: number;
  cooldown: number;
  trail: RainTrailPoint[];
  trailDistance: number;
  distance: number;
}

export function createRainMotion(
  x: number,
  y: number,
  radius: number,
  random: () => number,
): RainMotion {
  return {
    previousX: x,
    previousY: y,
    speed: 0,
    targetSpeed: 85 + random() * 170,
    turn: 0,
    targetTurn: (random() - 0.5) * 0.12,
    velocityX: 0,
    velocityY: 0,
    remaining: 0.18 + random() * 0.38,
    fast: true,
    mass: radius * radius,
    cooldown: 0.5,
    trail: [],
    trailDistance: 0,
    distance: 0,
  };
}

/** Adhesion alternates short slips with longer near-stops. */
export function advanceRainMotion(
  motion: RainMotion,
  radius: number,
  elapsed: number,
  random: () => number,
) {
  motion.remaining -= elapsed;
  if (motion.remaining <= 0) {
    motion.fast = !motion.fast;
    motion.remaining += motion.fast
      ? 0.18 + random() * 0.38
      : 0.4 + random() * 0.95;
    motion.targetSpeed = motion.fast ? 85 + random() * 170 : 1 + random() * 6;
    motion.targetTurn =
      motion.fast && random() < 0.25
        ? (random() < 0.5 ? -1 : 1) * (0.28 + random() * 0.3)
        : (random() - 0.5) * 0.12;
  }
  const response = 1 - Math.exp(-elapsed / (motion.fast ? 0.045 : 0.035));
  motion.speed +=
    (motion.targetSpeed * Math.sqrt(radius / 8) - motion.speed) * response;
  motion.turn +=
    (motion.targetTurn - motion.turn) * (1 - Math.exp(-elapsed / 0.065));
  motion.velocityX = Math.sin(motion.turn) * motion.speed;
  motion.velocityY = Math.cos(motion.turn) * motion.speed;
  const dx = motion.velocityX * elapsed;
  const dy = motion.velocityY * elapsed;
  motion.distance += Math.hypot(dx, dy);
  return { dx, dy };
}

/** A bounded history lets wet traces follow bends rather than the impact center. */
export function recordRainTrail(motion: RainMotion, x: number, y: number) {
  const last = motion.trail.at(-1);
  if (!last) {
    motion.trail.push({ x: motion.previousX, y: motion.previousY });
    recordRainTrail(motion, x, y);
    return;
  }
  const distance = Math.hypot(x - last.x, y - last.y);
  if (distance < 2) return;
  motion.trail.push({ x, y });
  motion.trailDistance += distance;
  while (
    motion.trail.length > 2 &&
    (motion.trail.length > 64 || motion.trailDistance > 280)
  ) {
    const a = motion.trail[0];
    const b = motion.trail[1];
    motion.trailDistance -= Math.hypot(b.x - a.x, b.y - a.y);
    motion.trail.shift();
  }
}

/** Sweep both centers so a fast slip cannot tunnel through a small bead. */
export function rainBeadsTouch(
  a: RainTrailPoint & { radius: number; motion: RainMotion | null },
  b: RainTrailPoint & { radius: number; motion: RainMotion | null },
) {
  const ma = a.motion,
    mb = b.motion;
  if (!ma || !mb) return false;
  const startX = ma.previousX - mb.previousX;
  const startY = ma.previousY - mb.previousY;
  const dx = a.x - ma.previousX - (b.x - mb.previousX);
  const dy = a.y - ma.previousY - (b.y - mb.previousY);
  const lengthSquared = dx * dx + dy * dy;
  const progress = lengthSquared
    ? Math.max(0, Math.min(1, -(startX * dx + startY * dy) / lengthSquared))
    : 0;
  return (
    Math.hypot(startX + dx * progress, startY + dy * progress) <
    (a.radius + b.radius) * 0.9
  );
}
