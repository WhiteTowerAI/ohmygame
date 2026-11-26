import type { ReactNode } from "react";

// Each app project type's picture, drawn in code. new-game.css draws every
// shape as a 1.25px outline in the theme's line colour, the weight of the
// app's icons, and tints it with the type's hue on hover; a plugin type's own
// SVG is redrawn the same way by the daemon (plugin-svg.ts). The art sits in
// the right of a 400×200 box, leaving the left foot for the card's words.

/** The types drawn here; others get their plugin's picture or icon. */
export const DRAWN_TYPES = ["web-game", "godot-game", "interactive-story", "general", "asset-canvas"] as const;

export function hasTypeArt(type: string): boolean {
  return (DRAWN_TYPES as readonly string[]).includes(type);
}

/** The drawing a plugin type without art of its own gets. */
export const PLUGIN_TYPE_ART = "plugin";

/**
 * The type's scene. `fit` is "cover" on cards, which share the box's 2:1
 * shape; the dialog's wider banner uses "contain" so nothing is cut off.
 */
export function ProjectTypeArt({ type, fit = "cover" }: { type: string; fit?: "cover" | "contain" }) {
  const scene = SCENES[type];
  if (!scene) return null;
  return (
    <svg className="project-type-art" viewBox="0 0 400 200" preserveAspectRatio={fit === "cover" ? "xMaxYMid slice" : "xMaxYMid meet"} aria-hidden="true" focusable="false">
      {scene}
    </svg>
  );
}

/** A 2:1 isometric block: its top, left and right faces. */
function Block({ x, y, size = 34, height = 14, top = "art-paper", left = "art-mid", right = "art-strong" }: {
  x: number; y: number; size?: number; height?: number; top?: string; left?: string; right?: string;
}) {
  const half = size / 2;
  return <>
    <polygon className={left} points={`${x - size},${y} ${x},${y + half} ${x},${y + half + height} ${x - size},${y + height}`} />
    <polygon className={right} points={`${x + size},${y} ${x},${y + half} ${x},${y + half + height} ${x + size},${y + height}`} />
    <polygon className={top} points={`${x},${y - half} ${x + size},${y} ${x},${y + half} ${x - size},${y}`} />
  </>;
}

