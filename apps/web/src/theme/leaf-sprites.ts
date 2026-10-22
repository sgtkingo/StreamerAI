const BLUR_LEVELS = [0.45, 3.5, 8.5, 17];

/** Native leaf artwork with four cached focal distances; no per-frame blur. */
export function createWindLeafSprites(colors: string[]) {
  return colors.map((color, variant) => {
    const leaf = document.createElement("canvas");
    leaf.width = leaf.height = 224;
    const context = leaf.getContext("2d");
    if (!context) return [];
    context.translate(112, 112);
    const surface = context.createLinearGradient(-45, -50, 40, 55);
    surface.addColorStop(0, "#ebbc72");
    surface.addColorStop(0.36, color);
    surface.addColorStop(1, "#613724");
    context.fillStyle = surface;
    context.strokeStyle = "#edc49a55";
    context.lineWidth = 1.2;
    context.beginPath();
    if (variant === 0) {
      const points = [
        [0, 52],
        [-5, 34],
        [-30, 42],
        [-25, 25],
        [-48, 17],
        [-31, 5],
        [-57, -10],
        [-31, -9],
        [-37, -39],
        [-14, -26],
        [0, -66],
        [14, -26],
        [35, -39],
        [30, -9],
        [56, -12],
        [31, 7],
        [47, 18],
        [26, 26],
        [30, 41],
        [6, 34],
        [0, 52],
      ];
      context.moveTo(points[0][0], points[0][1]);
      for (const [x, y] of points.slice(1)) context.lineTo(x, y);
    } else if (variant === 1) {
      context.moveTo(0, 53);
      for (const [cx, cy, x, y] of [
        [-15, 44, -24, 36],
        [-41, 31, -29, 17],
        [-52, 9, -34, -4],
        [-47, -24, -23, -21],
        [-31, -45, -9, -38],
        [-5, -63, 4, -57],
        [18, -43, 10, -36],
        [38, -40, 29, -18],
        [51, -12, 33, 3],
        [46, 22, 26, 25],
        [32, 42, 8, 48],
        [3, 55, 0, 53],
      ])
        context.quadraticCurveTo(cx, cy, x, y);
    } else {
      context.moveTo(0, 56);
      context.quadraticCurveTo(-55, 18, -33, -24);
      context.quadraticCurveTo(-15, -50, 0, -61);
      context.quadraticCurveTo(50, -30, 39, 8);
      context.quadraticCurveTo(29, 33, 0, 56);
    }
    context.fill();
    context.stroke();
    context.strokeStyle = "#512b2280";
    context.lineWidth = 1.4;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(2, 72);
    context.quadraticCurveTo(-3, 20, 0, -52);
    for (const y of [-22, 0, 22]) {
      context.moveTo(0, y + 11);
      context.quadraticCurveTo(-15, y + 4, -29, y - 10);
      context.moveTo(0, y + 11);
      context.quadraticCurveTo(15, y + 4, 29, y - 12);
    }
    context.stroke();
    context.strokeStyle = "#ffe1aa40";
    context.lineWidth = 0.7;
    context.beginPath();
    context.moveTo(2, 50);
    context.quadraticCurveTo(3, 0, 1, -48);
    context.stroke();
    return BLUR_LEVELS.map((blur) => {
      const sprite = document.createElement("canvas");
      sprite.width = sprite.height = 224;
      const target = sprite.getContext("2d");
      if (!target) return null;
      target.filter = `blur(${blur}px)`;
      target.drawImage(leaf, 0, 0);
      return sprite;
    });
  });
}
