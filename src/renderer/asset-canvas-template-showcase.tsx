import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import type {
  CanvasImagePreset,
} from "../shared/canvas-image-presets.js";
import { PixelMaterialDemo } from "./asset-canvas-pixel-demo.js";

export function TemplateDemo({
  template,
  preset = "character-sheet",
}: {
  template: AssetCanvasTemplate;
  preset?: CanvasImagePreset;
}) {
  if (template === "pixel-art") return <PixelMaterialDemo preset={preset === "character-sheet" ? "side-view-character" : preset} />;
  if (template === "character-sheet" || template === "quick-reskin") return <FreeImagePresetDemo preset={template} />;
  if (template === "free-sequence" && preset === "consistent-sequence")
    return (
      <svg viewBox="0 0 680 390" aria-hidden="true">
        <rect width="680" height="390" fill="#26312e" />
        {Array.from({ length: 9 }, (_, index) => {
          const column = index % 3,
            row = Math.floor(index / 3);
          const x = 24 + column * 220,
            y = 20 + row * 120;
          return (
            <g key={index}>
              <rect
                x={x}
                y={y}
                width="208"
                height="108"
                rx="3"
                fill={["#d7e5d4", "#d7ded0", "#dddbc9"][index % 3]}
              />
              <circle cx={x + 167} cy={y + 28} r="13" fill="#efcf8a" />
              <path
                d={`M${x} ${y + 86} l48 -38 34 29 43 -30 83 43 v18 h-208z`}
                fill={["#6e9a86", "#78968f", "#8a9b77"][row]}
              />
              <DemoCharacter
                x={x + 74}
                y={y + 6}
                scale={0.9}
                pose={index % 6}
              />
            </g>
          );
        })}
      </svg>
    );
  if (template === "free-sequence")
    return (
      <svg viewBox="0 0 680 390" aria-hidden="true">
        <rect width="680" height="390" fill="#26312e" />
        {Array.from({ length: 12 }, (_, index) => {
          const column = index % 4,
            row = Math.floor(index / 4);
          return (
            <g key={index}>
              <rect
                x={25 + column * 164}
                y={20 + row * 118}
                width="151"
                height="107"
                rx="3"
                fill={(row + column) % 2 ? "#e0e4d8" : "#cee0d5"}
              />
              <DemoCharacter
                x={65 + column * 164}
                y={25 + row * 118}
                scale={0.95}
                pose={index % 6}
              />
            </g>
          );
        })}
      </svg>
    );
  return (
    <svg viewBox="0 0 680 390" aria-hidden="true">
      <rect width="680" height="390" fill="#26312e" />
      {Array.from({ length: 6 }, (_, index) => {
        const column = index % 3,
          row = Math.floor(index / 3);
        return (
          <g key={index}>
            <rect
              x={24 + column * 220}
              y={22 + row * 178}
              width="207"
              height="165"
              rx="3"
              fill={index % 2 ? "#e6dac6" : "#d5e5dc"}
            />
            <DemoCharacter
              x={46 + column * 220}
              y={41 + row * 178}
              scale={1.08}
              pose={index}
            />
            <DemoCharacter
              x={124 + column * 220}
              y={41 + row * 178}
              scale={1.08}
              pose={(index + 1) % 6}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function FreeImagePresetDemo({ preset }: { preset: CanvasImagePreset }) {
  if (preset === "quick-reskin")
    return (
      <svg viewBox="0 0 680 390" aria-hidden="true">
        <rect width="680" height="390" fill="#1f2927" />
        <rect x="24" y="24" width="290" height="342" rx="4" fill="#d8e8dc" />
        <rect x="366" y="24" width="290" height="342" rx="4" fill="#e8d8bd" />
        <DemoCharacter x={82} y={67} scale={2.5} pose={0} />
        <DemoCharacter
          x={424}
          y={67}
          scale={2.5}
          pose={0}
          coatColor="#773f48"
          shirtColor="#3d5057"
          trimColor="#edc777"
        />
        <path
          d="M326 186h25m-9-9 9 9-9 9"
          fill="none"
          stroke="#e8dec8"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (preset === "character-sheet")
    return (
      <svg viewBox="0 0 680 390" aria-hidden="true">
        <rect width="680" height="390" fill="#1f2927" />
        <rect x="24" y="25" width="237" height="306" rx="4" fill="#d8e8dc" />
        <rect x="272" y="25" width="170" height="306" rx="4" fill="#b7d3c3" />
        <rect x="453" y="25" width="203" height="145" rx="4" fill="#e8d8bd" />
        <rect x="453" y="181" width="203" height="150" rx="4" fill="#d1d9d0" />
        <DemoCharacter x={74} y={64} scale={2.15} pose={0} />
        <DemoCharacter x={309} y={77} scale={1.5} pose={1} />
        {[0, 1, 2].map((index) => (
          <DemoCharacter
            key={index}
            x={466 + index * 61}
            y={53}
            scale={0.76}
            pose={index}
          />
        ))}
        {[0, 1, 2].map((index) => (
          <DemoCharacter
            key={index}
            x={466 + index * 61}
            y={207}
            scale={0.76}
            pose={index + 3}
          />
        ))}
      </svg>
    );
  return (
    <svg viewBox="0 0 680 390" aria-hidden="true">
      <rect width="680" height="390" fill="#243330" />
      <rect x="25" y="22" width="630" height="346" rx="4" fill="#d7e4dc" />
      {preset === "side-view-character" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#e9ddc9" />
          <ellipse cx="335" cy="320" rx="121" ry="15" fill="#acbbae" />
          <path
            d="M248 161 L320 147 L364 171 L376 252 L271 261 Z"
            fill="#bd584c"
          />
          <path d="M275 169 L355 167 L350 250 L275 250 Z" fill="#31766d" />
          <path
            d="M287 249 L321 249 L301 321 L271 321 Z M332 248 L359 249 L379 321 L347 321 Z"
            fill="#334c47"
          />
          <path d="M272 172 L238 223 L259 234 L302 186 Z" fill="#e7bc91" />
          <path
            d="M339 91 Q393 90 396 138 L379 168 L316 159 L316 111 Z"
            fill="#e7bc91"
          />
          <path
            d="M332 97 Q357 70 390 92 L409 123 L379 125 L363 108 L331 124 Z"
            fill="#293d39"
          />
          <circle cx="385" cy="134" r="3" fill="#293d39" />
        </g>
      )}
      {preset === "rpg-character" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#a2c3a9" />
          {Array.from({ length: 6 }, (_, row) =>
            Array.from({ length: 10 }, (_, column) => (
              <rect
                key={`${row}-${column}`}
                x={44 + column * 59}
                y={41 + row * 51}
                width="56"
                height="48"
                fill={(row + column) % 2 ? "#b5ceb0" : "#a5bfa4"}
              />
            )),
          )}
          <ellipse
            cx="340"
            cy="292"
            rx="92"
            ry="24"
            fill="#517660"
            opacity=".3"
          />
          <path
            d="M274 192 L331 170 L392 192 L403 260 L282 260 Z"
            fill="#bd5b4c"
          />
          <path
            d="M301 247 L333 247 L323 296 L292 297 Z M350 246 L379 246 L387 295 L355 295 Z"
            fill="#354840"
          />
          <ellipse cx="339" cy="142" rx="69" ry="62" fill="#e9c29c" />
          <path
            d="M274 137 Q265 64 339 64 Q412 67 409 137 L375 112 L303 112 Z"
            fill="#34453f"
          />
          <path
            d="M277 185 L241 232 L260 249 L301 204 Z M394 187 L428 230 L411 250 L376 207 Z"
            fill="#e5bd97"
          />
        </g>
      )}
      {preset === "portrait" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#c3d7cc" />
          <path
            d="M148 350 Q168 241 330 229 Q519 226 543 350 Z"
            fill="#bd574c"
          />
          <path
            d="M264 260 L338 315 L414 260 L383 350 L293 350 Z"
            fill="#e1ab68"
          />
          <ellipse cx="338" cy="170" rx="109" ry="120" fill="#e8c5a4" />
          <path
            d="M223 146 Q213 26 332 28 Q455 26 452 171 L417 130 L399 91 Q346 132 245 117 Z"
            fill="#2b403b"
          />
          <path
            d="M231 144 Q198 233 254 279 L287 262 L258 141 Z M444 140 Q480 237 422 278 L391 259 L422 147 Z"
            fill="#2b403b"
          />
          <circle cx="295" cy="173" r="5" fill="#2b403b" />
          <circle cx="383" cy="173" r="5" fill="#2b403b" />
          <path
            d="M313 224 Q340 237 365 224"
            fill="none"
            stroke="#a86b5d"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>
      )}
      {preset === "monster" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#becdb6" />
          <ellipse cx="340" cy="315" rx="144" ry="18" fill="#95aa9b" />
          <path
            d="M212 299 Q175 245 227 161 L205 91 L265 128 Q336 88 412 132 L470 91 L449 169 Q498 258 457 300 Z"
            fill="#577c70"
          />
          <path
            d="M236 295 Q259 238 340 238 Q427 238 447 295 Z"
            fill="#7fa494"
          />
          <ellipse cx="282" cy="208" rx="22" ry="25" fill="#f1dcaa" />
          <ellipse cx="398" cy="208" rx="22" ry="25" fill="#f1dcaa" />
          <circle cx="288" cy="210" r="7" fill="#253a36" />
          <circle cx="393" cy="210" r="7" fill="#253a36" />
          <path
            d="M302 260 L316 274 L334 261 L351 275 L369 261 L389 274"
            fill="none"
            stroke="#2d4840"
            strokeWidth="8"
          />
        </g>
      )}
      {preset === "animal" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#d8dfce" />
          <ellipse cx="335" cy="318" rx="156" ry="15" fill="#abbcae" />
          <path
            d="M210 264 Q224 204 327 198 Q396 199 448 258 L421 297 L252 298 Z"
            fill="#c96e4e"
          />
          <path
            d="M421 263 Q513 180 563 216 Q524 291 439 297 Z"
            fill="#c96e4e"
          />
          <path
            d="M489 254 Q526 230 556 218 Q529 275 460 289 Z"
            fill="#f0d4ac"
          />
          <path
            d="M216 222 L199 128 L256 167 L319 151 L349 229 Z"
            fill="#c96e4e"
          />
          <path
            d="M199 128 L245 180 L223 189 Z M271 158 L332 114 L319 187 Z"
            fill="#f0d4ac"
          />
          <path d="M217 253 L239 287 L293 278 L309 250 Z" fill="#f0d4ac" />
          <circle cx="243" cy="213" r="6" fill="#263a35" />
          <circle cx="213" cy="247" r="5" fill="#263a35" />
          <path
            d="M282 281 L278 321 L305 321 L316 282 Z M392 278 L397 321 L425 321 L425 276 Z"
            fill="#a85842"
          />
        </g>
      )}
      {preset === "scene" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#a2c6c6" />
          <circle cx="510" cy="107" r="35" fill="#efd39a" />
          <path
            d="M42 244 L198 90 L302 236 L424 121 L638 247 L638 350 L42 350 Z"
            fill="#779d90"
          />
          <path
            d="M42 272 L169 179 L301 264 L469 176 L638 281 L638 350 L42 350 Z"
            fill="#4a7669"
          />
          <path
            d="M42 311 Q162 273 251 304 Q360 248 455 293 Q555 270 638 305 L638 350 L42 350 Z"
            fill="#2d534b"
          />
          <path d="M245 350 Q316 294 371 350" fill="#c9aa78" />
          <path
            d="M96 304 L121 236 L146 304 Z M489 304 L521 217 L557 304 Z"
            fill="#29483e"
          />
        </g>
      )}
      {preset === "terrain" && (
        <g>
          {Array.from({ length: 5 }, (_, row) =>
            Array.from({ length: 8 }, (_, column) => {
              const x = 42 + column * 74.5,
                y = 39 + row * 62.2;
              return (
                <g key={`${row}-${column}`}>
                  <rect
                    x={x}
                    y={y}
                    width="74.5"
                    height="62.2"
                    fill={
                      (row + column) % 5 === 0
                        ? "#8db9b5"
                        : (row + column) % 3 === 0
                          ? "#c8aa78"
                          : "#8baa78"
                    }
                  />
                  <path
                    d={`M${x + 8} ${y + 13} l10 4 m33 24 l10 -3`}
                    stroke="#5f845f"
                    strokeWidth="4"
                  />
                </g>
              );
            }),
          )}
        </g>
      )}
      {preset === "building" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#d5e1d3" />
          <ellipse cx="341" cy="322" rx="212" ry="19" fill="#b7c7b5" />
          <path
            d="M149 155 L344 53 L534 155 L510 188 L344 94 L173 188 Z"
            fill="#924e48"
          />
          <rect x="177" y="156" width="331" height="163" fill="#d4ad7c" />
          <path
            d="M177 197 H508 M177 247 H508 M245 156 V319 M432 156 V319"
            stroke="#b58c64"
            strokeWidth="5"
          />
          <rect x="295" y="218" width="91" height="101" fill="#4d736c" />
          <rect x="214" y="203" width="54" height="52" fill="#8bbfbe" />
          <rect x="416" y="203" width="54" height="52" fill="#8bbfbe" />
          <path
            d="M241 203 V255 M214 229 H268 M443 203 V255 M416 229 H470"
            stroke="#e2d2ae"
            strokeWidth="6"
          />
        </g>
      )}
      {preset === "prop" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#e8dec8" />
          <ellipse cx="341" cy="318" rx="105" ry="13" fill="#c6c5b7" />
          <path
            d="M325 259 L307 90 L340 50 L371 91 L356 259 Z"
            fill="#b3c9c3"
          />
          <path d="M340 51 L340 262" stroke="#e9efdc" strokeWidth="10" />
          <path
            d="M250 254 Q340 276 430 254 L421 279 Q341 299 259 279 Z"
            fill="#bd8a56"
          />
          <rect x="329" y="278" width="23" height="60" fill="#385c56" />
          <rect x="306" y="331" width="68" height="13" rx="4" fill="#bd8a56" />
        </g>
      )}
      {preset === "icon" && (
        <g>
          <rect x="42" y="39" width="596" height="311" fill="#d8e4dc" />
          <rect
            x="205"
            y="48"
            width="270"
            height="294"
            rx="28"
            fill="#355c57"
          />
          <rect
            x="220"
            y="62"
            width="240"
            height="266"
            rx="20"
            fill="#517e70"
          />
          <path
            d="M336 104 L362 165 L428 176 L380 220 L392 287 L336 254 L278 287 L291 220 L243 176 L309 165 Z"
            fill="#f1c977"
          />
          <path
            d="M336 131 L351 176 L399 183"
            fill="none"
            stroke="#f7e1a2"
            strokeWidth="7"
          />
        </g>
      )}
    </svg>
  );
}

