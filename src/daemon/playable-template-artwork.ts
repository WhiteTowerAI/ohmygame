import path from "node:path";
import type { PlayablePreset } from "./playable-presets.js";

/** Stills from the supplied Last Bus project, resized to 1280 × 720 WebP. */
const PICTURES = {
  blank: "cover",
  "main-menu": "menu",
  choice: "phone",
  qte: "bell",
  hotspot: "cabin",
  ending: "ending",
  "story-map": "store-window",
  "visual-novel": "station",
} as const;

/** Copy a separate illustration on first use and keep the project CSS readable. */
export function withPlayableTemplateArtwork(
  preset: PlayablePreset,
): PlayablePreset {
  const picture = PICTURES[preset.id];
  const file = `shared/templates/lastbus-${picture}.css`;
  const scope = `[data-template-artwork="lastbus-${picture}"]`;
  return {
    ...preset,
    source: (title, id) => {
      const source = preset.source(title, id);
      return {
        ...source,
        html: source.html.replace(
          "<main ",
          `<main data-template-artwork="lastbus-${picture}" `,
        ),
        css: `@import "../../${file}";\n${source.css}`,
      };
    },
    sharedFileCopies: {
      ...preset.sharedFileCopies,
      [`shared/templates/lastbus/${picture}.webp`]: path.join(
        import.meta.dirname,
        "assets/scene-templates",
        `${picture}.webp`,
      ),
    },
    sharedFiles: {
      ...preset.sharedFiles,
      [file]: `/* Last Bus template artwork. Setting a background in the editor replaces it. */
${scope} {
  --letterbox: 0cqw;
}

${scope} .backdrop[data-media="backdrop"]:not([data-asset]) {
  background: linear-gradient(rgb(0 0 0 / 0.18), rgb(0 0 0 / 0.35)),
    url("./lastbus/${picture}.webp") center / cover no-repeat;
}

/* Hide the former placeholder figure or window, including in existing projects. */
${scope} .backdrop[data-media="backdrop"]:not([data-asset])::before {
  display: none;
}
`,
    },
  };
}
