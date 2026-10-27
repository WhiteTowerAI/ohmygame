import type { CanvasNodeResizeRuntime } from "./canvas-node-resizer.js";
import type { CanvasNodeDetails } from "./canvas-node-label.js";
import type { TableNodeRuntime } from "./canvas-table-node.js";
import type { DocumentNodeRuntime } from "./canvas-document-node.js";
import type { AssetCanvasTextReference, AgentModelRef, AgentReasoningLevel, ImageModelRef, ModelRef, ImageResolution, ImageAspectRatio, VideoModelRef, VideoResolution, VideoAspectRatio, AssetCanvasReference, Model3DGenerationConfig, Model3DActionId, Model3DOperation, Model3DOptions, AssetCanvasNodeType, AgentModel, ImageModel, MediaProviderStatus, VideoModel, Model3DModel, VideoGenerationReference } from "../shared/contracts.js";
import type { Node } from "@xyflow/react";
import type { CanvasNodeReferencesRuntime } from "./canvas-node-references.js";
import type { AgentModelCatalogStatus } from "./model-selector.js";
import type { LibraryAsset } from "./library-assets.js";
import type { AudioModel, AudioProviderCatalogStatus } from "../shared/audio.js";
import { t } from "./i18n.js";
import { Maximize } from "./icons.js";
import { resolveModel3DConnection, resolveModel3D, DEFAULT_MODEL_3D_CONFIG, normalizeModel3DConfig } from "../shared/generation-config.js";
import { combineAssetCanvasPrompt } from "../shared/asset-canvas.js";

export const OUTPUT_HANDLE = "out";

export const MEDIA_NODE_MAX_WIDTH = 440;

export const MEDIA_NODE_MIN_WIDTH = 300;

export const MEDIA_NODE_MAX_HEIGHT = 360;

export const MEDIA_NODE_MIN_HEIGHT = 200;

export type AssetCanvasFlowData = {
  resizeRuntime?: CanvasNodeResizeRuntime;
  nodeDetails?: CanvasNodeDetails;
  panelOpen?: boolean;
  tableId?: string;
  tableRuntime?: TableNodeRuntime;
  /** Project-relative path of a file node. */
  path?: string;
  directory?: true;
  fileRuntime?: { onReveal?: () => void };
  documentId?: string;
  documentRuntime?: DocumentNodeRuntime;
  prompt?: string;
  promptSource?: AssetCanvasTextReference;
  text?: string;
  instruction?: string;
  textModel?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  model?: ImageModelRef;
  audioModel?: ModelRef;
  voiceId?: string;
  speed?: number;
  durationSeconds?: number;
  loop?: boolean;
  negativePrompt?: string;
  instrumental?: boolean;
  lyrics?: string;
  resolution?: ImageResolution;
  aspectRatio?: ImageAspectRatio;
  videoModel?: VideoModelRef;
  videoResolution?: VideoResolution;
  videoAspectRatio?: VideoAspectRatio;
  duration?: number;
  images?: AssetCanvasReference[];
  references?: AssetCanvasReference[];
  referenceMode?: "frame" | "reference";
  referenceMentions?: Record<string, AssetCanvasReference>;
  assetId?: string;
  mediaType?: "image" | "video" | "audio" | "model";
  model3DConfig?: Model3DGenerationConfig;
  heightMeters?: number;
  actionIds?: Model3DActionId[];
  animationModel?: ModelRef;
  model3DOperation?: Exclude<Model3DOperation, "animate">;
  model3DSource?: AssetCanvasReference;
  model3DOptions?: Model3DOptions;
  contentType?: string;
  assetDuration?: number;
  /** Width / height of the output media, known before it loads. */
  assetAspectRatio?: number;
  name?: string;
  assetOrigin?: "Project" | "Library";
  assetError?: string;
  imageRuntime?: ImageNodeRuntime;
  videoRuntime?: VideoNodeRuntime;
  audioRuntime?: AudioNodeRuntime;
  model3DRuntime?: Model3DNodeRuntime;
  animateRuntime?: Animate3DNodeRuntime;
  textRuntime?: TextNodeRuntime;
};

export type AssetCanvasFlowNode = Node<AssetCanvasFlowData, AssetCanvasNodeType> & { title?: string; description?: string };

