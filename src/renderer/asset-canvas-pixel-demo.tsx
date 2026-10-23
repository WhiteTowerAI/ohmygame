import type { CanvasImagePreset } from "../shared/canvas-image-presets.js";

const palette: Record<string, string> = {
  d: "#293d39",
  g: "#31766d",
  l: "#8baa78",
  s: "#e8c5a4",
  r: "#bd584c",
  y: "#edc777",
  b: "#8bbfbe",
  w: "#e8dec8",
};

const sprites = {
  "side-view-character": [
    "....ddd.....",
    "...ddddd....",
    "...dsss.....",
    "....sssd....",
    "...rggg.....",
    "..srgggs....",
    "..srgggs....",
    "...rgyg.....",
    "....ggg.....",
    "....d.d.....",
    "...dd.dd....",
    "..ddd.ddd...",
  ],
  "rpg-character": [
    "....dddd....",
    "...dddddd...",
    "...dssssd...",
    "...ssssss...",
    "....ssss....",
    "..srgggrs...",
    "..srgggrs...",
    "..srgggrs...",
    "...rgygr....",
    "....gggg....",
    "....d.dd....",
    "...dd.ddd...",
  ],
  portrait: [
    "...dddddd...",
    "..dddddddd..",
    "..dssssssd..",
    "..ssdssdss..",
    "..ssssssss..",
    "..dssssssd..",
    "..ddssssdd..",
    "...ssyyss...",
    "..rrryyrrr..",
    ".rrrrggrrrr.",
    "rrrrggggrrrr",
    "rrrrggggrrrr",
  ],
  monster: [
    "..g......g..",
    "..gg....gg..",
    "..gggggggg..",
    ".gggggggggg.",
    "gggyyggyyggg",
    "gggdyggydggg",
    "gggggggggggg",
    ".ggllllllgg.",
    ".ggldldllgg.",
    "..gllllllg..",
    "..ggg..ggg..",
    ".gggg..gggg.",
  ],
  animal: [
    ".r....r.....",
    ".rr..rr.....",
    ".rrrrrr.....",
    "rrsrrsrr....",
    "rrsrrsrr....",
    ".rrwwrr.....",
    "..rrrrrr..rw",
    "..rrrrrrrrrw",
    "..rrrrrrrrw.",
    "..rrrrrrrr..",
    "..rr....rr..",
    ".rrr...rrr..",
  ],
  building: [
    ".....rr.....",
    "....rrrr....",
    "...rrrrrr...",
    "..rrrrrrrr..",
    ".rrrrrrrrrr.",
    "rrrrrrrrrrrr",
    ".wwwwwwwwww.",
    ".wbbwggwbbw.",
    ".wbbwggwbbw.",
    ".wwwwggwwww.",
    ".wwwwggwwww.",
    ".dddddddddd.",
  ],
  prop: [
    "......b.....",
    ".....bwb....",
    ".....bwb....",
    ".....bwb....",
    ".....bwb....",
    ".....bwb....",
    ".....bwb....",
    ".....bwb....",
    "..yyyyyyyyy.",
    ".....gg.....",
    ".....gg.....",
    "....yyyy....",
  ],
  icon: [
    "dddddddddddd",
    "dggggggggggd",
    "dggggyyggggd",
    "dggggyyggggd",
    "dggyyyyyyggd",
    "dgyyyyyyyygd",
    "dggyyyyyyggd",
    "dgggyyyygggd",
    "dggyyggyyggd",
    "dggggggggggd",
    "dggggggggggd",
    "dddddddddddd",
  ],
} as const;

function PixelSprite({
  rows,
  x,
  y,
  scale = 2,
}: {
  rows: readonly string[];
  x: number;
  y: number;
  scale?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      {rows.flatMap((row, rowIndex) =>
        [...row].flatMap((color, column) =>
          color === "."
            ? []
            : [
                <rect
                  key={`${rowIndex}-${column}`}
                  x={column}
                  y={rowIndex}
                  width="1"
                  height="1"
                  fill={palette[color]}
                />,
              ],
        ),
      )}
    </g>
  );
}

export function PixelMaterialDemo({ preset }: { preset: CanvasImagePreset }) {
  return (
    <svg viewBox="0 0 68 39" shapeRendering="crispEdges" aria-hidden="true">
      <rect width="68" height="39" fill="#243330" />
      <rect x="2" y="2" width="64" height="35" fill="#d7e4dc" />
      {preset === "character-sheet" ? (
        <>
          <rect x="3" y="3" width="21" height="33" fill="#e8dec8" />
          <PixelSprite rows={sprites["side-view-character"]} x={2} y={7} />
          <rect x="25" y="3" width="16" height="33" fill="#b7d3c3" />
          <PixelSprite rows={sprites.portrait} x={27} y={12} scale={1} />
          {[0, 1, 2].map((index) => (
            <g key={index}>
              <PixelSprite
                rows={sprites.portrait.slice(0, 7)}
                x={43 + index * 7}
                y={7}
                scale={0.5}
              />
              <PixelSprite
                rows={sprites["rpg-character"]}
                x={43 + index * 7}
                y={22}
                scale={0.5}
              />
            </g>
          ))}
        </>
      ) : preset === "scene" ? (
        <>
          <rect x="3" y="3" width="62" height="33" fill="#a2c6c6" />
          <path d="M50 7h6v2h2v5h-2v2h-6v-2h-2V9h2z" fill="#edc777" />
          <path
            d="M3 25h4v-4h4v-4h4v-4h4v4h4v4h4v4h5v-4h4v-4h4v4h4v4h5v4h16v7H3z"
            fill="#779d90"
          />
          <path d="M3 29h9v-3h9v3h13v-3h12v3h19v7H3z" fill="#4a7669" />
          <path d="M29 36v-4h4v-4h4v4h4v4z" fill="#c8aa78" />
          {[8, 49, 57].map((x) => (
            <path
              key={x}
              d={`M${x} 32v-3h-3v-3h2v-3h2v-3h2v3h2v3h2v3h-3v3z`}
              fill="#293d39"
            />
          ))}
        </>
      ) : preset === "terrain" ? (
        <>
          {Array.from({ length: 4 }, (_, row) =>
            Array.from({ length: 8 }, (_, column) => (
              <g key={`${row}-${column}`}>
                <rect
                  x={3 + column * 8}
                  y={3 + row * 8}
                  width="7"
                  height="7"
                  fill={
                    row === 1 ? "#8bbfbe" : column === 3 ? "#c8aa78" : "#8baa78"
                  }
                />
                <path
                  d={`M${4 + column * 8} ${5 + row * 8}h2v1h-2z M${7 + column * 8} ${8 + row * 8}h2v1h-2z`}
                  fill={row === 1 ? "#d7e4dc" : "#517660"}
                />
              </g>
            )),
          )}
        </>
      ) : (
        <PixelSprite
          rows={
            sprites[preset as keyof typeof sprites] ??
            sprites["side-view-character"]
          }
          x={22}
          y={7}
        />
      )}
    </svg>
  );
}
