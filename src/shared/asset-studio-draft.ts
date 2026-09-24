import type { ImageAspectRatio, ImageOutputCount, ImageResolution, Model3DGenerationConfig, VideoAspectRatio, VideoGenerationReference, VideoResolution } from "./contracts.js";
import type { StudioMode } from "./asset-templates.js";

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
  model3D: Model3DGenerationConfig;
}
