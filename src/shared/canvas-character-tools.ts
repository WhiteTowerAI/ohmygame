import type {
  AssetCanvasDocument,
  ImageModel,
  ImageResolution,
} from "./contracts.js";
import { PIXEL_SPRITE_SEQUENCE_REQUIREMENTS, pixelPromptWithRequest, withGlobalPixelStyle, withPixelArtLevel, withCharacterPixelArtLevel, type PixelArtLevel } from "./canvas-pixel-style.js";

export function preferredCharacterSheetOption(
  model?: ImageModel,
  resolution?: ImageResolution,
): ImageModel["generationOptions"][number] | undefined {
  return model?.generationOptions.slice().sort((a, b) => {
    const aspect = (ratio: string) => {
      const [width, height] = ratio.split(":").map(Number);
      return width! / height!;
    };
    return (
      Math.abs(Math.log(aspect(a.aspectRatio) / (16 / 9))) -
      Math.abs(Math.log(aspect(b.aspectRatio) / (16 / 9))) ||
      Number(b.resolution === resolution) -
        Number(a.resolution === resolution) ||
      Number(b.resolution === "1K") - Number(a.resolution === "1K")
    );
  })[0];
}

export function characterAssetPrompt(description: string, pixelLevel: PixelArtLevel = "classic"): string {
  const prompt = description.trim();
  const newPrefix =
    "Create a production-oriented 2D pixel art game character reference sheet based on the following description:";
  const previousPrefix =
    "Create a production-ready 2D game character reference sheet from this description:";
  if (prompt.includes("**GLOBAL PIXEL ART STYLE REQUIREMENTS**") || prompt.startsWith(newPrefix) || prompt.startsWith(previousPrefix)) return prompt;
  const oldPrefix =
    "Create a production-ready 2D game character asset from this description:";
  const subject = prompt.startsWith(oldPrefix)
    ? prompt
        .slice(oldPrefix.length)
        .split("\n\nShow exactly one full-body character")[0]!
        .trim()
    : prompt;
  const character = subject;
  const coarse = pixelLevel === "coarse";
  const wording = coarse
    ? {
        identity: "Preserve the character's recognizable identity while simplifying visual complexity into chunky square pixels, strong silhouettes, and clean color clusters.",
        portrait: "Render the portrait with clearly visible square pixels, simplified facial shading, grouped hair clusters, and broad color regions.",
        portraitAvoid: "Avoid smooth anime rendering, intricate hair strands, realistic skin shading, and excessively detailed costume textures.",
        turnaround: "Use simplified retro game sprite anatomy with strong silhouettes and minimal surface details.",
        expressions: "Use minimal, deliberate pixel clusters to communicate each expression.",
        equipment: "Use simplified pixel shapes, clean silhouettes, and minimal shading.",
        portraitDensity: "Allow the main portrait to contain more facial information than the smaller full-body sprites, while preserving the same coarse pixel construction and color palette.",
        reference: "Simplify intricate reference details to match authentic low-resolution pixel art.",
        avoid: "High-resolution anime illustration, smooth digital painting, photorealism, 3D rendering, soft gradients, anti-aliasing, intricate hair strands, excessive costume details, inconsistent pixel scales, character identity drift, mismatched outfits, cropped turnaround figures, repeated redundant portraits, extra characters, and cluttered layouts.",
        finalStyle: "All elements must represent the same recognizable character in authentic, chunky, low-resolution retro pixel art.",
        priority: "Prioritize character consistency, clear production reference value, simplified pixel construction, and readable game asset design over illustration-level detail.",
      }
    : pixelLevel === "classic" ? {
        identity: "Preserve the character's identity through silhouette, primary colors, main costume shapes, and essential equipment. Actively simplify the source design into classic game pixels, including when the reference is already detailed pixel art.",
        portrait: "Build the portrait from medium square-pixel clusters, roughly 3–5 main hair locks where applicable, simple eye clusters, and 2–3 hard-edged tones per material.",
        portraitAvoid: "Omit separate iris shading, multiple eye glints, fine hair strands, dense embroidery, chains, and filigree. Reduce identity-defining ornaments to a few readable symbols rather than reproducing their intricate construction.",
        turnaround: "Use compact, readable game sprite anatomy. Keep costume masses and essential equipment, with the same simplified decoration in every view.",
        expressions: "Communicate expressions through a few eye, eyebrow, and mouth clusters. Do not add fine facial rendering to make the expressions distinct.",
        equipment: "Show simplified structural shapes and a few identity-defining marks. Close-ups must not reintroduce engraving, stitch patterns, or fine ornament removed from the main character.",
        portraitDensity: "The larger portrait may show more facial information than the full-body views, but it must keep the same classic pixel size, limited shading, and simplified costume design.",
        reference: "Use the reference only for character design. Rebuild it at classic density even if it already uses fine pixels; omit nonessential detail instead of preserving the source's rendering complexity.",
        avoid: "Fine-pixel ornament, shaded irises, multiple eye glints, individual hair strands, dense costume patterns, smooth illustration, anti-aliasing, gradients, inconsistent pixel sizes, identity drift, changed outfits, cropped turnaround figures, repeated redundant portraits, extra characters, and cluttered layouts.",
        finalStyle: "All components must show the same recognizable character with visibly simplified classic-pixel construction, medium clusters, and a compact palette.",
        priority: "Prioritize recognizable identity and deliberate detail reduction. Classic output must visibly omit secondary detail that a fine-pixel version could retain, rather than merely making the source's pixels larger.",
      } : {
        identity: "Preserve the character's recognizable identity using square pixels at the selected density, strong silhouettes, and deliberate color clusters. The density instructions determine how large the clusters are and how much interior detail to retain.",
        portrait: "Render the portrait with clearly visible square pixels, clustered facial shading, grouped hair shapes, and controlled color regions appropriate to the selected density.",
        portraitAvoid: "Avoid smooth anime rendering, airbrushed skin, and photographic costume textures. Convert hair and material detail into crisp clusters at the selected density.",
        turnaround: "Use readable retro game sprite anatomy with strong silhouettes and surface detail appropriate to the selected density.",
        expressions: "Use deliberate pixel clusters sized to the selected density to communicate each expression.",
        equipment: "Use clean pixel shapes and silhouettes with shading depth appropriate to the selected density.",
        portraitDensity: "Allow the main portrait to contain more facial information than the smaller full-body sprites, while preserving the same selected pixel density and color palette.",
        reference: "Translate reference details into the selected pixel density. Coarse pixels omit small features; fine pixels retain controlled details as crisp clusters.",
        avoid: "High-resolution anime illustration, smooth digital painting, photorealism, 3D rendering, soft gradients, anti-aliasing, hair drawn as smooth individual lines, photographic material textures, inconsistent pixel scales, character identity drift, mismatched outfits, cropped turnaround figures, repeated redundant portraits, extra characters, and cluttered layouts.",
        finalStyle: "All elements must represent the same recognizable character in authentic low-resolution retro pixel art, with a visibly consistent square-pixel size at the selected density.",
        priority: "Prioritize character consistency, clear production reference value, and readable pixel construction over blended illustration rendering. Follow the selected density for the amount of detail to retain.",
      };
  return pixelPromptWithRequest("CHARACTER DESCRIPTION", character, `${newPrefix}

**PRIMARY OBJECTIVE**

Create a professional 16:9 character reference sheet in authentic low-resolution retro pixel art style.

The sheet must look like a collection of hand-crafted pixel game assets, not high-resolution anime concept art converted through a pixelation filter.

${wording.identity}

**MANDATORY REFERENCE SHEET LAYOUT**

Use a clean, organized 16:9 horizontal composition with a clear visual hierarchy:

Character reference → Main character portrait → Turnaround views → Expressions → Equipment details.

**LEFT SECTION — MAIN CHARACTER PORTRAIT**

Place one large upper-body character portrait on the left, occupying approximately 45–50% of the sheet.

Make this the largest and most visually prominent element.

Use a clear front or three-quarter view with an expressive, recognizable face.

Show the character's defining hairstyle, facial features, clothing, armor, and important accessories.

${wording.portrait}

${wording.portraitAvoid}

**RIGHT SECTION — CHARACTER TURNAROUND**

Arrange three smaller full-body character views on the right:

1. Front view.
2. Side view.
3. Back view.

Show the complete character from head to feet in every view.

Keep all three figures at the same scale, with consistent body proportions, main clothing shapes, essential equipment, and primary color blocks. Reuse the same density-appropriate simplifications in each view.

Use consistent alignment and a shared baseline.

Maintain the same character identity across all views.

${wording.turnaround}

Do not switch the character's main outfit, hairstyle silhouette, essential equipment, or body proportions between views. Secondary detail may be merged or omitted according to the selected density.

**RIGHT SECTION — FACIAL EXPRESSIONS**

Include a compact group of three distinct facial expressions featuring the same character.

Use clearly different expressions appropriate to the character's personality.

Keep the same facial proportions, hairstyle, eye color, and recognizable features.

${wording.expressions}

Avoid smooth facial illustration or excessive detail.

**RIGHT SECTION — EQUIPMENT AND COSTUME DETAILS**

Include a small selection of useful pixel art close-ups showing important costume elements, accessories, or equipment.

Choose details based on the supplied character description.

Show only meaningful design features that help maintain character consistency.

${wording.equipment}

Avoid unrelated objects or redundant decorative details.

${wording.portraitDensity}

**STRICT CHARACTER CONSISTENCY**

All views must depict exactly the same character.

Keep the same recognizable design through:
- Hairstyle or head silhouette and primary hair color.
- Body proportions and main silhouette.
- Main clothing or armor shapes and primary color blocks.
- Essential equipment and a few identity-defining symbols or markings.

Character consistency does not require reproducing every facial detail, accessory, seam, or decorative pattern. Merge or omit secondary details according to the selected density, then reuse those same choices across all views, expressions, and close-ups. Do not add omitted details back to make a close-up more elaborate.

Only change the viewing angle, facial expression, or level of detail appropriate to each reference component.

Do not introduce alternate main costumes, replace essential equipment, or introduce unrelated character variations. Simplifying secondary accessories does not count as changing character identity.

**REFERENCE INTERPRETATION**

If reference images are supplied, use them to preserve the character's identity, design, silhouette, outfit, and essential color relationships.

Treat reference images as design sources rather than rendering targets.

${wording.reference}

Follow the requested design theme while keeping the selected density's pixel construction, shading, and detail budget authoritative.

Do not reproduce smooth illustration textures or high-resolution rendering from the reference.

**BACKGROUND AND PRESENTATION**

Use a simple, neutral, unobtrusive background suitable for a professional game asset reference sheet.

Keep the layout clean and organized with sufficient spacing between all elements.

Maintain clear visual separation between the main portrait, turnaround views, expressions, and equipment details.

Ensure every full-body view remains complete and readable.

Do not add decorative frames, text, labels, captions, watermarks, or unrelated scenery.

**STRICTLY AVOID**

${wording.avoid}

**FINAL REQUIREMENT**

Produce one professional 16:9 pixel art character reference sheet featuring:

- One large upper-body character portrait on the left.
- Three consistent full-body turnaround views on the right.
- Three distinct facial expressions.
- A few useful costume or equipment detail references.

${wording.finalStyle}

${wording.priority}`);
}

