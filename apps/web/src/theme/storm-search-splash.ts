import { STORM_IMPACT_ANGLE, type GlassWeatherScene } from "./glass-weather";

export const SEARCH_SPLASH_PADDING = { x: 100, top: 120, bottom: 70 };
const MAX_IMPACTS = 14;

interface SprayBead {
  vx: number;
  vy: number;
  radius: number;
  lifetime: number;
  shape: number;
}

export interface SearchImpact {
  x: number;
  y: number;
  age: number;
  approach: number;
  distance: number;
  tilt: number;
  radius: number;
  beads: SprayBead[];
}

export interface SearchSplashScene {
  width: number;
  height: number;
  nextImpact: number;
  impacts: SearchImpact[];
}

export function createSearchSplash(
  width: number,
  height: number,
): SearchSplashScene {
  return { width, height, nextImpact: 0.05, impacts: [] };
}

export function advanceSearchSplash(
  scene: SearchSplashScene,
  elapsed: number,
  intensity: number,
  random: () => number = Math.random,
) {
  const delta = Math.max(0, Math.min(0.08, elapsed));
  if (!delta) return;
  for (const impact of scene.impacts) impact.age += delta;
  scene.impacts = scene.impacts.filter(
    (impact) => impact.age < impact.approach + 0.65,
  );
  scene.nextImpact -= delta;
  if (scene.nextImpact > 0 || scene.impacts.length >= MAX_IMPACTS) return;
  const force = Math.max(0, Math.min(1, intensity));
  const side = random() < 0.14;
  scene.impacts.push({
    x: side ? 0 : 14 + random() * Math.max(0, scene.width - 28),
    y: side ? 12 + random() * Math.max(0, scene.height - 24) : 0,
    age: 0,
    approach: 0.08 + (1 - force) * 0.045 + random() * 0.035,
    distance: 55 + force * 35 + random() * 20,
    tilt: STORM_IMPACT_ANGLE + (random() - 0.5) * 0.12,
    radius: 1.6 + random() * 1.7,
    beads: Array.from({ length: 5 }, () => {
      // Reflect away from the struck surface; tangential wind carries the spray.
      const tangent = (random() - 0.35) * (100 + force * 130);
      const rebound = 55 + random() * (65 + force * 70);
      return {
        vx: side ? -rebound : tangent,
        vy: side ? tangent - 40 : -rebound,
        radius: 0.7 + random() * 1.3,
        lifetime: 0.26 + random() * 0.3,
        shape: Math.floor(random() * 6),
      };
    }),
  });
  const compact = scene.width < 600 ? 0.7 : 1;
  scene.nextImpact = (0.6 + random() * 0.75) / ((2 + force * 12) * compact);
}

export function searchImpactAppearance(impact: SearchImpact) {
  const contactAge = impact.age - impact.approach;
  const remaining = Math.max(0, 1 - impact.age / impact.approach);
  const distance = impact.distance * remaining;
  return {
    incoming: contactAge < 0,
    x: impact.x + Math.sin(impact.tilt) * distance,
    y: impact.y - Math.cos(impact.tilt) * distance,
    beads:
      contactAge < 0
        ? []
        : impact.beads.map((bead) => {
            const age = Math.min(contactAge, bead.lifetime);
            const opacity = Math.max(0, 1 - age / bead.lifetime);
            return {
              x: impact.x + bead.vx * age,
              y: impact.y + bead.vy * age + 95 * age * age,
              radius: bead.radius,
              rotation: -Math.atan2(bead.vx, bead.vy + 190 * age),
              opacity: opacity * opacity,
              shape: bead.shape,
            };
          }),
  };
}

