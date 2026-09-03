import type { AssetTemplateDefinition, Model3DSource, StudioMode } from "../shared/asset-templates.js";
export type { Model3DSource, StudioMode } from "../shared/asset-templates.js";
import characterModel3D from "./assets/asset-templates/character-model-3d.webp";
import characterSheet from "./assets/asset-templates/character-sheet.webp";
import characterTurnaround from "./assets/asset-templates/character-turnaround.webp";
import cinematicShot from "./assets/asset-templates/cinematic-shot.webp";
import environmentConcept from "./assets/asset-templates/environment-concept.webp";
import gameProp3D from "./assets/asset-templates/game-prop-3d.webp";
import general3D from "./assets/asset-templates/general-3d.webp";
import generalImage from "./assets/asset-templates/general.webp";
import generalVideo from "./assets/asset-templates/general-video.webp";
import propDesign from "./assets/asset-templates/prop-design.webp";
import seamlessLoop from "./assets/asset-templates/seamless-loop.webp";

export interface AssetTemplate extends AssetTemplateDefinition {
  id: string;
  previewImage: string;
  source: "builtIn" | "local" | "catalog";
  publication?: import("../shared/asset-templates.js").LocalAssetTemplate["publication"];
}

const BUILT_IN_TEMPLATES: readonly Omit<AssetTemplate, "source">[] = [
  {
    id: "general-image",
    mode: "image",
    name: "General Image",
    description: "A flexible starting point for any visual asset.",
    promptLabel: "Prompt",
    promptPlaceholder: "A stylized floating island at sunrise, soft volumetric light, game concept art...",
    previewImage: generalImage,
    defaults: { imageResolution: "1K", imageAspectRatio: "1:1", imageOutputs: 1 },
  },
  {
    id: "character-turnaround",
    mode: "image",
    name: "Character Turnaround",
    description: "Consistent front, side, and back character views.",
    promptLabel: "Character description",
    promptPlaceholder: "A young desert explorer with a short utility jacket, climbing gear, and worn leather boots...",
    defaultPrompt: "Create a clean production character turnaround sheet with consistent front, side, and back full-body views. Keep proportions, costume, colors, and lighting identical across every view. Use a plain neutral background with no labels or decorative elements.",
    previewImage: characterTurnaround,
    defaults: { imageResolution: "2K", imageAspectRatio: "16:9", imageOutputs: 1 },
  },
  {
    id: "environment-concept",
    mode: "image",
    name: "Environment Concept",
    description: "A wide scene focused on place, light, and mood.",
    promptLabel: "Scene description",
    promptPlaceholder: "An abandoned observatory above a cloud sea at blue hour, overgrown paths, a distant warm beacon...",
    defaultPrompt: "Create a production-ready environment concept in a wide establishing composition. Establish readable foreground, midground, and background layers, a clear focal point, coherent scale, and game-ready environmental storytelling. Do not add text or a border.",
    previewImage: environmentConcept,
    defaults: { imageResolution: "2K", imageAspectRatio: "16:9", imageOutputs: 1 },
  },
  {
    id: "character-sheet",
    mode: "image",
    name: "Character Sheet",
    description: "One coherent sheet for outfit and expression studies.",
    promptLabel: "Character description",
    promptPlaceholder: "A reserved forest mechanic with a moss-green jumpsuit, copper tools, and a compact field pack...",
    defaultPrompt: "Create a clean character design sheet showing one full-body hero view, supporting outfit details, and a small set of consistent facial expressions. Maintain identical identity and costume throughout. Use an uncluttered neutral background without text.",
    previewImage: characterSheet,
    defaults: { imageResolution: "2K", imageAspectRatio: "4:3", imageOutputs: 1 },
  },
  {
    id: "prop-design",
    mode: "image",
    name: "Prop Design",
    description: "Focused exploration of a game-ready object.",
    promptLabel: "Prop description",
    promptPlaceholder: "A portable alchemy stove built from brass, dark iron, and heat-resistant ceramic parts...",
    defaultPrompt: "Create a production prop design sheet with one clear hero view and a few consistent detail views. Make construction, materials, scale, and function easy to understand. Use a clean neutral background without labels or decoration.",
    previewImage: propDesign,
    defaults: { imageResolution: "2K", imageAspectRatio: "4:3", imageOutputs: 1 },
  },
  {
    id: "general-video",
    mode: "video",
    name: "General Video",
    description: "A flexible starting point for motion generation.",
    promptLabel: "Prompt",
    promptPlaceholder: "Describe the scene, motion, and camera movement...",
    previewImage: generalVideo,
    defaults: { videoResolution: "768P", videoAspectRatio: "adaptive", videoDuration: 6 },
  },
  {
    id: "cinematic-shot",
    mode: "video",
    name: "Cinematic Shot",
    description: "A composed shot with deliberate camera movement.",
    promptLabel: "Shot description",
    promptPlaceholder: "A lone rider crosses a flooded neon street as the camera slowly tracks alongside...",
    defaultPrompt: "Treat this as one coherent cinematic shot. Specify clear subject movement, restrained continuous camera motion, stable visual identity, consistent lighting, and a deliberate final composition. Avoid cuts and abrupt transitions.",
    previewImage: cinematicShot,
    defaults: { videoResolution: "768P", videoAspectRatio: "16:9", videoDuration: 8 },
  },
  {
    id: "seamless-loop",
    mode: "video",
    name: "Seamless Loop",
    description: "Short ambient motion that returns to its first frame.",
    promptLabel: "Loop description",
    promptPlaceholder: "A tiny workshop at night, hanging lamps swaying gently while steam rises from a kettle...",
    defaultPrompt: "Create a seamless ambient loop. Keep the camera locked and make the final state match the opening state naturally. Use subtle repeatable motion and preserve subject identity, lighting, and composition throughout.",
    previewImage: seamlessLoop,
    defaults: { videoResolution: "768P", videoAspectRatio: "16:9", videoDuration: 6 },
  },
  {
    id: "general-3d",
    mode: "3d",
    name: "General 3D Model",
    description: "A balanced starting point for a textured model.",
    promptLabel: "3D prompt",
    promptPlaceholder: "A stylized wooden treasure chest with iron bands and a hinged lid...",
    previewImage: general3D,
    defaults: { model3DQuality: "standard", model3DPose: "auto", model3DSource: "image" },
  },
  {
    id: "game-prop-3d",
    mode: "3d",
    name: "Game Prop",
    description: "A readable standalone object with clean materials.",
    promptLabel: "Prop description",
    promptPlaceholder: "A compact sci-fi field generator with a rugged shell and replaceable power cell...",
    defaultPrompt: "Create a complete standalone game prop with readable silhouette, coherent construction, clean material separation, and no floating or disconnected pieces. Center the object in a neutral pose.",
    previewImage: gameProp3D,
    defaults: { model3DQuality: "ultra", model3DPose: "auto", model3DSource: "text" },
  },
  {
    id: "character-model-3d",
    mode: "3d",
    name: "Character Model",
    description: "A full-body character prepared in a neutral pose.",
    promptLabel: "Character description",
    promptPlaceholder: "A stylized courier wearing layered weatherproof clothing and a compact delivery harness...",
    defaultPrompt: "Create a complete full-body game character with consistent anatomy, clean separation between garments, and a neutral symmetrical A-pose suitable for downstream rigging. Include no base or surrounding scene.",
    previewImage: characterModel3D,
    defaults: { model3DQuality: "ultra", model3DPose: "a-pose", model3DSource: "text" },
  },
];

export const ASSET_TEMPLATES: readonly AssetTemplate[] = BUILT_IN_TEMPLATES.map((template) => ({
  ...template,
  source: "builtIn",
}));

export function templatesForMode(mode: StudioMode): readonly AssetTemplate[] {
  return ASSET_TEMPLATES.filter((template) => template.mode === mode);
}

export function defaultTemplateForMode(mode: StudioMode): AssetTemplate {
  const template = templatesForMode(mode)[0];
  if (!template) throw new Error(`No asset template configured for ${mode}`);
  return template;
}
