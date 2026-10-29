export const GLOBAL_PIXEL_ART_STYLE_REQUIREMENTS = `**GLOBAL PIXEL ART STYLE REQUIREMENTS**

Create authentic low-resolution 2D game pixel art, designed natively on the selected logical pixel grid rather than as a high-resolution illustration with a pixelation filter.

Use uniformly sized square pixels, deliberate pixel clusters, stepped contours, readable silhouettes, and crisp hard-edged shading. The selected density controls logical dimensions, palette, shading depth, and retained detail. Do not apply a different density's rules.

**REFERENCE DESIGN, NOT REFERENCE RENDERING**

Use references to identify the requested subject, silhouette, proportions, major structures, primary colors, and identity-defining features. Preserve pose, camera angle, or composition only where the task explicitly requires them. With no reference, follow the user's subject description.

Rebuild the rendering on the selected pixel grid, even when the reference is already pixel art. Do not inherit the reference's pixel density, shading complexity, texture frequency, or amount of decoration. Map essential reference colors into the selected palette. Keep identity-defining features recognizable at that density; merge or omit details that cannot be represented clearly.

For related assets, views, or animation frames, maintain consistent pixel scale, palette, shading depth, and subject identity. Enlarged portraits and close-ups use the same logical pixel scale and selected detail budget; additional space does not authorize a finer rendering style.

Strictly avoid smooth illustration, photorealism, 3D rendering, anti-aliasing, gradients, blurred edges, vector linework, photographic texture, random speckling, and inconsistent pixel sizes. Small deliberate clusters are allowed when they form readable details at the selected density.`;

export const PIXEL_ART_LEVELS = ["coarse", "classic", "detailed"] as const;
export type PixelArtLevel = (typeof PIXEL_ART_LEVELS)[number];
type PixelArtAssetType =
  | "character"
  | "creature"
  | "environment"
  | "terrain"
  | "object"
  | "animation"
  | "subject";
type PixelArtGrid = {
  columns: number;
  rows: number;
  unit: "frame" | "panel" | "tile" | "sprite" | "view";
};

const PIXEL_ART_LEVEL_SETTINGS = {
  coarse: {
    sprite: 32,
    scene: 96,
    tile: 16,
    colors: 8,
    style:
      "Use oversized square pixels, broad color masses, and only essential structural shapes. Use 1–2 hard-edged tones per major material. Omit secondary ornament and surface texture, including when the reference already uses fine pixels.",
  },
  classic: {
    sprite: 64,
    scene: 160,
    tile: 32,
    colors: 16,
    style:
      "Use a classic 16-bit game grid with medium square pixels and compact clusters. Use 2–3 hard-edged tones per major material. Actively remove secondary detail, even from an already pixelated reference. Merge repeated patterns into a few readable marks. Do not reproduce a fine-pixel design with merely larger pixel blocks.",
  },
  detailed: {
    sprite: 192,
    scene: 480,
    tile: 128,
    colors: 48,
    style:
      "Use a finer low-resolution grid with small but clearly square pixels. Use 4–6 hard-edged tones per major material within the shared palette. Retain controlled secondary shapes and readable material accents. Add detail inside forms without smoothing contours or scattering isolated pixels. Do not simplify this density to coarse shapes.",
  },
} satisfies Record<
  PixelArtLevel,
  { sprite: number; scene: number; tile: number; colors: number; style: string }
>;

const SUBJECT_DETAILS: Record<PixelArtLevel, string> = {
  coarse:
    "Reduce the subject to its essential silhouette, primary color masses, and a few identity marks. Omit intricate ornament and texture. For faces, if present, use single dark eye marks without irises or highlights and group hair or fur into broad masses.",
  classic:
    "Preserve main structural shapes and essential identity marks; merge repeated decoration into a few compact clusters. For faces, if present, use simple eye clusters and a few major hair or fur groups; omit shaded irises and multiple glints.",
  detailed:
    "Retain selected secondary structures, markings, seams, or highlights as readable clusters; omit only detail too small for this grid. For faces, if present, retain selected hair or fur locks and compact eye highlights.",
};

const ASSET_DETAILS: Record<
  Exclude<PixelArtAssetType, "subject" | "animation">,
  Record<PixelArtLevel, string>
