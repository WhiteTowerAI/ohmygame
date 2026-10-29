import {
  pixelPromptWithRequest,
  withPixelArtLevel,
  type PixelArtLevel,
} from "./canvas-pixel-style.js";

// Pixel material templates; logical pixel sizes describe the design target.
export const PIXEL_MATERIAL_PROMPTS = {
  monster: `Create a complete low-resolution pixel art MONSTER reference and combat action sheet for a 2D video game, based on the provided reference image and user description.

USER REQUEST: {user_prompt}

**MANDATORY ASSET TYPE: MONSTER**

Generate exactly one distinctive monster or creature design shown across multiple viewing angles and gameplay actions.

The subject must remain the requested monster species or creature type.

Do not reinterpret the monster as an ordinary human character, generic armored warrior, or realistic animal.

Allow humanoid, quadrupedal, winged, serpentine, skeletal, mechanical, amorphous, or other anatomically appropriate monster forms.

**MONSTER VISUAL IDENTITY**

Monsters must look visually threatening, unnatural, and dangerous — never domesticated, cute, or naturalistic.

Exaggerate at least two to three threatening physical features appropriate to the monster type, such as:
- Oversized claws, talons, or crushing limbs.
- Prominent fangs, tusks, or a distorted jaw.
- Horns, bone spurs, spikes, or blade-like protrusions.
- Multiple eyes, hollow eye sockets, or glowing pupils.
- Unnatural body proportions: bloated torso, elongated neck, asymmetric limbs.
- Exposed bone, necrotic flesh, corrupted plating, or toxic markings.

Use an intimidating primary silhouette: bulky and hunched, unnaturally elongated, or asymmetrically threatening. Avoid round, symmetrical, or compact silhouettes that read as friendly or animal-like.

Use a dark or desaturated primary palette with one to two vivid accent colors that signal danger, such as blood red, toxic green, sickly purple, or bioluminescent orange.

If the reference shows a realistic animal, reinterpret it into a monstrous game creature: distort proportions, add supernatural features, and apply an aggressive color treatment. Do not copy the animal directly.

**PRIMARY OBJECTIVE**

Create a professional retro pixel art monster sprite reference sheet featuring consistent creature design, multiple views, and meaningful combat actions.

The result must resemble genuine low-resolution game sprites rather than detailed fantasy concept illustrations.

**REFERENCE FIDELITY**

Preserve the creature's defining anatomy, silhouette, proportions, colors, distinctive body parts, and recognizable features.

Treat the reference as a creature design concept rather than a rendering target.

Simplify intricate textures, surface patterns, fur, scales, armor, and other details while retaining the monster's identity.

**SHEET STRUCTURE**

Organize the sheet into four clearly separated horizontal sections.

Section 1 — Monster Turnaround:
Show four views of the same monster:
- Front view.
- Side view.
- Back view.
- Opposite side or three-quarter view.

Section 2 — Movement:
Show four sequential movement poses appropriate to the creature's anatomy.

Use walking, running, crawling, flying, slithering, floating, or another suitable movement type.

Section 3 — Combat:
Show four distinct combat-related poses that communicate a threatening, aggressive monster:
- Alert or combat-ready: hunched, tense, visibly dangerous.
- Attack preparation: winding up a claw swipe, bite lunge, tail slam, energy charge, or other anatomy-appropriate attack.
- Attack execution: peak of the attack with maximum limb extension, open jaw, or discharged ability — make this pose unmistakably aggressive.
- Attack recovery or follow-through: returning to a dominant combat stance, not a neutral or relaxed pose.

Choose the attack type based on the creature's anatomy: melee claws or bites for physical monsters, projectile or aura attacks for magical or elemental monsters, charge or trample for large quadrupeds.

Every combat pose must reinforce the monster's threatening nature. Avoid neutral, relaxed, or friendly-looking stances in this section.

Section 4 — Reactions:
Show four gameplay reaction poses:
- Taking damage.
- Staggering or knockback.
- Defeated or collapsing.
- Final defeated or resting state.

**STRICT CREATURE CONSISTENCY**

All views and poses must depict the same monster.

Keep consistent anatomy, species traits, primary color blocks, essential equipment, and a few defining markings. Simplify secondary markings, armor decoration, and texture according to the selected density, then reuse the retained features in every view and pose.

Maintain consistent scale and body proportions across comparable poses.

Do not add or remove limbs, horns, wings, tails, or equipment between frames unless explicitly required by the action.

Use the per-sprite logical size in the density instructions. Arrange four sprites per row in each of the four sections, for a 4-column by 4-row sheet.

**GAMEPLAY ACTION READABILITY**

Every action must communicate a distinct gameplay state.

Movement poses must show meaningful changes in body position and locomotion.

Combat poses must clearly communicate preparation, execution, and recovery.

Damage and defeat poses must be visibly different from idle or movement poses.

Maintain a recognizable monster silhouette throughout the sequence.

**LAYOUT AND OUTPUT**

Arrange the sprites in a clean, evenly spaced grid.

Show complete, uncropped sprites with consistent spacing.

Use a transparent background where supported.

Do not include text, labels, decorative frames, scenery, UI elements, unrelated creatures, or additional characters.

Avoid overlapping sprites or inconsistent cell sizes.

**STRICTLY AVOID**

Ordinary human character substitution, generic humanoid anatomy when inappropriate, high-resolution fantasy illustration, intricate textures, inconsistent pixel scales, duplicate poses, random extra limbs, changing creature designs, smooth gradients, anti-aliasing, and cluttered compositions.

Do not produce a naturalistic or realistic animal. Do not use friendly, rounded, or domesticated silhouettes. Do not apply pastel or warm neutral palettes without a clear threatening accent. If the result could be mistaken for a normal animal sprite, redesign the silhouette and color scheme to be clearly monstrous.

**FINAL REQUIREMENT**

Produce one coherent low-resolution pixel art monster reference and combat sheet containing multiple viewing angles, movement poses, aggressive combat actions, and damage or defeat states.

Prioritize monster identity, intimidating visual design, anatomy consistency, readable gameplay actions, and authentic retro pixel construction. The finished sheet must be immediately distinguishable from an animal sprite sheet.`,
  "side-view-character": `Create exactly one full-body GAME CHARACTER sprite for a 2D video game, using the provided reference image as a character design reference. The selected density determines the rendering style.

USER REQUEST: {user_prompt}

MANDATORY ASSET TYPE: GAME CHARACTER SPRITE
The output must be a playable character, NPC, or other game character matching the user's description. Preserve the requested species, role, identity, costume, equipment, and personality. Do not turn the character into a monster unless explicitly requested. The character may be human, fantasy, robotic, or another type specified by the user.

REFERENCE INTERPRETATION
Treat the reference as a character design concept, not a high-resolution rendering target. Preserve recognizable silhouette, hairstyle or head design, clothing shapes, primary colors, essential equipment, and distinctive accessories. Translate material and costume detail to the selected density; retain controlled small details in fine pixels.

LOGICAL SPRITE SIZE
Use the logical pixel size specified by the selected density.

CHARACTER DESIGN AND READABILITY
Show one complete full-body character in a side-on view suitable for a side-scrolling game, unless the user explicitly requests another perspective. Use a clear standing or idle pose unless the user requests a different action. Make the head, torso, arms, legs, and important equipment readable. Match facial and costume detail to the selected density: coarse is minimal, classic is compact, and fine may include small deliberate accents.

COMPOSITION AND OUTPUT
Center the complete character, including head, feet, and essential equipment, with a small safety margin. Use a genuinely transparent background where supported. No unrelated characters, monsters, scenery, UI, text, or decorative background.

STRICTLY AVOID
Unrequested monster transformations, portraits or cropped busts instead of full-body sprites, high-resolution character illustrations, intricate textures, photorealism, 3D rendering, smooth anime painting, anti-aliasing, gradients, mixed pixel scales, and blurry edges.

FINAL TARGET
An unmistakable full-body GAME CHARACTER sprite with clear identity, readable costume, and square pixels at the selected density.`,
  tileset: `Create an authentic low-resolution pixel art TERRAIN TILESET for a 2D video game, based on the provided reference image and user description.

USER REQUEST: {user_prompt}

MANDATORY ASSET TYPE: TERRAIN TILESET
Generate a collection of grid-aligned, square terrain tiles for map construction, not a continuous landscape illustration, decorative collage, or complete gameplay scene.

REFERENCE INTERPRETATION
Use the reference to understand the requested terrain materials, environmental identity, perspective, color relationships, and important shapes. Preserve the user's intended biome and palette; never impose fixed grass, dirt, stone, dark-fantasy, or other colors. Simplify intricate textures into readable low-resolution pixel patterns.

TILE DIMENSIONS AND GRID
Use the default logical tile size and atlas dimensions from the density instructions unless the user specifies another tile size or layout. All cells must have identical square dimensions and aligned boundaries. No gaps, labels, decorative borders, overlapping cells, or irregular margins.

TILE FUNCTION AND CONNECTIVITY
Create meaningful base tiles, edge tiles, corners, and transitions as appropriate to the requested terrain and layout. Keep related tiles compatible in palette, lighting, texture rhythm, and edge geometry. Repeating tiles should have compatible opposite edges. Transition tiles should connect logically to intended neighbors. Do not invent arbitrary fragments merely to fill the atlas.

PERSPECTIVE AND OUTPUT
Follow the user's requested perspective; otherwise use orthographic top-down. Never mix perspectives. Output only the organized terrain tileset, without characters, buildings, text, UI, or unrelated scenery.

STRICTLY AVOID
A single continuous map instead of tiles, decorative sprite-sheet mockups, mismatched tile sizes, inconsistent boundaries, high-detail pixel illustration, dark or monochrome palettes unless requested, smooth painting, and tiny noisy textures.

FINAL TARGET
A coherent, grid-aligned terrain tile atlas with pixel size and detail matched to the selected density. Exact tile size and seamless connectivity must be checked programmatically after generation.`,
  terrain: `Create authentic low-resolution pixel art TERRAIN for a 2D video game, using the provided reference image and user description.

USER REQUEST: {user_prompt}

MANDATORY ASSET TYPE: CONTINUOUS TERRAIN
Generate one cohesive terrain area or ground surface, not a tile atlas, sprite sheet, inventory grid, or isolated character/object.

REFERENCE INTERPRETATION
Use the reference to understand the environment, terrain structure, material identity, perspective, composition, and key visual characteristics. Preserve the user's requested terrain and color relationships without imposing any predetermined biome, palette, or lighting mood. Treat the reference as a design concept, not a detailed texture to copy.

TERRAIN COMPOSITION
Create a continuous, visually coherent area with clear material relationships and natural transitions where appropriate. Add rocks, vegetation, debris, water, structures, or other features only if they belong to the requested environment. Avoid clutter and keep the terrain readable at game scale. Follow the user's specified perspective; otherwise use consistent orthographic top-down.

GAME READABILITY
Prioritize strong terrain shapes, clear material boundaries, and low-resolution visual clarity. Keep pixel density consistent. Do not try to preserve every small detail from the reference.

OUTPUT
Fill the requested terrain area without visible atlas grid lines, tile borders, labels, UI, or decorative presentation elements. Do not introduce unrelated characters or buildings.

STRICTLY AVOID
Tileset atlases when not requested, predetermined green/brown/gray palettes, black-dominated or monochrome palettes unless requested, high-resolution pixel illustration, realistic micro-textures, noisy detail, gradients, anti-aliasing, mixed pixel scales, and blurry edges.

FINAL TARGET
A continuous, expressive retro pixel-art terrain area with visibly discrete square pixels at the selected density and a palette determined by the user's actual request.`,
  building: `Create a complete pixel art game building based on the provided reference image and user description.

USER REQUEST: {user_prompt}

Preserve the reference building's defining architecture, structure, roof shape, doors, windows, materials, and colors unless the user requests changes.

Use the requested game perspective, or an RPG-friendly three-quarter view when no perspective is specified. Maintain consistent structural proportions, readable entrances, coherent wall and roof geometry, and unified lighting.

Show the complete building without cropping. Use a transparent background for isolated building assets where supported. Avoid smooth architectural illustration, photorealistic materials, inconsistent perspective, floating components, and unnecessary scenery.`,
  prop: `Create a complete low-resolution pixel art ITEM or EQUIPMENT reference sheet for a 2D video game, based on the provided reference image and user description.

USER REQUEST: {user_prompt}

**MANDATORY ASSET TYPE: ITEM OR EQUIPMENT**

Generate exactly one requested item or equipment design shown through multiple useful views and relevant states.

The subject may be a weapon, armor piece, shield, potion, tool, container, collectible, accessory, or another game item specified by the user.

Do not generate a full character wearing or holding the item unless explicitly requested.

**PRIMARY OBJECTIVE**

Create a professional retro pixel art item reference sheet containing consistent multi-angle views, useful detail references, and relevant functional states.

The result must resemble authentic low-resolution 2D game assets rather than detailed product illustrations.

**REFERENCE FIDELITY**

Preserve the item's defining silhouette, proportions, materials, colors, structure, and recognizable features.

Treat the reference image as a design source rather than a rendering target.

Simplify intricate surface textures, decorations, engravings, and realistic reflections.

Maintain the same item identity across every view.

**SHEET STRUCTURE**

Organize the output into three horizontal sections with four views per row, making a 4-column by 3-row sheet.

Section 1 — Main Item Views:
Show four useful viewing angles of the same item.

Choose front, side, back, top, or three-quarter views according to the item's geometry and intended game usage.

Avoid redundant angles that reveal no meaningful structural differences.

Section 2 — Detail References:
Show four simplified close-ups of important item components.

Choose relevant structural details such as handles, blades, edges, fasteners, mechanisms, materials, openings, or distinctive decorations.

Do not invent unrelated components.

Section 3 — Functional States:
Show four relevant item states or variations appropriate to the requested item.

Examples may include:
- Closed and opened.
- Equipped and unequipped.
- Inactive and activated.
- Intact and damaged.
- Empty and filled.
- Idle and in-use.

Select states based on the item's actual function.

If the item has no meaningful alternate states, show additional useful structural views rather than inventing arbitrary transformations.

**STRICT ITEM CONSISTENCY**

All views and states must represent the same item design.

Preserve consistent geometry, proportions, colors, materials, and distinctive features.

Do not change the item into a different weapon, tool, container, or equipment type.

Maintain coherent structure across all angles.

**GAME ASSET READABILITY**

Keep the item's silhouette recognizable at small game display sizes.

Emphasize functional shape and distinctive design features.

Avoid unnecessary detail that reduces clarity at low resolution.

**LAYOUT AND OUTPUT**

Arrange the item references in a clean, evenly spaced grid.

Keep every view complete and clearly separated.

Use a transparent background where supported.

Do not include text, labels, decorative frames, unrelated objects, scenery, or additional characters.

**STRICTLY AVOID**

Full character illustrations, unrelated equipment, photorealistic materials, high-resolution product rendering, smooth gradients, anti-aliasing, excessive micro-details, inconsistent geometry, changing item identity, and cluttered layouts.

**FINAL REQUIREMENT**

Produce one coherent low-resolution pixel art item reference sheet featuring multiple viewing angles, useful structural details, and relevant functional states.

Prioritize item identity, clear geometry, consistent pixel construction, and practical game asset readability.`,
  icon: `Create a highly readable pixel art game UI icon based on the provided reference image and user description.

USER REQUEST: {user_prompt}

Use the reference for icon meaning, visual language, palette, and shape where relevant. Follow the user's requested icon subject or function.

Design a simple, recognizable symbol with a strong silhouette, balanced composition, clear positive and negative space, and minimal visual noise. Prioritize readability at small display sizes.

Keep stroke thickness and visual weight consistent.

Center the icon with adequate padding on a transparent background where supported. Do not add text, decorative frames, extra symbols, or backgrounds unless requested.

Avoid smooth vector curves, anti-aliasing, glossy gradients, 3D effects, and photorealistic details.`,
  animal: `Create a complete low-resolution pixel art ANIMAL reference and action sheet for a 2D video game, based on the provided reference image and user description.

USER REQUEST: {user_prompt}

**MANDATORY ASSET TYPE: ANIMAL**

Generate exactly one animal species as a consistent multi-view and multi-action game sprite reference sheet.

The animal must match the user's requested species, body structure, proportions, colors, and recognizable characteristics.

Do not transform the animal into a humanoid character, fantasy warrior, or unrelated monster unless explicitly requested.

**PRIMARY OBJECTIVE**

Create a professional retro pixel art animal sprite sheet containing multiple viewing angles and useful gameplay actions.

The result must resemble authentic low-resolution 2D game assets, not a collection of detailed illustrations.

**REFERENCE FIDELITY**

Preserve the animal's defining anatomy, body proportions, head shape, ears, legs, tail, fur or skin patterns, and primary colors.

Treat the reference as a design source rather than a high-resolution rendering target.

Simplify intricate textures and details while preserving the animal's recognizable identity.

**SHEET STRUCTURE**

Organize the output into four clearly separated horizontal sections.

Section 1 — Character Turnaround:
Show four complete views of the same animal:
- Front view.
- Side view.
- Back view.
- Opposite side view.

Section 2 — Walking:
Show four sequential walking poses of the same animal, using a consistent side-view direction.

Section 3 — Running:
Show four sequential running poses showing clearly different phases of motion.

Section 4 — Natural Behaviors:
Show four distinct behaviors appropriate to the requested species, such as resting, alertness, vocalizing, sitting, crouching, or other anatomically appropriate actions.

Choose behavior poses based on the requested animal rather than forcing every species into the same actions.

**STRICT ANIMAL CONSISTENCY**

All views and actions must depict the exact same animal design.

Keep consistent body proportions, primary color blocks, head shape, tail structure, and a few defining markings. Simplify secondary fur or skin patterns according to the selected density, then reuse the retained features in every view and action.

Maintain consistent sprite scale across equivalent full-body views.

Do not change the animal's species, anatomy, or visual identity between frames.

Use the per-sprite logical size in the density instructions. Arrange four sprites per row in each of the four sections, for a 4-column by 4-row sheet.

**ANIMATION READABILITY**

Walking and running sequences must show meaningful changes in limb position, body movement, and weight distribution.

Do not repeat identical poses with only minor cosmetic changes.

Keep each action sequence visually coherent and anatomically plausible.

Maintain consistent character size and body proportions between frames.

**LAYOUT AND OUTPUT**

Arrange the sprites in a clean, evenly spaced grid.

Keep every sprite complete and fully visible.

Use a transparent background where supported.

Do not include decorative scenery, text, labels, panel borders, UI elements, or unrelated objects.

Do not merge neighboring sprites or allow overlapping silhouettes.

**STRICTLY AVOID**

High-resolution animal illustration, photorealistic fur, smooth gradients, anti-aliasing, inconsistent anatomy, mismatched sprite scales, duplicate action poses, unrelated animals, human-like transformations, and cluttered layouts.

**FINAL REQUIREMENT**

Produce one coherent low-resolution pixel art animal reference and action sheet featuring four viewing angles, four walking poses, four running poses, and four species-appropriate behavior poses.

Prioritize consistent animal identity, readable silhouettes, meaningful action variation, and practical 2D game sprite design.`,
  scene: `Create an immersive 2D pixel art game environment based on the provided reference image and user description.

USER REQUEST: {user_prompt}

Use the reference for environmental design, architecture, color mood, composition, and visual direction where relevant. Reinterpret non-pixel-art references into authentic pixel art.

Build a coherent game scene with clearly separated foreground, midground, and background layers where appropriate. Maintain consistent perspective, environmental scale, lighting direction, and pixel density across terrain, structures, vegetation, and objects.

Use visible square-pixel clusters, stepped silhouettes, hard-edged color regions, a cohesive retro palette, and simplified textures. Allow sufficient detail for a complete environment without introducing smooth photographic surfaces.

Preserve gameplay readability and avoid cluttering important pathways or interaction areas. Do not force an isolated transparent sprite composition. Avoid photorealism, painterly lighting, smooth gradients, and mixed-resolution assets.`,
  portrait: `Create an unmistakably pixelated 2D game character portrait at the selected density based on the reference image.

USER REQUEST: {user_prompt}

Keep the character recognizable through its hairstyle or head silhouette, main costume shapes, primary color blocks, and a few defining facial marks or essential accessories, unless the user requests changes. Simplify secondary accessories and facial detail according to the selected density; a recognizable portrait does not require every feature or decoration from the reference.

Focus on readable expression, facial structure, hairstyle, personality, and main costume shapes. Use a head-and-shoulders or upper-body composition unless another framing is requested. Keep facial shading, eyes, hair, and costume decoration within the selected density's detail budget. A larger portrait does not authorize a finer pixel grid or restore details omitted by that density.

Use deliberate pixel clusters, stepped curves, a cohesive limited palette, and clean hard-edged shading. Add highlights only when the selected density permits them. Avoid smooth anime rendering, airbrushed skin, gradients, anti-aliasing, photorealism, and painterly textures.

Keep the subject clearly framed, with a simple or transparent background as appropriate.`,
  "rpg-character": `Create an authentic pixel art RPG character sprite using the provided reference image.

USER REQUEST: {user_prompt}

Preserve the reference character's recognizable identity, outfit, equipment, main colors, and distinctive features unless the user requests otherwise. Adapt the design into a compact, readable RPG sprite.

Use a three-quarter top-down RPG perspective by default, unless the user or reference specifies another view. Emphasize a readable head, torso, arms, legs, and equipment. Simplify tiny details so the character remains recognizable at small in-game display sizes.

Render with a consistent square-pixel grid at the selected density, stepped outlines, intentional pixel clusters, its matching palette budget, and hard-edged density-appropriate shading. Keep the full character visible, centered, and isolated on a transparent background where supported.

Avoid smooth illustration, realistic anatomy detail, blurry edges, excessive textures, perspective inconsistencies, and environmental backgrounds.`,
} as const;