function DemoCharacter({
  x,
  y,
  scale,
  pose,
  coatColor = "#c65c4d",
  shirtColor = "#2d786c",
  trimColor = "#d6aa68",
}: {
  x: number;
  y: number;
  scale: number;
  pose: number;
  coatColor?: string;
  shirtColor?: string;
  trimColor?: string;
}) {
  const step = (pose % 3) - 1;
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="34" cy="100" rx="25" ry="4" fill="#335b50" opacity=".25" />
      <path d={`M26 69 L${20 - step * 4} 94 L28 96 L36 72 Z`} fill="#344641" />
      <path d={`M40 69 L${46 + step * 5} 94 L54 96 L49 68 Z`} fill="#344641" />
      <path
        d="M17 38 L10 78 L23 82 L34 69 L48 82 L59 75 L52 38 Z"
        fill={coatColor}
      />
      <path d="M20 39 L49 39 L52 71 L18 71 Z" fill={shirtColor} />
      <path d="M23 55 L48 55 L46 62 L22 62 Z" fill={trimColor} />
      <path
        d={`M19 42 L${6 + step * 3} ${61 - step * 6} L11 66 L27 52 Z`}
        fill="#e5c3a0"
      />
      <path
        d={`M48 42 L${61 + step * 4} ${59 - step * 8} L58 65 L41 52 Z`}
        fill="#e5c3a0"
      />
      {pose === 3 ? (
        <path d="M61 51 L79 16 L82 18 L65 56 Z" fill="#d9d7bd" />
      ) : null}
      <rect x="24" y="22" width="22" height="22" rx="8" fill="#e8c8a7" />
      <path d="M21 28 Q18 7 37 9 Q54 8 49 31 L44 21 L28 21 Z" fill="#283b38" />
      <path d="M23 31 L18 45 L27 42 L29 29 Z" fill="#283b38" />
      <circle cx="40" cy="32" r="1.6" fill="#233833" />
      <path d="M30 41 L48 41 L55 47 L24 47 Z" fill="#eabf72" />
    </g>
  );
}