export function continuousActionsPrompt(action: string, pixelLevel: PixelArtLevel = "classic"): string {
  return withPixelArtLevel(pixelPromptWithRequest("Requested action", action, `${PIXEL_SPRITE_SEQUENCE_REQUIREMENTS}

Use the supplied image as the character design reference, preserving identity and essential colors while simplifying rendering detail. Create one sprite sheet showing 12 successive frames of the character performing the requested action specified above, arranged in exactly 4 columns and 3 rows, read left to right.

Keep the subject recognizable through its hairstyle or head silhouette, main costume shapes, primary color blocks, essential equipment or species traits, and body proportions. Simplify secondary accessories and facial detail according to the selected density and reuse those choices in every frame. Keep the mapped palette and camera angle consistent.

Fill the entire image canvas with 12 equal-sized cells, with no outer margins or padding. Place one complete subject in each cell at a constant scale. Fit the largest pose within approximately 80% of the cell height, leaving room for motion.

Use a fixed camera and a consistent ground baseline as the coordinate reference. For stationary gestures, keep the supporting body and planted feet anchored. For jumping, crouching, rolling, or falling, allow the body and feet to move as required by that action. Never independently recenter, crop, or rescale poses to fit each cell.

Animate one complete requested action across 12 successive frames, using a consistent full-body view throughout. End in the appropriate final pose. Connect the last frame to the first only for an inherently repeating action; do not force an attack or fall to loop.

Keep every character and moving body part inside its own cell. Use a uniform plain background matching the reference, with no visible grid lines, white separators, borders, gutters, labels, or extra characters.`, "{USER_ACTION}"), pixelLevel, "sprite", { assetType: "animation", grid: { columns: 4, rows: 3, unit: "frame" } });
}

