import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createIcicleLayout, icicleLengthLimit } from "./winter-ice";

/** Lives on the form, so ice stays attached while scrolling and resizing. */
export function WinterSearchIce() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [icicles] = useState(() => createIcicleLayout());
  useEffect(() => {
    const root = rootRef.current;
    const form = root?.parentElement;
    if (!root || !form) return;
    const examples = form.parentElement?.querySelector(".prompt-examples");
    const buttons = Array.from(examples?.querySelectorAll("button") ?? []);
    const measure = () => {
      const bounds = form.getBoundingClientRect();
      const buttonBounds = buttons.map((button) =>
        button.getBoundingClientRect(),
      );
      root
        .querySelectorAll<HTMLElement>(".winter-search-ice__icicles > span")
        .forEach((node, index) => {
          const icicle = icicles[index];
          const limit = icicleLengthLimit(
            icicle.length,
            bounds.left + (bounds.width * icicle.position) / 100,
            icicle.width,
            bounds.bottom,
            buttonBounds,
          );
          node.style.setProperty("--ice-limit", `${limit}px`);
        });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(form);
    if (examples) observer?.observe(examples);
    buttons.forEach((button) => observer?.observe(button));
    examples?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      examples?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [icicles]);
  return (
    <div ref={rootRef} className="winter-search-ice" aria-hidden="true">
      <svg
        className="winter-search-ice__snow"
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        fill="none"
        focusable="false"
      >
        <path
          d="M 0 23 Q 5 15 13 15 C 42 15 46 7 75 9 S 111 17 151 10 S 194 6 223 11 S 275 15 307 8 S 348 4 379 10 S 433 14 462 8 S 509 4 541 10 S 590 14 619 8 S 663 4 691 10 S 744 15 773 9 S 820 5 851 11 S 906 13 933 8 S 968 13 985 14 Q 996 15 1000 23 Z"
          fill="#e7f3fb"
        />
        <path
          d="M 4 23 Q 41 17 75 18 T 151 19 T 223 19 T 307 18 T 379 19 T 462 18 T 541 19 T 619 18 T 691 19 T 773 18 T 851 19 T 933 18 T 996 23"
          stroke="#9ebfd4"
          strokeWidth="2"
          strokeOpacity="0.6"
        />
      </svg>
      <div className="winter-search-ice__rim" />
      <div className="winter-search-ice__icicles">
        {icicles.map((icicle, index) => (
          <span
            key={index}
            data-tip={icicle.round ? "round" : "sharp"}
            data-zone={icicle.center ? "center" : "edge"}
            style={
              {
                left: `${icicle.position}%`,
                width: `${icicle.width}px`,
                clipPath: icicle.round ? undefined : icicle.silhouette,
                "--ice-length": `${icicle.length}px`,
                "--ice-delay": icicle.delay,
                "--ice-duration": icicle.duration,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