export function consistentScenesPrompt(
  userPrompt: string,
  subjectDetails = "Preserve the subject identity, design, and essential colors shown in the supplied reference image.",
  pixelLevel: PixelArtLevel = "classic",
): string {
  return withPixelArtLevel(
    pixelPromptWithRequest(
      "USER REQUEST",
      userPrompt,
      `Create exactly one 3-row by 3-column grid containing nine distinct but visually consistent pixel art game scenes, based on the supplied reference image.

SUBJECT AND DETAILS: ${subjectDetails.trim()}

**SCENE PIXEL BUDGET**

Use the per-panel and complete-sheet logical dimensions in the density instructions. Each panel is square. Replicate the logical pixels uniformly with nearest-neighbor scaling; do not add detail between logical pixels or smooth interpolation. Keep the same logical pixel size across subjects, scenery, and all nine panels, including close-ups.

Use one shared palette across the entire nine-panel sheet within the selected density's color budget, with a matching number of flat tones per major material and hard color boundaries. Preserve essential reference hues in that palette. Different settings must reuse it rather than introduce smooth lighting gradients or new color ramps in every panel.

Construct faces, hair, costumes, and scenery from pixel clusters sized to the selected density and stair-step contours. Coarse pixels use broad shapes; classic pixels use compact clusters; fine pixels retain small hair, fabric, and facial details as deliberate square-pixel groups. Reference fidelity means preserving recognizable design without reproducing smooth illustration rendering. The result must look like game scenes enlarged without smoothing.

**PRIMARY OBJECTIVE**

Create nine related scenes featuring the same recognizable character, creature, or subject, rendered in authentic low-resolution pixel art suitable for a 2D video game.

The result must look like nine scenes from the same retro pixel art game, not nine high-resolution illustrations with a pixelation filter.

Follow the user's requested scenes in reading order, from left to right and top to bottom.

**MANDATORY 3×3 GRID STRUCTURE**

Arrange exactly nine panels in a clean 3-column by 3-row grid.

All panels must have identical dimensions and aspect ratios.

Keep the grid precisely aligned with straight, consistent panel boundaries.

Do not merge panels, overlap scenes, or create irregular layouts.

Use no text, labels, captions, numbers, watermarks, or decorative frames.

**STRICT SUBJECT CONSISTENCY**

The same subject must appear in all nine panels.

Keep the subject recognizable through:
- Hairstyle or head silhouette and primary hair color.
- Body proportions and species-specific anatomy.
- Main clothing or armor shapes and primary color blocks.
- Essential equipment and a few defining symbols or markings.

Identity does not require reproducing every facial detail, accessory, seam, or pattern. Simplify secondary details according to the selected density, then reuse those same choices in every panel, including close-ups.

Do not replace the subject or change its defining design between panels. Reusing density-appropriate simplifications does not count as redesigning the subject.

Maintain consistent anatomy and character identity across front, side, back, and three-quarter views.

Preserve the same outfit and equipment unless the user explicitly requests a change.

If the subject is a monster or animal, preserve its species-specific anatomy and distinctive creature features rather than converting it into a human character.

**CONSISTENT GAME ART DIRECTION**

All nine scenes must appear to belong to the same 2D pixel art game.

Maintain a unified artistic style, consistent shading techniques, coherent lighting logic, and compatible color treatment.

Follow the requested game perspective and composition.

If the user requests different camera angles, preserve character proportions and recognizable design across those views.

Keep characters and environmental details readable at low resolution.

**SCENE VARIATION**

Follow the user's requested actions, poses, environments, and compositions for each panel.

Vary only the requested action, pose, camera angle, composition, expression, or setting.

Keep the character's core identity, costume, equipment, and visual design unchanged.

Allow different backgrounds when appropriate to the requested scenes.

Use simplified pixel art environments with restrained detail so that the subject remains the main visual focus.

Do not automatically turn the nine panels into an animation sprite sheet or nine identical standing poses.

**CHARACTER READABILITY**

Keep the subject clearly recognizable in every panel.

Avoid extreme camera distances that make the subject too small to identify.

Avoid unnecessary occlusion of the face, body, or important equipment.

Use readable poses and strong silhouettes.

For full-body scenes, maintain coherent character proportions and anatomy.

For close-up scenes, retain the same recognizable facial and costume features.

**REFERENCE INTERPRETATION**

Use the reference image to preserve subject identity, design, and essential color relationships.

Treat the reference as a design source rather than a high-resolution rendering target.

Simplify intricate reference details to match the low-resolution pixel art style.

Do not reproduce smooth anime rendering, painterly textures, or photorealistic shading from the reference.

**STRICTLY AVOID**

High-resolution anime illustration, realistic digital painting, smooth gradients, anti-aliasing, photorealistic textures, inconsistent pixel sizes, excessive micro-details, character identity drift, changing costumes, inconsistent anatomy, mismatched art styles, merged panels, missing panels, extra panels, text, labels, and decorative borders.

**FINAL REQUIREMENT**

Produce exactly nine equal-sized pixel art game scenes in a precise 3×3 grid.

Every panel must feature the same recognizable subject with consistent identity, costume, proportions, colors, and pixel art style.

The final result should resemble a cohesive collection of authentic retro 2D pixel game scenes, with clearly visible square pixels, detail appropriate to the selected density, and consistent subject design.`,
    ),
    pixelLevel,
    "scene",
    {
      assetType: ["subject", "environment"],
      grid: { columns: 3, rows: 3, unit: "panel" },
    },
  );
}
