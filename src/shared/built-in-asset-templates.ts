import type { AssetTemplateDefinition } from "./asset-templates.js";
import type { CommunityAuthor } from "./publish-v1.js";

export interface BuiltInAssetTemplate extends AssetTemplateDefinition {
  id: string;
  releaseId: string;
  publishedAt: string;
}

export const OPEN_GAME_TEMPLATE_AUTHOR: CommunityAuthor = { id: "opengame", displayName: "OpenGame" };

const PUBLISHED_AT = "2026-09-06T00:00:00.000Z";

export const BUILT_IN_ASSET_TEMPLATES: readonly BuiltInAssetTemplate[] = [
  {
    id: "general-image", releaseId: "general-image-v1", publishedAt: PUBLISHED_AT,
    mode: "image", name: "General Image", description: "A flexible starting point for any visual asset.",
    promptPlaceholder: "A stylized floating island at sunrise, soft volumetric light, game concept art...",
    defaults: { imageResolution: "1K", imageAspectRatio: "1:1", imageOutputs: 1 },
  },
  {
    id: "character-turnaround", releaseId: "character-turnaround-v1", publishedAt: PUBLISHED_AT,
    mode: "image", name: "Character Turnaround", description: "Consistent front, side, and back character views.",
    promptPlaceholder: "A young desert explorer with a short utility jacket, climbing gear, and worn leather boots...",
    defaultPrompt: "Create a clean production character turnaround sheet with consistent front, side, and back full-body views. Keep proportions, costume, colors, and lighting identical across every view. Use a plain neutral background with no labels or decorative elements.",
    defaults: { imageResolution: "2K", imageAspectRatio: "16:9", imageOutputs: 1 },
  },
  {
    id: "environment-concept", releaseId: "environment-concept-v1", publishedAt: PUBLISHED_AT,
    mode: "image", name: "Environment Concept", description: "A wide scene focused on place, light, and mood.",
    promptPlaceholder: "An abandoned observatory above a cloud sea at blue hour, overgrown paths, a distant warm beacon...",
    defaultPrompt: "Create a production-ready environment concept in a wide establishing composition. Establish readable foreground, midground, and background layers, a clear focal point, coherent scale, and game-ready environmental storytelling. Do not add text or a border.",
    defaults: { imageResolution: "2K", imageAspectRatio: "16:9", imageOutputs: 1 },
  },
  {
    id: "character-sheet", releaseId: "character-sheet-v1", publishedAt: PUBLISHED_AT,
    mode: "image", name: "Character Sheet", description: "One coherent sheet for outfit and expression studies.",
    promptPlaceholder: "A reserved forest mechanic with a moss-green jumpsuit, copper tools, and a compact field pack...",
    defaultPrompt: "Create a clean character design sheet showing one full-body hero view, supporting outfit details, and a small set of consistent facial expressions. Maintain identical identity and costume throughout. Use an uncluttered neutral background without text.",
    defaults: { imageResolution: "2K", imageAspectRatio: "4:3", imageOutputs: 1 },
  },
  {
    id: "prop-design", releaseId: "prop-design-v1", publishedAt: PUBLISHED_AT,
    mode: "image", name: "Prop Design", description: "Focused exploration of a game-ready object.",
    promptPlaceholder: "A portable alchemy stove built from brass, dark iron, and heat-resistant ceramic parts...",
    defaultPrompt: "Create a production prop design sheet with one clear hero view and a few consistent detail views. Make construction, materials, scale, and function easy to understand. Use a clean neutral background without labels or decoration.",
    defaults: { imageResolution: "2K", imageAspectRatio: "4:3", imageOutputs: 1 },
  },
  {
    id: "general-video", releaseId: "general-video-v1", publishedAt: PUBLISHED_AT,
    mode: "video", name: "General Video", description: "A flexible starting point for motion generation.",
    promptPlaceholder: "Describe the scene, motion, and camera movement...",
    defaults: { videoResolution: "768P", videoAspectRatio: "adaptive", videoDuration: 6 },
  },
  {
    id: "cinematic-shot", releaseId: "cinematic-shot-v1", publishedAt: PUBLISHED_AT,
    mode: "video", name: "Cinematic Shot", description: "A composed shot with deliberate camera movement.",
    promptPlaceholder: "A lone rider crosses a flooded neon street as the camera slowly tracks alongside...",
    defaultPrompt: "Treat this as one coherent cinematic shot. Specify clear subject movement, restrained continuous camera motion, stable visual identity, consistent lighting, and a deliberate final composition. Avoid cuts and abrupt transitions.",
    defaults: { videoResolution: "768P", videoAspectRatio: "16:9", videoDuration: 8 },
  },
  {
    id: "seamless-loop", releaseId: "seamless-loop-v1", publishedAt: PUBLISHED_AT,
    mode: "video", name: "Seamless Loop", description: "Short ambient motion that returns to its first frame.",
    promptPlaceholder: "A tiny workshop at night, hanging lamps swaying gently while steam rises from a kettle...",
    defaultPrompt: "Create a seamless ambient loop. Keep the camera locked and make the final state match the opening state naturally. Use subtle repeatable motion and preserve subject identity, lighting, and composition throughout.",
    defaults: { videoResolution: "768P", videoAspectRatio: "16:9", videoDuration: 6 },
  },
  {
    id: "general-3d", releaseId: "general-3d-v1", publishedAt: PUBLISHED_AT,
    mode: "3d", name: "General 3D Model", description: "A balanced starting point for a textured model.",
    promptPlaceholder: "A stylized wooden treasure chest with iron bands and a hinged lid...",
    defaults: { model3DModel: "meshy-t2", model3DTargetPolycount: 4_000, model3DPose: "auto", model3DSource: "image" },
  },
  {
    id: "game-prop-3d", releaseId: "game-prop-3d-v1", publishedAt: PUBLISHED_AT,
    mode: "3d", name: "Game Prop", description: "A readable standalone object with clean materials.",
    promptPlaceholder: "A compact sci-fi field generator with a rugged shell and replaceable power cell...",
    defaultPrompt: "Create a complete standalone game prop with readable silhouette, coherent construction, clean material separation, and no floating or disconnected pieces. Center the object in a neutral pose.",
    defaults: { model3DModel: "meshy-t2", model3DTargetPolycount: 4_000, model3DPose: "auto", model3DSource: "text" },
  },
  {
    id: "character-model-3d", releaseId: "character-model-3d-v1", publishedAt: PUBLISHED_AT,
    mode: "3d", name: "Character Model", description: "A full-body character prepared in a neutral pose.",
    promptPlaceholder: "A stylized courier wearing layered weatherproof clothing and a compact delivery harness...",
    defaultPrompt: "Create a complete full-body game character with consistent anatomy, clean separation between garments, and a neutral symmetrical A-pose suitable for downstream rigging. Include no base or surrounding scene.",
    defaults: { model3DModel: "meshy-t2", model3DTargetPolycount: 4_000, model3DPose: "a-pose", model3DSource: "text" },
  },
];
