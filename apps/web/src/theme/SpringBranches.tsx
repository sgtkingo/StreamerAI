import { useId, type CSSProperties } from "react";

const stems = [
  {
    d: "M -10 334 C 24 298 40 270 56 230 S 84 170 106 124 S 143 61 160 22",
    birth: 0,
    rate: 1.65,
    width: 3,
  },
  {
    d: "M 48 250 C 72 240 102 226 126 199 S 163 163 195 148",
    birth: 0.2,
    rate: 2.1,
    width: 1.9,
  },
  {
    d: "M 78 183 C 65 155 51 139 45 110 S 42 75 33 57",
    birth: 0.31,
    rate: 2.5,
    width: 1.7,
  },
  {
    d: "M 111 116 C 134 119 156 109 176 88 S 200 57 218 49",
    birth: 0.39,
    rate: 2.3,
    width: 1.6,
  },
  {
    d: "M 126 198 C 130 177 124 153 132 137",
    birth: 0.48,
    rate: 3.4,
    width: 1.2,
  },
  { d: "M 141 63 C 126 52 121 36 122 19", birth: 0.49, rate: 3, width: 1.2 },
];

const leaves = [
  { x: 24, y: 297, angle: -58, size: 0.75, birth: 0.14 },
  { x: 47, y: 254, angle: 39, size: 0.95, birth: 0.23 },
  { x: 64, y: 213, angle: -65, size: 0.82, birth: 0.33 },
  { x: 90, y: 157, angle: 26, size: 0.85, birth: 0.44 },
  { x: 105, y: 125, angle: -54, size: 0.65, birth: 0.5 },
  { x: 99, y: 227, angle: 62, size: 0.76, birth: 0.46 },
  { x: 154, y: 171, angle: 37, size: 0.7, birth: 0.59 },
  { x: 49, y: 127, angle: -49, size: 0.72, birth: 0.6 },
  { x: 169, y: 96, angle: 62, size: 0.66, birth: 0.66 },
  { x: 149, y: 47, angle: 36, size: 0.55, birth: 0.69 },
];

const catkins = [
  { x: 62, y: 219, angle: 34, size: 0.8, birth: 0.38 },
  { x: 82, y: 174, angle: -42, size: 0.9, birth: 0.46 },
  { x: 124, y: 90, angle: 30, size: 0.78, birth: 0.59 },
  { x: 159, y: 24, angle: 23, size: 0.65, birth: 0.74 },
  { x: 190, y: 151, angle: 58, size: 0.85, birth: 0.69 },
  { x: 34, y: 62, angle: -20, size: 0.8, birth: 0.71 },
  { x: 213, y: 51, angle: 65, size: 0.67, birth: 0.78 },
  { x: 132, y: 140, angle: 15, size: 0.68, birth: 0.76 },
  { x: 122, y: 22, angle: -8, size: 0.6, birth: 0.78 },
];

const growth = (birth: number, rate = 5): CSSProperties =>
  ({ "--sprout-birth": birth, "--sprout-rate": rate }) as CSSProperties;

/** Native vector foliage: four small paint regions, driven by the ambient clock. */
export function SpringBranches() {
  const id = useId().replace(/:/g, "");
  return (
    <div className="theme-ambient__spring" aria-hidden="true">
      {["bottom-left", "top-right", "bottom-right", "top-left"].map(
        (corner, index) => (
          <svg
            key={corner}
            className={`spring-branch spring-branch--${corner}`}
            viewBox="0 0 260 340"
            fill="none"
            focusable="false"
          >
            <defs>
              <linearGradient
                id={`${id}-leaf-${index}`}
                x1="-7"
                y1="-22"
                x2="8"
                y2="-2"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#d7f69c" />
                <stop offset="0.48" stopColor="#b1e974" />
                <stop offset="1" stopColor="#5d9e45" />
              </linearGradient>
              <radialGradient
                id={`${id}-catkin-${index}`}
                cx="35%"
                cy="34%"
                r="70%"
              >
                <stop stopColor="#f0eed3" />
                <stop offset="0.52" stopColor="#d4debd" />
                <stop offset="1" stopColor="#819575" stopOpacity="0.65" />
              </radialGradient>
              <linearGradient
                id={`${id}-bark-${index}`}
                x1="0"
                y1="340"
                x2="150"
                y2="20"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#69754b" />
                <stop offset="0.6" stopColor="#a7b67a" />
                <stop offset="1" stopColor="#c1cb8d" />
              </linearGradient>
            </defs>
            <g className="spring-branch__sway">
              {stems.map((stem, stemIndex) => (
                <path
                  key={stemIndex}
                  className="spring-branch__stem"
                  d={stem.d}
                  style={growth(stem.birth, stem.rate)}
                  pathLength="1"
                  stroke={`url(#${id}-bark-${index})`}
                  strokeWidth={stem.width}
                  strokeLinecap="round"
                />
              ))}
              {leaves.map((leaf, leafIndex) => (
                <g
                  key={leafIndex}
                  transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.angle}) scale(${leaf.size})`}
                >
                  <g className="spring-branch__bud" style={growth(leaf.birth)}>
                    <path
                      d="M 0 0 C -10 -5 -13 -16 -5 -29 C 6 -26 14 -10 0 0 Z"
                      fill={`url(#${id}-leaf-${index})`}
                    />
                    <path
                      d="M 0 -1 Q -2 -12 -5 -26 M -2 -11 L -8 -15 M -3 -16 L 3 -20"
                      stroke="#e5f8b3"
                      strokeWidth="0.65"
                      strokeOpacity="0.65"
                    />
                  </g>
                </g>
              ))}
              {catkins.map((catkin, catkinIndex) => (
                <g
                  key={catkinIndex}
                  transform={`translate(${catkin.x} ${catkin.y}) rotate(${catkin.angle}) scale(${catkin.size})`}
                >
                  <g
                    className="spring-branch__bud spring-branch__catkin"
                    style={growth(catkin.birth, 6)}
                  >
                    <path d="M 0 0 L 0 -8" stroke="#a3ac72" strokeWidth="1.2" />
                    <ellipse
                      cx="0"
                      cy="-15"
                      rx="5.6"
                      ry="10.5"
                      fill={`url(#${id}-catkin-${index})`}
                    />
                    <path
                      d="M -4 -7 L -7 -9 M 4 -7 L 7 -10 M -5 -11 L -8 -13 M 5 -11 L 8 -14 M -5 -16 L -8 -18 M 5 -16 L 8 -19 M -4 -20 L -6 -23 M 4 -20 L 6 -24 M -1 -24 L -2 -27 M 1 -24 L 2 -27"
                      stroke="#e9efd0"
                      strokeWidth="0.65"
                      strokeOpacity="0.65"
                      strokeLinecap="round"
                    />
                    <path d="M -3 -3 Q 0 -8 3 -3" fill="#9f9b64" />
                  </g>
                </g>
              ))}
            </g>
          </svg>
        ),
      )}
    </div>
  );
}