export function resolveContinuousActionPrompt(template: string, action: string): string {
  const description = action.trim();
  if (!description) throw new Error("Enter an action description before generating");
  const placeholder = template.includes("{USER_ACTION}") ? "{USER_ACTION}" : "the action described by the user";
  return template.includes(placeholder)
    ? template.replace(placeholder, () => description)
    : `${template}\n\nRequested action: ${description}`;
}

const ACTION_SHEET_PROMPTS = {
  idle: `Use the supplied image as the character design reference, not as a frozen pose or a rendering-density target. Create one sprite sheet showing exactly 12 successive frames of one clearly animated idle breathing cycle in a 3-row by 4-column grid, read left to right, top to bottom.

Keep the same recognizable hairstyle or head silhouette, main outfit shapes, primary color blocks, essential equipment, body proportions, scale, and camera angle in every frame. Reuse the selected density's retained features; do not reproduce every facial detail or secondary accessory. Keep both feet planted in the same position. Lock each foot's contact pixels to the same local coordinates inside every cell. Keep the pelvis at the same horizontal coordinate. Allow the upper body to move vertically through knee flexion and breathing; do not lock the entire body into one pose.

Show a clearly visible, continuous idle movement rather than 12 nearly identical standing poses. At a 64-pixel logical character height, move the shoulders and head through an approximately 3–4 logical pixel vertical range; scale this range proportionally for other sprite sizes. Change the arms, elbows, chest silhouette, and clothing in response. Do not use changes in color or tiny facial details as a substitute for body motion.

Use these chronological phases: frame 1 neutral; frames 2–3 progressively bend the knees and lower the shoulders; frame 4 deepest compression; frames 5–6 rise through neutral; frames 7–8 straighten and lift the chest and shoulders to the highest point; frames 9–11 lower naturally toward neutral; frame 12 just before the starting pose. Make the last frame transition smoothly to the first without duplicating the first frame. The character must not walk, travel, or drift sideways.

Use authentic low-resolution game pixel art. The grid is an invisible layout only: do not draw any grid lines, white dividers, borders, gaps, labels, checkerboard patterns, or extra characters.`,
  walk: `Use the supplied image as the character design reference. Preserve identity and essential colors while simplifying rendering detail.

Create ONE sprite sheet showing 12 successive frames of the character performing ONE complete natural FORWARD WALKING cycle in place, arranged in a 3-row by 4-column grid, read left to right, top to bottom.

Keep the same recognizable hairstyle or head silhouette, main outfit shapes, primary color blocks, essential equipment, body proportions, scale, and camera angle in every frame. Reuse the selected density's retained features; do not reproduce every facial detail or secondary accessory.

CRITICAL FIXED CHARACTER POSITION:
Keep the character's head, torso, and hips in exactly the same screen position in every frame, as if all 12 frames were drawn on one fixed game sprite canvas.
The character must NOT gradually shift left or right between frames.
Do not independently center the full silhouette of each pose.
Keep the main body at the same position within each cell while the legs and arms animate around it.
Maintain the same character size and baseline in all 12 frames.
When the frames are overlaid, the torso and hips should remain aligned.
The character walks IN PLACE while visually facing and walking toward SCREEN-RIGHT.

Use equal-sized cells, the same plain background color as the reference image, and no visible grid lines, labels, or extra characters.

WALKING MECHANICS:
Create a complete natural forward walking cycle with two alternating steps.
The NEAR-SIDE leg leads during the first half and the FAR-SIDE leg leads during the second half.
Keep both legs anatomically consistent, with the same near/far identity in every frame.

During each foot's planted phase, that foot moves gradually from SCREEN-RIGHT to SCREEN-LEFT relative to the stationary torso.
During its swing phase, that foot lifts, bends beneath the hips, and moves from SCREEN-LEFT toward SCREEN-RIGHT to prepare for the next step.

F01: Near-side foot contacts the ground in front, far-side foot trails behind.
F02: Weight shifts onto the near-side foot; far-side heel lifts.
F03: Far-side knee bends and moves beneath the body.
F04: Far-side leg passes close beside the near-side supporting leg, with the lifted foot beneath the hips.
F05: Far-side leg swings forward toward screen-right; near-side heel rises.
F06: Far-side foot reaches forward toward landing.

F07: Far-side foot contacts the ground in front, near-side foot trails behind.
F08: Weight shifts onto the far-side foot; near-side heel lifts.
F09: Near-side knee bends and moves beneath the body.
F10: Near-side leg passes close beside the far-side supporting leg, with the lifted foot beneath the hips.
F11: Near-side leg swings forward toward screen-right; far-side heel rises.
F12: Near-side foot reaches forward toward landing, smoothly returning to F01.

MOTION REQUIREMENTS:
Both legs must alternate naturally.
Include two distinct passing poses with the legs close together.
At least one foot remains grounded at every moment, including F06 and F12 while the opposite foot prepares to land.
Arms swing opposite the legs.
No backward walking, moonwalking, shuffling, repeated poses, hopping, or jumping.
No whole-body horizontal drifting or sliding across the cells.
Do not mirror the whole character or duplicate the first six frames in the second half.
Make frame 12 transition smoothly into frame 1 without duplicating the first frame.

PIXEL ART STYLE:
Render genuine low-resolution 2D game sprite pixel art.
Use a square-pixel grid at the selected density, deliberate pixel clusters, stepped hard outlines, and its matching color budget.
Render armor, hair, and cloth detail at the selected density: broad shapes for coarse pixels, compact clusters for classic pixels, and finer deliberate clusters for fine pixels.
Preserve the character identity and colors, but NOT the reference's smooth illustration rendering.
No anti-aliasing, gradients, blurry edges, fine realistic textures, or smooth digital painting.

OUTPUT:
Exactly one static 4-column by 3-row sprite sheet with 12 chronological frames.
Every frame must have the same fixed body position, character scale, ground baseline, and background color.`,
  run: `Use the supplied image as the character design reference. Preserve identity and essential colors while simplifying rendering detail.

Create ONE static sprite sheet containing exactly 12 successive animation frames, arranged in a 3-row by 4-column grid, read left to right, top to bottom.

Keep the same recognizable hairstyle or head silhouette, main outfit shapes, primary color blocks, essential equipment, body proportions, character scale, and camera angle in every frame. Reuse the selected density's retained features; do not reproduce every facial detail, armor decoration, or secondary accessory.

Use 12 equal-sized cells, consistent character proportions, the same plain background color as the reference image, and no visible grid lines, labels, text, or extra characters.

PIXEL ART STYLE:
Render genuine low-resolution 2D game sprite pixel art with clear square pixels, intentional pixel clusters, stepped hard outlines, the selected color budget, and density-appropriate shading.
Preserve the reference character's identity and colors, but do not copy smooth illustration rendering or fine realistic textures.
No anti-aliasing, gradients, blurry edges, high-frequency details, or smooth digital painting.
Keep the same pixel size and rendering style across all twelve frames.

ANIMATION:
Create one complete natural FORWARD RUNNING cycle in place. The character faces and runs toward SCREEN-RIGHT.

CRITICAL FIXED CHARACTER POSITION:
Keep the character's torso and hips in approximately the same horizontal position within every cell, as if drawn on one fixed game sprite canvas.
Allow natural small vertical bouncing and forward body lean.
Do not shift the whole character horizontally between frames.
Do not independently center or resize the full silhouette.

RUNNING MECHANICS:
The NEAR-SIDE leg leads in the first half; the FAR-SIDE leg leads in the second half.
Keep both legs anatomically consistent, with the same near/far identity in every frame.
A supporting foot moves from SCREEN-RIGHT to SCREEN-LEFT relative to the torso during stance.
The recovering leg bends sharply, its heel folds toward the buttocks, then the knee passes beneath the hips and swings toward SCREEN-RIGHT.
Include brief low flight phases, not exaggerated jumps.
Alternate single-leg support with flight; do not show both feet grounded together.
Arms swing opposite the legs, with bent elbows and a stronger drive than walking.

FRAME SEQUENCE:
F01: NEAR-SIDE foot lands in front; FAR-SIDE leg trails behind.
F02: NEAR-SIDE knee compresses and absorbs the landing; FAR-SIDE heel folds upward.
F03: NEAR-SIDE foot pushes backward; FAR-SIDE bent knee passes beneath the hips.
F04: NEAR-SIDE foot leaves the ground; FAR-SIDE knee drives forward.
F05: Brief low flight; FAR-SIDE leg extends forward toward landing.
F06: FAR-SIDE foot descends; NEAR-SIDE leg folds into recovery.
F07: FAR-SIDE foot lands in front; NEAR-SIDE leg trails behind.
F08: FAR-SIDE knee compresses; NEAR-SIDE heel folds upward.
F09: FAR-SIDE foot pushes backward; NEAR-SIDE bent knee passes beneath the hips.
F10: FAR-SIDE foot leaves the ground; NEAR-SIDE knee drives forward.
F11: Brief low flight; NEAR-SIDE leg extends forward toward landing.
F12: NEAR-SIDE foot descends, naturally connecting to F01.

F01 and F07 must show opposite landing legs.
F03 and F09 must show clear knee-passing poses.
F02 and F08 must show grounded weight absorption.
During flight, both feet are above the fixed ground baseline.
Do not create repeated wide-stride poses, moonwalking, excessive jumping, or missing leg recovery.
Do not mirror the whole character or duplicate the first six frames in the second half.
Make F12 transition smoothly into F01 without duplicating the first frame.

OUTPUT:
Exactly one static 4-column by 3-row sprite sheet containing 12 chronological frames.`,
  attack: `Use the supplied image as the character design reference, preserving identity and essential colors while simplifying rendering detail. Create one sprite sheet showing 12 successive frames of the character performing one complete attack, arranged in a 3-row by 4-column grid, read left to right, top to bottom. Keep the same recognizable hairstyle or head silhouette, main outfit shapes, primary color blocks, essential equipment, body proportions, scale, and camera angle in every frame. Reuse the selected density's retained features; do not reproduce every facial detail or secondary accessory. Show a natural chronological progression from preparation through the attack to recovery, with smooth transitions between consecutive frames. Keep the entire character, weapon, and any attack effects fully contained within their respective cells, without extending into adjacent cells. Render as authentic low-resolution game pixel art with clearly visible square pixels, clean pixel clusters, and the selected density's shading depth and retained details rather than smooth illustration rendering. Use equal-sized cells, consistent baselines, a plain background matching the reference, and no labels, borders, checkerboard patterns, or extra characters. Do not loop the last frame to the first.`,
  hurt: `Use the supplied image as the character design reference, preserving identity and essential colors while simplifying rendering detail. Create one sprite sheet showing 12 successive frames of the character reacting to a hit, arranged in a 3-row by 4-column grid, read left to right, top to bottom. Keep the same recognizable hairstyle or head silhouette, main outfit shapes, primary color blocks, essential equipment, body proportions, scale, and camera angle in every frame. Reuse the selected density's retained features; do not reproduce every facial detail or secondary accessory. Show one natural, continuous hit reaction from the initial impact through recoil and recovery, with smooth transitions between consecutive frames. Keep the entire character, clothing, and equipment fully contained within their respective cells, without extending into adjacent cells. Maintain a stable overall character scale and consistent ground reference while allowing natural body recoil. Render as authentic low-resolution game pixel art with clearly visible square pixels, clean pixel clusters, and the selected density's shading depth and retained details rather than smooth illustration rendering. Use equal-sized cells, a plain background matching the reference, and no labels, borders, checkerboard patterns, or extra characters. Do not loop the last frame to the first.`,
  down: `Use the supplied image as the character design reference, preserving identity and essential colors while simplifying rendering detail. Create one sprite sheet showing 12 successive frames of the character falling to the ground, arranged in a 3-row by 4-column grid, read left to right, top to bottom. Keep the same recognizable hairstyle or head silhouette, main outfit shapes, primary color blocks, essential equipment, body proportions, scale, and camera angle in every frame. Reuse the selected density's retained features; do not reproduce every facial detail or secondary accessory. Show one continuous progression from standing through losing balance and falling to a final lying-down pose, with natural transitions between consecutive frames. Maintain consistent character proportions and scale as the body changes orientation. Keep the entire body, hair, clothing, and equipment fully contained within each respective cell, including the final horizontal pose, without extending into adjacent cells. Render as authentic low-resolution game pixel art with clearly visible square pixels, clean pixel clusters, and the selected density's shading depth and retained details rather than smooth illustration rendering. Use equal-sized cells, a consistent ground reference, a plain background matching the reference, and no labels, borders, checkerboard patterns, or extra characters. The character remains on the ground in the final frame; do not loop the last frame to the first.`,
} as const;