> = {
  character: {
    coarse:
      "Group hair into broad masses. Render each eye as one solid dark mark with no iris or highlight. Omit embroidery, chains, seams, and filigree; preserve main costume shapes and essential equipment.",
    classic:
      "Group hair into roughly 3–5 major locks where applicable. Use simple eye clusters without separate iris shading or multiple glints. Reduce embroidery, chains, filigree, and trim to a few identity-defining marks. Close-ups must not reintroduce engraving or ornament omitted from the main design.",
    detailed:
      "Preserve selected hair locks, compact facial features and eye highlights, small armor divisions, seams, and accessory structure as crisp clusters. Keep these details consistent across portraits, views, and expressions.",
  },
  creature: {
    coarse:
      "Preserve species, anatomy, limbs, and distinctive markings through broad patches. Omit individual hairs, repeated scales, feathers, and shell ornament.",
    classic:
      "Preserve species, anatomy, limbs, and distinctive markings. Group fur, scales, feathers, and shell patterns into broad readable patches; omit individual hairs, repeated scales, and tiny surface marks.",
    detailed:
      "Preserve species, anatomy, limbs, and distinctive markings. Retain selected fur tufts, scale groups, feathers, or shell divisions as readable clusters rather than rendering every repeated surface element.",
  },
  environment: {
    coarse:
      "Preserve composition, perspective, major terrain boundaries, architecture, paths, and entrances. Use broad terrain and canopy masses with almost no surface pattern. Keep doors, tile edges, corners, and transitions readable.",
    classic:
      "Preserve composition, perspective, major terrain boundaries, architecture, paths, and entrances. Merge foliage, masonry, and terrain texture into sparse clusters. Omit individual leaves, dense grass blades, tiny bricks, and repeated surface noise. Keep tile edges, corners, and transitions readable and compatible.",
    detailed:
      "Preserve composition, perspective, architecture, paths, and entrances. Add selected masonry divisions, foliage groups, terrain texture, and material highlights within the logical grid. Keep tile edges, corners, and transitions compatible; do not add photographic micro-texture.",
  },
  terrain: {
    coarse:
      "Take biome, materials, and primary colors from any reference; do not copy its composition, camera angle, framing, or feature placement. Use broad terrain masses with almost no surface pattern. Keep material boundaries, tile edges, corners, and transitions readable.",
    classic:
      "Take biome, materials, and primary colors from any reference; do not copy its composition, camera angle, framing, or feature placement. Merge foliage, rock, and ground texture into sparse clusters. Omit individual leaves, dense grass blades, tiny bricks, and repeated surface noise. Keep tile edges, corners, and transitions readable and compatible.",
    detailed:
      "Take biome, materials, and primary colors from any reference; do not copy its composition, camera angle, framing, or feature placement. Add selected rock divisions, foliage groups, ground texture, and material highlights within the logical grid. Keep tile edges, corners, and transitions compatible; do not add photographic micro-texture.",
  },
  object: {
    coarse:
      "Preserve functional silhouette, openings, handles, and essential symbols. Omit engraving, multiple reflections, and tiny ornament. Use solid readable shapes, including in close-ups.",
    classic:
      "Preserve functional silhouette, openings, handles, edges, and identity-defining symbols. Merge engraving, gems, reflections, and ornament into a few compact marks. Icons must remain recognizable at small display sizes; close-ups keep the same simplified design.",
    detailed:
      "Preserve functional silhouette and structure. Retain selected engraving, facets, mechanisms, and material highlights as crisp readable clusters. Keep icon symbols clear and maintain the same object design in close-ups.",
  },
};