export interface MediaNodeRuntime {
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: AssetCanvasFlowData, removedHandle?: string | string[]) => void;
  onGenerate: () => void;
  onCancel?: () => void;
  linkedPrompt?: string;
  onDisconnectPrompt?: () => void;
}

export interface TextNodeRuntime extends CanvasNodeReferencesRuntime {
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  defaultModel?: AgentModelRef;
  defaultReasoningLevel?: AgentReasoningLevel;
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: AssetCanvasFlowData) => void;
  onGenerate: (model: AgentModelRef, reasoningLevel: AgentReasoningLevel) => void;
}

export interface ReferenceMediaNodeRuntime extends MediaNodeRuntime {
  references: MediaReferenceView[];
  maxReferences: number;
  uploading: boolean;
  accept: string;
  addLabel: string;
  /** Names each reference position (e.g. 3D views); the strip then shows every position as a labelled slot. */
  slotLabels?: readonly string[];
  showEmptySlots?: boolean;
  onRemoveReference: (index: number) => void;
  /** Absent when references can only be connected, not uploaded. */
  onUploadReferences?: (files: File[]) => void;
  /** The Library images the + button offers next to Upload. */
  libraryImages?: LibraryAsset[];
  onAddLibraryReference?: (asset: LibraryAsset) => void;
}

export type ReferenceStripRuntime = Omit<ReferenceMediaNodeRuntime, "generating" | "error" | "onChange" | "onGenerate" | "onCancel">;

export interface ImageNodeRuntime extends ReferenceMediaNodeRuntime {
  models: ImageModel[];
  providers: MediaProviderStatus[];
}

export interface VideoNodeRuntime extends ReferenceMediaNodeRuntime {
  models: VideoModel[];
  providers: MediaProviderStatus[];
}

export interface AudioNodeRuntime extends MediaNodeRuntime {
  models: AudioModel[];
  providers: AudioProviderCatalogStatus[];
}

export interface Model3DNodeRuntime extends ReferenceMediaNodeRuntime {
  sourceRuntime?: ReferenceStripRuntime;
  models: Model3DModel[];
  providers: MediaProviderStatus[];
}

export interface Animate3DNodeRuntime extends ReferenceMediaNodeRuntime {
  models: Model3DModel[];
}

export interface MediaReferenceView {
  assetId?: string;
  key: string;
  name: string;
  label: string;
  type: VideoGenerationReference["type"] | "model";
  duration?: number;
}

/** The workspace opens the viewer from onNodeClick, which already knows the node. */
export function MediaViewButton() {
  return (
    <button className="story-media-view-button nodrag" type="button" title={t("assetCanvas.viewAction")} aria-label={t("assetCanvas.viewAction")} onDoubleClick={(event) => event.stopPropagation()}>
      <Maximize size={14} />
    </button>
  );
}

export function modelRef<T extends { provider: string; id: string }>(model: T): { provider: string; id: string } {
  return { provider: model.provider, id: model.id };
}

export function modelRefKey(model: ModelRef): string {
  return `${model.provider}:${model.id}`;
}

export function sameImageModel(left: ImageModelRef, right?: ImageModelRef): boolean {
  return Boolean(right && left.provider === right.provider && left.id === right.id);
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}:${model.id}`;
}

export function sameModel(model: ModelRef, ref?: ModelRef): boolean {
  return Boolean(ref && model.provider === ref.provider && model.id === ref.id);
}

export function nodeModel3D(node: Pick<AssetCanvasFlowNode, "type" | "data">, models: readonly Model3DModel[] = node.data.model3DRuntime?.models ?? []): Model3DModel | undefined {
  if (node.data.model3DOperation === "retexture" || node.data.model3DOperation === "remesh") return resolveModel3DConnection(node.data.model3DConfig?.model, models);
  return resolveModel3D(node.data.model3DConfig?.model, models);
}

export function nodeModel3DConfig(node: Pick<AssetCanvasFlowNode, "type" | "data">, models?: readonly Model3DModel[]): Model3DGenerationConfig {
  if (node.type !== "model-3d") return DEFAULT_MODEL_3D_CONFIG;
  const config = node.data.model3DConfig;
  return normalizeModel3DConfig(config, nodeModel3D(node, models), node.data.model3DOperation);
}

export function effectivePrompt(data: AssetCanvasFlowData, runtime?: MediaNodeRuntime): string {
  return combineAssetCanvasPrompt(runtime?.linkedPrompt, data.prompt ?? "");
}

export function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