const SCENES: Record<string, ReactNode> = {
  // A window holding a puzzle piece: something a plugin adds.
  [PLUGIN_TYPE_ART]: <>
    <g className="art-lift">
      <rect x="206" y="38" width="160" height="116" rx="12" />
      <path d="M206 60h160" />
      <circle cx="220" cy="49" r="3" />
      <circle cx="232" cy="49" r="3" />
      <circle cx="244" cy="49" r="3" />
      <path className="art-hop" d="M264 84h16a9 9 0 1 1 18 0h16v16a9 9 0 1 1 0 18v16h-50z" />
      <path d="M382 34l4 9 10 1.5-7 7 1.7 10-8.7-4.6-8.7 4.6 1.7-10-7-7 10-1.5z" />
    </g>
  </>,
  // A browser window with a small platformer level in it.
  "web-game": <>
    <circle className="art-glow" cx="330" cy="40" r="120" />
    <g className="art-lift">
      <rect className="art-paper art-edge" x="196" y="24" width="186" height="122" rx="12" />
      <path className="art-soft" d="M196 36a12 12 0 0 1 12-12h162a12 12 0 0 1 12 12v10H196z" />
      <circle className="art-mid" cx="211" cy="35" r="3.5" />
      <circle className="art-mid" cx="223" cy="35" r="3.5" />
      <circle className="art-mid" cx="235" cy="35" r="3.5" />
      <rect className="art-paper" x="250" y="29" width="118" height="12" rx="6" />
      <ellipse className="art-soft" cx="240" cy="66" rx="16" ry="6" />
      <ellipse className="art-soft" cx="336" cy="60" rx="13" ry="5" />
      <path className="art-mid" d="M197 124h184v10a11 11 0 0 1-11 11H208a11 11 0 0 1-11-11z" />
      <rect className="art-strong" x="236" y="100" width="50" height="8" rx="4" />
      <rect className="art-strong" x="304" y="78" width="50" height="8" rx="4" />
      <circle className="art-accent" cx="318" cy="64" r="4.5" />
      <circle className="art-accent" cx="333" cy="64" r="4.5" />
      <circle className="art-accent" cx="261" cy="87" r="4.5" />
      <g className="art-hop">
        <rect className="art-ink" x="212" y="106" width="15" height="18" rx="5" />
        <circle className="art-paper" cx="222" cy="112" r="2.2" />
      </g>
    </g>
  </>,
  // A small island of blocks with trees and water: a scene in an engine.
  "godot-game": <>
    <circle className="art-glow" cx="300" cy="60" r="120" />
    <g className="art-lift">
      <Block x={250} y={110} />
      <Block x={284} y={127} />
      <Block x={318} y={144} top="art-accent-soft" left="art-accent-mid" right="art-accent" />
      <Block x={284} y={93} />
      <Block x={318} y={110} />
      <Block x={352} y={127} />
      <Block x={318} y={76} />
      <Block x={352} y={93} />
      <Block x={318} y={56} height={20} />
      <g className="art-hop">
        <polygon className="art-strong" points="250,52 264,96 236,96" />
        <rect className="art-ink" x="247" y="94" width="6" height="12" rx="2" />
      </g>
      <polygon className="art-mid" points="352,68 362,94 342,94" />
      <rect className="art-ink" x="350" y="92" width="4" height="8" rx="1.5" />
    </g>
  </>,
  // Scene cards that branch on a choice and meet again.
  "interactive-story": <>
    <circle className="art-glow" cx="320" cy="100" r="120" />
    <g className="art-lift">
      <path className="art-line" d="M246 100C270 100 270 56 296 56" />
      <path className="art-line" d="M246 100C270 100 270 144 296 144" />
      <path className="art-line" d="M352 56C366 56 366 100 380 100" />
      <path className="art-line art-dash" d="M352 144C366 144 366 100 380 100" />
      <rect className="art-paper art-edge" x="186" y="78" width="60" height="44" rx="8" />
      <rect className="art-mid" x="196" y="90" width="34" height="5" rx="2.5" />
      <rect className="art-soft" x="196" y="100" width="40" height="5" rx="2.5" />
      <rect className="art-soft" x="196" y="110" width="26" height="5" rx="2.5" />
      <rect className="art-paper art-edge" x="296" y="34" width="56" height="44" rx="8" />
      <rect className="art-mid" x="306" y="46" width="30" height="5" rx="2.5" />
      <rect className="art-soft" x="306" y="56" width="36" height="5" rx="2.5" />
      <rect className="art-accent" x="296" y="122" width="56" height="44" rx="8" />
      <rect className="art-paper" x="306" y="134" width="30" height="5" rx="2.5" />
      <rect className="art-paper art-faint" x="306" y="144" width="36" height="5" rx="2.5" />
      <circle className="art-strong art-hop" cx="384" cy="100" r="9" />
    </g>
  </>,
  // A die and a few loose pieces: any kind of game, engine still open.
  general: <>
    <circle className="art-glow" cx="310" cy="80" r="120" />
    <g className="art-lift">
      <rect className="art-soft" x="196" y="128" width="34" height="34" rx="6" transform="rotate(14 213 145)" />
      <circle className="art-strong" cx="214" cy="62" r="18" />
      <circle className="art-paper art-faint" cx="207" cy="55" r="5" />
      <g transform="rotate(-12 290 100)">
        <rect className="art-paper art-edge" x="258" y="68" width="64" height="64" rx="14" />
        <circle className="art-ink" cx="276" cy="86" r="5" />
        <circle className="art-ink" cx="304" cy="86" r="5" />
        <circle className="art-ink" cx="290" cy="100" r="5" />
        <circle className="art-ink" cx="276" cy="114" r="5" />
        <circle className="art-ink" cx="304" cy="114" r="5" />
      </g>
      <path className="art-mid" d="M356 128c0-9 13-9 13 0 0-9 13-9 13 0 0 10-13 18-13 18s-13-8-13-18z" />
      <path className="art-accent art-hop" d="M362 38l6 13 14 2-10 10 2.5 14-12.5-6.6-12.5 6.6 2.5-14-10-10 14-2z" />
    </g>
  </>,
  // An image node wired to a sprite sheet, with a palette: making assets.
  "asset-canvas": <>
    <circle className="art-glow" cx="320" cy="70" r="120" />
    <g className="art-lift">
      <path className="art-line" d="M276 74C296 74 300 118 318 118" />
      <rect className="art-paper art-edge" x="190" y="34" width="86" height="80" rx="8" />
      <rect className="art-sky" x="196" y="40" width="74" height="54" rx="4" />
      <circle className="art-accent" cx="252" cy="56" r="7" />
      <path className="art-strong" d="M196 94l24-28 16 18 12-12 22 22z" />
      <rect className="art-soft" x="196" y="100" width="40" height="6" rx="3" />
      <rect className="art-paper art-edge" x="318" y="96" width="66" height="66" rx="8" />
      <rect className="art-mid" x="326" y="104" width="22" height="22" rx="4" />
      <rect className="art-strong" x="354" y="104" width="22" height="22" rx="4" />
      <rect className="art-accent" x="326" y="132" width="22" height="22" rx="4" />
      <rect className="art-soft" x="354" y="132" width="22" height="22" rx="4" />
      <g className="art-hop">
        <circle className="art-paper art-edge" cx="350" cy="52" r="20" />
        <circle className="art-accent" cx="343" cy="45" r="4" />
        <circle className="art-strong" cx="356" cy="44" r="4" />
        <circle className="art-mid" cx="358" cy="57" r="4" />
        <circle className="art-ink" cx="343" cy="59" r="3" />
      </g>
    </g>
  </>,
};
