export interface WinterIce {
  age: number;
  frost: number;
  icicles: number;
  snow: number;
}

export function createWinterIce(): WinterIce {
  return { age: 0, frost: 0.18, icicles: 0, snow: 0 };
}

/** Cold persists across weather changes; only the shared ambient clock advances it. */
export function advanceWinterIce(
  ice: WinterIce,
  elapsed: number,
  snowing: boolean,
) {
  const delta = Math.max(0, Math.min(0.08, elapsed));
  if (!delta) return;
  ice.age += delta;
  ice.frost = 0.18 + 0.42 * (1 - Math.exp(-ice.age / 65));
  ice.icicles = 1 - Math.exp(-ice.age / 55);
  ice.snow = snowing
    ? 1 - (1 - ice.snow) * Math.exp(-delta / 28)
    : Math.max(0, ice.snow - delta / 180);
}

export function createIcicleLayout(random: () => number = Math.random) {
  return [1.8, 4.8, 8.5, 12.8, 18, 39, 62, 82, 87, 91.7, 95.3, 98].map(
    (position, index) => {
      const center = index === 5 || index === 6;
      const round =
        center ||
        index === 2 ||
        index === 9 ||
        (index !== 0 && index !== 11 && random() < 0.25);
      const tip = 43 + random() * 17;
      return {
        position: position + (random() - 0.5) * (center ? 5 : 1.2),
        center,
        round,
        width: round ? 5 + random() * 7 : 5 + random() * 6,
        length: round ? 4 + random() * 14 : 29 + random() * 65,
        delay: random() * 24,
        duration: 22 + random() * 108,
        silhouette: `polygon(0 0, 100% 0, 81% 23%, ${tip}% 100%, ${tip - 16}% 62%, 11% 31%)`,
      };
    },
  );
}

/** No overlapping icicle may extend below the middle of a nearby button. */
export function icicleLengthLimit(
  length: number,
  center: number,
  width: number,
  formBottom: number,
  buttons: { left: number; right: number; top: number; height: number }[],
) {
  return buttons.reduce((limit, button) => {
    if (center + width / 2 < button.left || center - width / 2 > button.right)
      return limit;
    return Math.max(
      0,
      Math.min(limit, button.top - formBottom + button.height / 2 - 2),
    );
  }, length);
}