export function actionSheetPrompt(
  action: "idle" | "walk" | "run" | "attack" | "hurt" | "down",
  description = "",
  pixelLevel: PixelArtLevel = "classic",
): string {
  const prompt = `${PIXEL_SPRITE_SEQUENCE_REQUIREMENTS}

${ACTION_SHEET_PROMPTS[action]}

FRAME REGISTRATION FOR GRID SPLITTING
Fill the entire canvas with exactly 4 columns and 3 rows of equal-sized rectangular cells, with no outer margins, padding, gutters, or visible separators. Keep one complete character and all moving parts inside each cell. Use a single fixed camera and constant character scale; never auto-center, crop, zoom, or rescale individual poses. Fix the ground baseline at 90% of each cell height and the pelvis horizontal anchor at 50% of each cell width. Fit the tallest pose within approximately 80% of the cell height and preserve that scale across all 12 frames, leaving room for motion. Anchor to the body and ground, not the changing silhouette's bounding-box center. Use a uniform plain background matching the reference. These frame numbers describe motion only; do not draw text, labels, grid lines, borders, or extra characters.`;
  const result = description.trim()
    ? pixelPromptWithRequest("Additional direction", description, prompt, "")
    : withGlobalPixelStyle(prompt);
  return withPixelArtLevel(result, pixelLevel, "sprite", { assetType: "animation", grid: { columns: 4, rows: 3, unit: "frame" } });
}