export function withPixelArtLevel(
  prompt: string,
  level: PixelArtLevel,
  kind: "sprite" | "scene" | "tile" = "sprite",
  options?: {
    assetType?: PixelArtAssetType | readonly PixelArtAssetType[];
    grid?: PixelArtGrid;
    referenceSheet?: boolean;
  },
): string {
  const settings = PIXEL_ART_LEVEL_SETTINGS[level];
  const size = settings[kind];
  const grid = options?.grid;
  const dimensions = options?.referenceSheet
    ? `Design the entire 16:9 reference sheet on a ${size * 4}×${(size * 9) / 4} logical pixel canvas. Full-body views each fit within a ${size}×${size} logical sprite budget; the main portrait can occupy more logical area, using the same pixel scale and detail budget.`
    : grid
      ? `Default logical size per ${grid.unit}: ${size}×${size} pixels. With ${grid.columns} columns and ${grid.rows} rows, the complete sheet is ${size * grid.columns}×${size * grid.rows} logical pixels. These dimensions describe each cell and the complete sheet separately.`
      : `Design this single asset on a ${size}×${size} logical ${kind} canvas. If the requested composition uses another aspect ratio, expand the logical canvas to fit it while preserving square pixels and this subject detail budget.`;
  const sizeOverride =
    kind === "tile"
      ? "An explicit user tile size or atlas layout overrides these defaults. Recalculate the complete logical atlas from that tile size and layout; do not enforce the default dimensions at the same time."
      : "";
  const assetTypes =
    typeof options?.assetType === "string"
      ? [options.assetType]
      : (options?.assetType ?? []);
  const assetDetail = assetTypes
    .map((type) => {
      const detail =
        type === "subject"
          ? SUBJECT_DETAILS[level]
          : type === "animation"
            ? `${SUBJECT_DETAILS[level]} Apply the same detail choices to the supplied subject in every frame, whether it is a person, creature, or object. Spend the budget on readable motion, not changing texture or ornament.`
            : ASSET_DETAILS[type][level];
      return `${type.toUpperCase()} DETAIL BUDGET: ${detail}`;
    })
    .join("\n\n");
  const title =
    level === "coarse"
      ? "COARSE PIXELS"
      : level === "detailed"
        ? "DETAILED PIXELS"
        : "CLASSIC PIXELS";
  const instruction = `**PIXEL DENSITY: ${title}**\n\n${dimensions}${sizeOverride ? ` ${sizeOverride}` : ""}\n\n${settings.style} Pixel construction takes priority over detail reduction: keep visible square-pixel clusters and stair-step contours on outer silhouettes, diagonals, curves, and internal color boundaries at this density. Simplified shapes must still be built from pixels; do not turn them into smooth flat vector shapes. Fine detail must also remain visibly pixel-built. Use no more than ${settings.colors} colors across all artwork in the full output, plus one plain background color or transparency. Reuse the palette across every view and frame.\n\nLogical dimensions are design targets, not provider output dimensions. Enlarge the complete composition using one uniform nearest-neighbor scale. Derive visible block size from the complete logical canvas and actual output size, never from a fixed output-width example. Preserve square pixels; if the output aspect ratio differs, leave plain margins rather than stretching pixels or adding detail.${assetDetail ? `\n\n${assetDetail}` : ""}`;
  const firstSection = prompt.indexOf("\n\n");
  return firstSection < 0
    ? `${instruction}\n\n${prompt}`
    : `${prompt.slice(0, firstSection)}\n\n${instruction}\n\n${prompt.slice(firstSection + 2)}`;
}

export function withCharacterPixelArtLevel(
  prompt: string,
  level: PixelArtLevel,
): string {
  return withPixelArtLevel(prompt, level, "sprite", {
    assetType: "character",
    referenceSheet: true,
  });
}

export const PIXEL_SPRITE_SEQUENCE_REQUIREMENTS = `**SPRITE PIXEL BUDGET**

Design every complete animation cell at the specified per-frame logical size. Build the complete sheet from those cells before uniform nearest-neighbor enlargement. A larger provider output must show larger square pixel blocks, never additional detail between logical pixels. Keep the layout grid invisible.

Use one shared palette and shading depth from the selected density across every frame. Preserve essential reference hues by mapping them into this palette. Keep every contour and interior feature on the same logical grid.

First establish the subject design at the selected density, then animate that design. Preserve the same simplified or detailed features in every frame. Recognizable identity comes from the hairstyle or head silhouette, main costume shapes, primary color blocks, body proportions, and essential equipment or species traits. Keep only a few defining symbols or markings; simplify or omit secondary accessories, facial micro-detail, trim, and texture according to the selected density. Reference identity does not require preserving decoration that exceeds the selected density. Use the same retained features in every frame rather than adding omitted details back during motion. Keep motion readable and do not change texture or ornament between frames.`;

export function withGlobalPixelStyle(
  prompt: string,
  style = GLOBAL_PIXEL_ART_STYLE_REQUIREMENTS,
): string {
  return prompt.includes(style) ? prompt : `${style}\n\n${prompt}`;
}

/** Keep the editable request above the shared style and production instructions. */
export function pixelPromptWithRequest(
  label: string,
  request: string,
  instructions: string,
  fallback = "Follow the supplied reference and the asset requirements below.",
): string {
  return `${label}: ${request.trim() || fallback}\n\n${withGlobalPixelStyle(instructions)}`;
}
