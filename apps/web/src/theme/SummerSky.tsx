import { useId, type CSSProperties } from "react";
import { SUMMER_STARS, moonIlluminationPath } from "./summer-sky";
import type { WeatherEffect } from "./resolve-theme";

interface SkyProps {
  period: "day" | "night";
  phase: number;
  weather: WeatherEffect;
}

export function SummerSky(props: SkyProps) {
  return <SeasonalSky {...props} />;
}

export function WinterSky(props: SkyProps) {
  return <SeasonalSky {...props} winter />;
}

function SeasonalSky({
  period,
  phase,
  weather,
  winter = false,
}: SkyProps & { winter?: boolean }) {
  const id = useId().replace(/:/g, "");
  const illuminated = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  const path = moonIlluminationPath(phase);
  return (
    <div
      className={`theme-ambient__summer theme-ambient__summer--${period}${winter ? " theme-ambient__winter-sky" : ""}`}
      data-weather={weather}
    >
      {period === "day" ? (
        (weather === "none" || (!winter && weather === "fog")) && (
          <div className="summer-sun">
            <div className="summer-sun__rays" />
            <div className="summer-sun__disc" />
          </div>
        )
      ) : (
        <>
          <div className="summer-stars">
            {SUMMER_STARS.map((star, index) => (
              <span
                key={index}
                className={`summer-star${star.bright ? " summer-star--bright" : ""}`}
                style={
                  {
                    left: `${star.x}%`,
                    top: `${star.y}%`,
                    width: star.size * (winter ? 1.15 : 1),
                    height: star.size * (winter ? 1.15 : 1),
                    opacity: Math.min(1, star.opacity + (winter ? 0.25 : 0)),
                  } as CSSProperties
                }
              />
            ))}
          </div>
          <svg
            className="summer-moon"
            viewBox="-70 -70 140 140"
            fill="none"
            focusable="false"
            data-phase={phase.toFixed(4)}
          >
            <defs>
              <radialGradient id={`${id}-halo`}>
                <stop
                  stopColor={winter ? "#e5f5ff" : "#f6e9c5"}
                  stopOpacity={(winter ? 0.22 : 0.12) * illuminated}
                />
                <stop offset="1" stopColor="#f6e9c5" stopOpacity="0" />
              </radialGradient>
              <radialGradient id={`${id}-light`} cx="33%" cy="25%" r="85%">
                <stop stopColor={winter ? "#ffffff" : "#fff8dc"} />
                <stop offset="0.6" stopColor={winter ? "#e9f3ff" : "#e8dfbd"} />
                <stop offset="1" stopColor={winter ? "#b9d1e5" : "#b9bec0"} />
              </radialGradient>
              <clipPath id={`${id}-lit`}>
                <path d={path} />
              </clipPath>
            </defs>
            <circle r="69" fill={`url(#${id}-halo)`} />
            <circle
              r="34"
              fill="#c2c7ce"
              opacity={0.025 + illuminated * 0.02}
            />
            <g clipPath={`url(#${id}-lit)`}>
              <circle r="34" fill={`url(#${id}-light)`} />
              <ellipse
                cx="-10"
                cy="-7"
                rx="12"
                ry="16"
                fill="#778591"
                opacity={winter ? 0.3 : 0.18}
                transform="rotate(-24)"
              />
              <ellipse
                cx="13"
                cy="10"
                rx="9"
                ry="13"
                fill="#859095"
                opacity={winter ? 0.23 : 0.13}
                transform="rotate(20)"
              />
              <circle
                cx="-15"
                cy="18"
                r="4"
                stroke="#fff5da"
                strokeOpacity="0.3"
                fill="#88918f"
                fillOpacity="0.2"
              />
              <circle cx="15" cy="-16" r="5" fill="#7d8991" opacity="0.12" />
              <circle cx="3" cy="23" r="2.5" fill="#fff6df" opacity="0.45" />
            </g>
          </svg>
        </>
      )}
      {weather !== "none" &&
        (winter || (period === "night" && weather !== "fog")) && (
          <div className={winter ? "winter-clouds" : "summer-night-clouds"}>
            <span />
            <span />
            <span />
          </div>
        )}
    </div>
  );
}
