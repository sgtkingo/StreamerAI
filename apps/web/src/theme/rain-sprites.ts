/** Reusable refractive beads are painted once, never blurred per frame. */
export function createRainSprite(variant = 0) {
  const sprite = document.createElement("canvas");
  sprite.width = 128;
  sprite.height = 128;
  const context = sprite.getContext("2d");
  if (!context) return null;

  const phase = variant * 1.73;
  const points = Array.from({ length: 40 }, (_, index) => {
    const angle = (index / 40) * Math.PI * 2;
    const radius =
      34 *
      (1 +
        0.12 * Math.sin(angle * 3 + phase) +
        0.065 * Math.cos(angle * 5 - phase) +
        0.08 * Math.sin(angle + phase * 0.6));
    return {
      x: 64 + Math.cos(angle) * radius,
      y: 64 + Math.sin(angle) * radius * (0.94 + (variant % 3) * 0.07),
    };
  });
  const trace = (start: number, count: number) => {
    const first = points[start % points.length];
    const previous = points[(start + points.length - 1) % points.length];
    context.beginPath();
    context.moveTo((previous.x + first.x) / 2, (previous.y + first.y) / 2);
    for (let index = start; index < start + count; index += 1) {
      const point = points[index % points.length];
      const next = points[(index + 1) % points.length];
      context.quadraticCurveTo(
        point.x,
        point.y,
        (point.x + next.x) / 2,
        (point.y + next.y) / 2,
      );
    }
  };

  // A clear center, dark upper meniscus and displaced lower highlight suggest
  // a lens on glass rather than an opaque falling raindrop.
  trace(0, points.length);
  const lens = context.createRadialGradient(57, 53, 3, 65, 65, 43);
  lens.addColorStop(0, "#c6d6dd0b");
  lens.addColorStop(0.5, "#bed0d918");
  lens.addColorStop(0.78, "#111b245e");
  lens.addColorStop(0.92, "#050d148a");
  lens.addColorStop(1, "#b9cbdc29");
  context.fillStyle = lens;
  context.fill();
  context.lineWidth = 1.2;
  context.strokeStyle = "#c6dae332";
  context.stroke();

  context.lineCap = "round";
  trace(21, 16);
  context.lineWidth = 3;
  context.strokeStyle = "#020810aa";
  context.stroke();
  trace(2, 13);
  context.lineWidth = 1.7;
  context.strokeStyle = "#e1edf29c";
  context.stroke();
  trace(34, 3);
  context.lineWidth = 1.2;
  context.strokeStyle = "#e8f3f777";
  context.stroke();

  const caustic = context.createRadialGradient(59, 79, 0, 59, 79, 14);
  caustic.addColorStop(0, "#e1edf250");
  caustic.addColorStop(1, "#e1edf200");
  context.fillStyle = caustic;
  context.fillRect(43, 63, 32, 32);
  return sprite;
}