export function allActionsPrompt(actions: string, pixelLevel: PixelArtLevel = "classic"): string {
  return withPixelArtLevel(pixelPromptWithRequest("Requested actions", actions, `Use the supplied image as the subject design reference. Create one 3-row by 3-column sprite sheet of nine distinct full-body action poses for this subject. If fewer than nine actions are specified, add useful game actions. Keep the subject recognizable through its head silhouette, main costume shapes, primary color blocks, essential equipment or species traits, and body proportions. Simplify secondary accessories and facial detail according to the selected density and reuse those choices in every cell. Keep the mapped palette, camera angle, and selected pixel density consistent. Show one complete subject per equal-sized cell, with a consistent scale and baseline and a plain uniform background. Do not add text, labels, borders, extra characters, or unrelated objects.`), pixelLevel, "sprite", { assetType: "animation", grid: { columns: 3, rows: 3, unit: "frame" } });
}

export function normalizeLegacyCharacterModes(
  canvas: AssetCanvasDocument,
): AssetCanvasDocument {
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.type !== "image" || !node.data.generationMode) return node;
      const { generationMode, ...data } = node.data;
      const prompt =
        generationMode === "character-asset"
          ? withCharacterPixelArtLevel(characterAssetPrompt(data.prompt, data.pixelStyle ?? "classic"), data.pixelStyle ?? "classic")
          : generationMode === "continuous-actions"
            ? continuousActionsPrompt(data.prompt, data.pixelStyle ?? "classic")
            : allActionsPrompt(data.prompt, data.pixelStyle ?? "classic");
      return { ...node, data: { ...data, prompt, promptExpanded: true } };
    }),
  };
}
