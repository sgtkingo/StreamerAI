import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import type { ResolvedTheme, ThemeMotif } from "./resolve-theme";
import { createRainSprite } from "./rain-sprites";
import {
  CHRISTMAS_LIGHT_COLORS,
  advanceFireworkBurst,
  createFireworkBurst,
  festiveSceneBudget,
  fireworkOpacity,
  type FireworkBurst,
} from "./festive-scene";
import {
  advanceGlassWeather,
  createGlassWeather,
  dropletAppearance,
  lightningOpacity,
  snowflakeAppearance,
  splashDropletAppearance,
  type GlassWeatherKind,
  type GlassWeatherScene,
} from "./glass-weather";

interface Particle {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  rotation: number;
  sprite: number;
}

/** Refraction is painted once; no backdrop reads, per-frame blur or screen copies. */
function createGlassSprite(kind: "crystal" | "lightning") {
  const sprite = document.createElement("canvas");
  sprite.width = 96;
  sprite.height = 128;
  const context = sprite.getContext("2d");
  if (!context) return null;
  if (kind === "crystal") {
    context.translate(48, 64);
    context.strokeStyle = "#e2efffc9";
    context.lineWidth = 2;
    context.lineCap = "round";
    for (let index = 0; index < 6; index += 1) {
      context.save();
      context.rotate((index / 6) * Math.PI * 2);
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(0, -30);
      context.moveTo(-8, -22);
      context.lineTo(0, -15);
      context.lineTo(8, -22);
      context.stroke();
      context.restore();
    }
  } else {
    const glow = context.createRadialGradient(48, 50, 2, 48, 58, 65);
    glow.addColorStop(0, "#f6faff");
    glow.addColorStop(0.12, "#e5effff5");
    glow.addColorStop(0.38, "#b9d2f5b3");
    glow.addColorStop(1, "#adc8f000");
    context.fillStyle = glow;
    context.fillRect(0, 0, 96, 128);
  }
  return sprite;
}

function createSprite(
  motif: ThemeMotif | "snow",
  color: string,
): HTMLCanvasElement | null {
  const sprite = document.createElement("canvas");
  sprite.width = 64;
  sprite.height = 64;
  const context = sprite.getContext("2d");
  if (!context) return null;
  context.translate(32, 32);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.filter = motif === "snow" ? "blur(1.2px)" : "blur(3px)";
  if (motif === "leaves" || motif === "petals") {
    context.beginPath();
    context.ellipse(
      0,
      0,
      13,
      motif === "leaves" ? 7 : 10,
      -0.5,
      0,
      Math.PI * 2,
    );
    context.fill();
  } else if (motif === "confetti") {
    context.fillRect(-4, -10, 8, 20);
  } else if (motif === "crystals") {
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-11, 0);
    context.lineTo(11, 0);
    context.moveTo(0, -11);
    context.lineTo(0, 11);
    context.stroke();
  } else {
    const glow = context.createRadialGradient(0, 0, 0, 0, 0, 20);
    glow.addColorStop(0, color);
    glow.addColorStop(1, "transparent");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(0, 0, motif === "snow" ? 10 : 21, 0, Math.PI * 2);
    context.fill();
  }
  return sprite;
}