/** Uses the ambient animation clock, including its surge, pause and motion guards. */
export function createSearchSplashPainter(
  sprites: (HTMLCanvasElement | null)[],
) {
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let scene: SearchSplashScene | null = null;
  let nextMeasure = -1;
  let visible = false;
  let previousWeather: GlassWeatherScene | null = null;
  let leftPadding = SEARCH_SPLASH_PADDING.x;
  let rightPadding = SEARCH_SPLASH_PADDING.x;
  const hide = () => {
    if (canvas) canvas.style.visibility = "hidden";
  };
  return {
    hide,
    draw(weather: GlassWeatherScene, elapsed: number) {
      // Viewport resizing recreates the ambient scene and resets its clock.
      if (weather !== previousWeather) {
        previousWeather = weather;
        nextMeasure = -1;
      }
      // Local coordinates follow scrolling for free; layout is read at most 4 Hz.
      if (weather.time >= nextMeasure || (canvas && !canvas.isConnected)) {
        nextMeasure = weather.time + 0.25;
        const target = document.querySelector<HTMLCanvasElement>(
          ".composer-form > .theme-search-splash",
        );
        if (canvas !== target) {
          hide();
          canvas = target;
          context = canvas?.getContext("2d") ?? null;
          scene = null;
        }
        const bounds = canvas?.parentElement?.getBoundingClientRect();
        visible = Boolean(
          bounds &&
          bounds.width > 28 &&
          bounds.height > 24 &&
          bounds.bottom > 0 &&
          bounds.top < window.innerHeight,
        );
        const nextLeft = Math.max(
          0,
          Math.min(SEARCH_SPLASH_PADDING.x, bounds?.left ?? 0),
        );
        const nextRight = Math.max(
          0,
          Math.min(
            SEARCH_SPLASH_PADDING.x,
            window.innerWidth - (bounds?.right ?? 0),
          ),
        );
        if (
          canvas &&
          context &&
          bounds &&
          visible &&
          (!scene ||
            scene.width !== bounds.width ||
            scene.height !== bounds.height ||
            leftPadding !== nextLeft ||
            rightPadding !== nextRight)
        ) {
          if (
            !scene ||
            scene.width !== bounds.width ||
            scene.height !== bounds.height
          )
            scene = createSearchSplash(bounds.width, bounds.height);
          leftPadding = nextLeft;
          rightPadding = nextRight;
          const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
          const width = bounds.width + leftPadding + rightPadding;
          const height =
            bounds.height +
            SEARCH_SPLASH_PADDING.top +
            SEARCH_SPLASH_PADDING.bottom;
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          canvas.style.left = `${-leftPadding - 1}px`;
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
      }
      if (!canvas || !context || !scene || !visible) {
        hide();
        return;
      }
      canvas.style.visibility = "visible";
      const { top, bottom } = SEARCH_SPLASH_PADDING;
      const width = scene.width + leftPadding + rightPadding;
      context.clearRect(0, 0, width, scene.height + top + bottom);
      advanceSearchSplash(scene, elapsed, weather.stormSurge?.intensity ?? 0);
      context.save();
      context.translate(leftPadding, top);
      // Keep the whole input and its button clear and interactive.
      context.beginPath();
      context.rect(-leftPadding, -top, width, scene.height + top + bottom);
      context.rect(0, 0, scene.width, scene.height);
      context.clip("evenodd");
      for (const impact of scene.impacts) {
        const look = searchImpactAppearance(impact);
        if (look.incoming) {
          context.globalAlpha = 0.7;
          context.strokeStyle = "#d0e4f0";
          context.lineWidth = impact.radius * 0.65;
          context.lineCap = "round";
          context.beginPath();
          context.moveTo(
            look.x + Math.sin(impact.tilt) * 13,
            look.y - Math.cos(impact.tilt) * 13,
          );
          context.lineTo(look.x, look.y);
          context.stroke();
        }
        for (const bead of look.beads) {
          const sprite = sprites[bead.shape];
          if (!sprite || bead.opacity <= 0) continue;
          context.globalAlpha = bead.opacity * 0.9;
          context.save();
          context.translate(bead.x, bead.y);
          context.rotate(bead.rotation);
          const size = bead.radius * 4;
          context.drawImage(sprite, -size / 2, -size * 0.7, size, size * 1.4);
          context.restore();
        }
      }
      context.restore();
    },
  };
}
