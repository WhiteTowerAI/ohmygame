import type { ImageAspectRatio, ImageOutputCount, ImageResolution, Model3DModel, Model3DPose, Model3DQuality, Model3DTextureResolution, VideoAspectRatio, VideoGenerationReference, VideoResolution } from "./contracts.js";
import type { Model3DSource, StudioMode } from "./asset-templates.js";

export interface AssetStudioDraft {
  mode: StudioMode;
  templateIds: Partial<Record<StudioMode, string>>;
  panelView: "templates" | "history";
  selectedRunId?: string;
  selectedOutput?: number;
  image: {
    prompt: string;
    resolution: ImageResolution;
    aspectRatio: ImageAspectRatio;
    outputs: ImageOutputCount;
  };
  video: {
    prompt: string;
    references: VideoGenerationReference[];
    resolution: VideoResolution;
    aspectRatio: VideoAspectRatio;
    duration: number;
  };
  model3D: {
    prompt: string;
    model: Model3DModel;
    source: Model3DSource;
    multiView: boolean;
    quality: Model3DQuality;
    targetPolycount: number;
    texture: boolean;
    textureResolution?: Model3DTextureResolution;
    pbr?: boolean;
    pose: Model3DPose;
    imageEnhancement: boolean;
  };
}