/** A single bounded decorative canvas. All particle blur is baked into sprites. */
export function AmbientBackground({
  theme,
  enabled = true,
  paused = false,
}: {
  theme: ResolvedTheme;
  enabled?: boolean;
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const motionPreferenceRef = useRef<MediaQueryList>();
  const pausedRef = useRef(paused);
  const synchronizedPauseRef = useRef(paused);
  const synchronizeRef = useRef<() => void>(() => undefined);
  pausedRef.current = paused;
  const christmas = theme.id === "christmas";
  const newYear = theme.id === "new-year";
  const festive = christmas || newYear;
  // A clock tick must not erase accumulated frost or randomly reseed wet glass.
  const sceneTheme = useMemo(
    () => ({
      id: theme.id,
      motif: theme.motif,
      weatherEffect: theme.weatherEffect,
      palette: {
        particle: theme.palette.particle,
        accent: theme.palette.accent,
      },
    }),
    [
      theme.id,
      theme.motif,
      theme.weatherEffect,
      theme.palette.particle,
      theme.palette.accent,
    ],
  );

  useEffect(() => {
    const theme = sceneTheme;
    const canvas = canvasRef.current;
    if (layerRef.current) layerRef.current.dataset.static = "true";
    if (
      !canvas ||
      !enabled ||
      theme.id === "cinematic" ||
      typeof window.requestAnimationFrame !== "function" ||
      typeof CanvasRenderingContext2D === "undefined"
    )
      return;
    // Retain the media query across weather changes so preference events keep
    // reaching the active scene after the previous scene removes its listener.
    const reducedMotion = (motionPreferenceRef.current ??= window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ));
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const glassWeather = ["rain", "storm", "snow"].includes(theme.weatherEffect)
      ? (theme.weatherEffect as GlassWeatherKind)
      : null;
    const decorativeSnow = theme.id === "christmas" || theme.id === "new-year";
    const fireworks = theme.id === "new-year";
    const christmasLights = theme.id === "christmas";
    const sprites = [
      theme.palette.particle,
      theme.motif === "leaves" ? "#aa5262" : theme.palette.accent,
      theme.motif === "leaves" ? "#d6ac59" : theme.palette.particle,
    ].map((color) => createSprite(theme.motif, color));
    const snowSprite = createSprite("snow", "#dbe8f2");
    const dropletSprites =
      glassWeather && glassWeather !== "snow"
        ? Array.from({ length: 6 }, (_, index) => createRainSprite(index))
        : [];
    const crystalSprite =
      glassWeather === "snow" ? createGlassSprite("crystal") : null;
    const lightningSprite =
      glassWeather === "storm" ? createGlassSprite("lightning") : null;
    const lightSprites = christmasLights
      ? CHRISTMAS_LIGHT_COLORS.map((color) => createSprite("lights", color))
      : [];
    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let snow: Particle[] = [];
    let lightCount = 0;
    let bursts: FireworkBurst[] = [];
    let glass: GlassWeatherScene | null = null;
    let paintedFrost = -1;
    let paintedRainHaze = -1;
    let frame = 0;
    let lastFrame = 0;
    let slowFrames = 0;
    let performancePaused = false;
    let disposed = false;

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const budget = width < 768 ? 16 : 40;
      const festiveBudget = festiveSceneBudget(width < 768);
      lightCount = christmasLights ? festiveBudget.lights : 0;
      // Holiday snow is decoration. It never changes the real weather state,
      // and rain can still form a separate small foreground weather layer.
      const count = decorativeSnow
        ? 0
        : glassWeather
          ? width < 768
            ? 2
            : 4
          : theme.weatherEffect === "fog"
            ? Math.ceil(budget / 4)
            : budget;
      particles = Array.from({ length: count }, (_, index) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        size: 15 + Math.random() * 25,
        speed: 5 + Math.random() * 13,
        phase: Math.random() * Math.PI * 2,
        rotation: Math.random() * Math.PI,
        sprite: index % 3,
      }));
      snow = decorativeSnow
        ? Array.from({ length: festiveBudget.snow }, (_, index) => ({
            x: Math.random() * width,
            y: Math.random() * height,
            size: 14 + Math.random() * 15,
            speed: 12 + Math.random() * 19,
            phase: Math.random() * Math.PI * 2,
            rotation: 0,
            sprite: index % 3,
          }))
        : [];
      const previousRainHaze = glass?.rainHaze ?? 0;
      glass = glassWeather
        ? createGlassWeather(
            glassWeather,
            width,
            height,
            width < 768,
            decorativeSnow,
          )
        : null;
      if (glass?.kind === "rain") glass.rainHaze = previousRainHaze;
      paintedRainHaze = -1;
      paintedFrost = -1;
      bursts = fireworks
        ? Array.from({ length: festiveBudget.bursts }, (_, index) => {
            const burst = createFireworkBurst(
              width,
              height,
              festiveBudget.sparksPerBurst,
            );
            // Stagger bursts instead of firing the whole canvas at once.
            burst.age = index === 0 ? 0 : -1.8;
            return burst;
          })
        : [];
    };

    const draw = (time: number, elapsed: number) => {
      context.clearRect(0, 0, width, height);
      for (const particle of particles) {
        particle.y += elapsed * particle.speed;
        particle.x +=
          elapsed * (2 + Math.sin(time / 6000 + particle.phase) * 5);
        if (particle.y > height + 40) {
          particle.y = -40;
          particle.x = Math.random() * width;
        }
        if (particle.x > width + 40) particle.x = -40;
        const opacity =
          (0.08 + (Math.sin(time / 4500 + particle.phase) + 1) * 0.055) *
          (theme.weatherEffect === "fog" ? 0.45 : 1);
        context.globalAlpha = opacity;
        {
          const sprite = sprites[particle.sprite];
          if (!sprite) continue;
          context.save();
          context.translate(particle.x, particle.y);
          context.rotate(
            particle.rotation + Math.sin(time / 9000 + particle.phase),
          );
          const size = particle.size;
          context.drawImage(sprite, -size / 2, -size / 2, size, size);
          context.restore();
        }
      }
      if (glass) {
        advanceGlassWeather(glass, elapsed);
        const haze = Math.round(glass.rainHaze * 1000);
        if (haze !== paintedRainHaze && layerRef.current) {
          layerRef.current.style.setProperty(
            "--rain-haze",
            String(haze / 1000),
          );
          paintedRainHaze = haze;
        }
        for (const drop of glass.droplets) {
          const appearance = dropletAppearance(drop);
          const trail = drop.motion?.trail;
          if (trail && trail.length > 1 && appearance.trailLength > 2) {
            const wetTrace = context.createLinearGradient(
              trail[0].x,
              trail[0].y,
              drop.x,
              drop.y,
            );
            wetTrace.addColorStop(0, "#c3d2da00");
            wetTrace.addColorStop(0.45, "#c3d2da02");
            wetTrace.addColorStop(0.8, "#c3d2da0a");
            wetTrace.addColorStop(1, "#dce8ee1a");
            context.globalAlpha = appearance.opacity;
            context.strokeStyle = wetTrace;
            context.lineWidth = appearance.trailWidth * 0.72;
            context.lineCap = "round";
            context.lineJoin = "round";
            context.beginPath();
            context.moveTo(trail[0].x, trail[0].y);
            for (let index = 1; index < trail.length - 1; index += 1) {
              const point = trail[index],
                next = trail[index + 1];
              context.quadraticCurveTo(
                point.x,
                point.y,
                (point.x + next.x) / 2,
                (point.y + next.y) / 2,
              );
            }
            context.lineTo(drop.x, drop.y);
            context.stroke();
          }
          for (const splash of drop.splashlets) {
            const look = splashDropletAppearance(drop, splash);
            const sprite = dropletSprites[splash.shape];
            if (!look || !sprite) continue;
            const size = look.radius * 3.5;
            const aspect = glass.kind === "storm" ? 1.3 : 1;
            context.globalAlpha =
              look.opacity * (glass.kind === "storm" ? 0.85 : 0.6);
            context.save();
            context.translate(look.x, look.y);
            context.rotate(look.rotation);
            context.drawImage(
              sprite,
              -size / 2,
              (-size * aspect) / 2,
              size,
              size * aspect,
            );
            context.restore();
          }
          const dropletSprite = dropletSprites[drop.shape];
          if (dropletSprite) {
            context.globalAlpha =
              appearance.opacity * (glass.kind === "storm" ? 0.9 : 0.72);
            context.save();
            context.translate(drop.x, drop.y);
            context.rotate(appearance.rotation);
            const width = drop.radius * 3.5 * appearance.scaleX;
            const height = drop.radius * 3.5 * appearance.scaleY;
            context.drawImage(
              dropletSprite,
              -width / 2,
              -height / 2,
              width,
              height,
            );
            context.restore();
          }
        }
        for (const flake of glass.flakes) {
          const appearance = snowflakeAppearance(flake);
          const sprite =
            appearance.phase === "flight" ? snowSprite : crystalSprite;
          if (!sprite) continue;
          const size = flake.radius * (appearance.phase === "flight" ? 5 : 3.4);
          context.globalAlpha = appearance.opacity;
          context.drawImage(
            sprite,
            flake.x - size / 2,
            flake.y - size / 2,
            size,
            size,
          );
        }
        const frost = Math.round(glass.frost * 100);
        if (frost !== paintedFrost && layerRef.current) {
          layerRef.current.style.setProperty(
            "--glass-frost",
            String(glass.frost),
          );
          paintedFrost = frost;
        }
        const lightning = lightningOpacity(glass);
        if (lightning && lightningSprite) {
          context.globalAlpha = lightning * 0.1;
          context.fillStyle = "#afc9f0";
          context.fillRect(0, 0, width, height);
          context.globalAlpha = lightning;
          context.drawImage(
            lightningSprite,
            glass.lightningX - width * 0.6,
            glass.lightningY - height * 0.6,
            width * 1.2,
            height * 1.2,
          );
        }
      }
      for (const flake of snow) {
        flake.y += elapsed * flake.speed;
        flake.x += elapsed * Math.sin(time / 5000 + flake.phase) * 10;
        if (flake.y > height + 20) {
          flake.y = -20;
          flake.x = Math.random() * width;
        }
        if (flake.x < -20) flake.x = width + 20;
        if (flake.x > width + 20) flake.x = -20;
        context.globalAlpha = 0.25 + (flake.sprite / 3) * 0.22;
        if (snowSprite)
          context.drawImage(
            snowSprite,
            flake.x,
            flake.y,
            flake.size,
            flake.size,
          );
      }
      for (let index = 0; index < lightCount; index += 1) {
        const sprite = lightSprites[index % lightSprites.length];
        if (!sprite) continue;
        const position = index / Math.max(1, lightCount - 1);
        const x = width * (0.025 + position * 0.95);
        const y = height * (0.075 + Math.sin(position * Math.PI) * 0.105);
        context.globalAlpha =
          0.3 + (Math.sin(time / 2300 + index * 1.7) + 1) * 0.13;
        context.drawImage(sprite, x - 33, y - 33, 66, 66);
      }
      for (let index = 0; index < bursts.length; index += 1) {
        const burst = bursts[index];
        advanceFireworkBurst(burst, elapsed);
        if (burst.age >= burst.duration + 1.1) {
          bursts[index] = createFireworkBurst(
            width,
            height,
            burst.sparks.length,
          );
          continue;
        }
        const opacity = fireworkOpacity(burst);
        if (!opacity) continue;
        for (const spark of burst.sparks) {
          // Each spark retains a short velocity trail; no full-screen fade or
          // additive blending, so overlapping bursts never create flashes.
          context.globalAlpha = opacity * 0.45;
          context.strokeStyle = spark.color;
          context.lineWidth = spark.size;
          context.beginPath();
          context.moveTo(
            spark.x - spark.velocityX * 0.14,
            spark.y - spark.velocityY * 0.14,
          );
          context.lineTo(spark.x, spark.y);
          context.stroke();
          context.globalAlpha = opacity;
          context.fillStyle = spark.color;
          context.beginPath();
          context.arc(spark.x, spark.y, spark.size, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;
    };

    const canAnimate = () =>
      !disposed &&
      !pausedRef.current &&
      !document.hidden &&
      !reducedMotion?.matches &&
      !performancePaused;
    const animate = (time: number) => {
      frame = 0;
      if (!canAnimate()) {
        if (!disposed && reducedMotion?.matches) synchronize();
        return;
      }
      if (time - lastFrame >= 1000 / 30) {
        const started = performance.now();
        draw(time, Math.min((time - (lastFrame || time)) / 1000, 0.08));
        lastFrame = time;
        slowFrames =
          performance.now() - started > 12
            ? slowFrames + 1
            : Math.max(0, slowFrames - 1);
        if (slowFrames >= 8) {
          performancePaused = true;
          if (layerRef.current) layerRef.current.dataset.static = "true";
          canvas.style.visibility = "hidden";
        }
      }
      if (canAnimate()) frame = requestAnimationFrame(animate);
    };
    const synchronize = () => {
      synchronizedPauseRef.current = pausedRef.current;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      // Reduced motion renders the atmosphere through static CSS only.
      canvas.style.visibility =
        reducedMotion?.matches || performancePaused ? "hidden" : "visible";
      if (layerRef.current)
        layerRef.current.dataset.static = String(
          Boolean(reducedMotion?.matches || performancePaused),
        );
      if (canAnimate()) frame = requestAnimationFrame(animate);
    };
    resize();
    draw(0, 0);
    synchronizeRef.current = synchronize;
    synchronize();
    const handleResize = () => {
      resize();
      draw(0, 0);
    };
    window.addEventListener("resize", handleResize);
    document.addEventListener("visibilitychange", synchronize);
    reducedMotion?.addEventListener("change", synchronize);
    return () => {
      disposed = true;
      synchronizeRef.current = () => undefined;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", synchronize);
      reducedMotion?.removeEventListener("change", synchronize);
    };
  }, [sceneTheme, enabled]);

  useEffect(() => {
    if (synchronizedPauseRef.current !== paused) {
      synchronizedPauseRef.current = paused;
      synchronizeRef.current();
    }
  }, [paused]);

  if (theme.id === "cinematic") return null;
  const style = {
    "--ambient-glow": theme.palette.glow,
    "--ambient-opacity": theme.ambientOpacity,
  } as CSSProperties;
  return (
    <div
      ref={layerRef}
      className={`theme-ambient theme-ambient--${theme.weatherEffect}${festive ? ` theme-ambient--${theme.id}` : ""}`}
      style={style}
      aria-hidden="true"
      data-paused={paused || !enabled}
      data-static="true"
    >
      <div className="theme-ambient__wash" />
      {theme.weatherEffect !== "storm" && (
        <div className="theme-ambient__haze" />
      )}
      {["rain", "storm"].includes(theme.weatherEffect) && (
        <div className="theme-ambient__wet-glass">
          {Array.from({ length: 16 }, (_, index) => (
            <span
              key={index}
              style={
                {
                  left: `${2 + ((index * 61.8) % 95)}%`,
                  top: `${7 + ((index * 37.3) % 83)}%`,
                  "--drop-size": `${6 + ((index * 7) % 12)}px`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      {theme.weatherEffect === "snow" && (
        <div className="theme-ambient__frost-rim" />
      )}
      {festive && <div className="theme-ambient__festive-snow" />}
      {christmas && (
        <div className="theme-ambient__light-string">
          {Array.from({ length: 14 }, (_, index) => (
            <span
              key={index}
              style={
                {
                  "--light-color":
                    CHRISTMAS_LIGHT_COLORS[
                      index % CHRISTMAS_LIGHT_COLORS.length
                    ],
                  left: `${2.5 + (index / 13) * 95}%`,
                  top: `${7.5 + Math.sin((index / 13) * Math.PI) * 10.5}vh`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      {newYear && (
        <div className="theme-ambient__static-fireworks">
          {[0, 1].map((burst) => (
            <div className="theme-ambient__firework" key={burst}>
              {Array.from({ length: 14 }, (_, index) => (
                <span
                  key={index}
                  style={
                    {
                      "--ray-angle": `${(index / 14) * 360}deg`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <canvas
        className="theme-ambient__particles"
        ref={canvasRef}
        hidden={!enabled}
      />
    </div>
  );
}
