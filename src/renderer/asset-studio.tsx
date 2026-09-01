import { ChevronDown, ChevronRight, Download, FolderInput, Image, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Sparkles, X } from "./icons.js";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  MODEL_3D_POSES,
  MODEL_3D_QUALITIES,
  MODEL_3D_TEXTURE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageModel,
  type ImageOutputCount,
  type ImageResolution,
  type Model3DPose,
  type Model3DQuality,
  type Model3DTextureResolution,
  type ProjectState,
  type PromptImage,
  type ToolRun,
  type VideoAspectRatio,
  type VideoResolution,
} from "../shared/contracts.js";
import { addToolResultToProject, getImageGenerationSettings, getToolRunFile, listImageModels, listProjects, MODELS_CHANGED_EVENT, runTool, updateImageGenerationSettings, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";
import { ModelPreview } from "./model-preview.js";
import { WindowDragRegion } from "./window-drag-region.js";

interface AssetStudioPageProps {
  onNavigate: (page: SidebarPage) => void;
}

type StudioMode = "image" | "video" | "3d";
type Model3DSource = "text" | "image";
const VIDEO_MODEL_OPTIONS = [{ value: "MiniMax-H3", label: "MiniMax H3" }] as const;
const MODEL_3D_OPTIONS = [{ value: "meshy-7", label: "Meshy 7" }] as const;
const MODEL_3D_SOURCE_OPTIONS = [
  { value: "image", label: "Image" },
  { value: "text", label: "Text" },
] as const;

interface PreviewResult {
  run: ToolRun;
  urls: string[];
}

export function AssetStudioPage({ onNavigate }: AssetStudioPageProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [mode, setMode] = useState<StudioMode>("image");
  const [imagePhase, setImagePhase] = useState<"loading" | "ready" | "error">("loading");
  const [imageLoadError, setImageLoadError] = useState<string>();
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [imageModelKey, setImageModelKey] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageReference, setImageReference] = useState<PromptImage>();
  const [imageReferenceName, setImageReferenceName] = useState<string>();
  const [resolution, setResolution] = useState<ImageResolution>("1K");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [outputs, setOutputs] = useState<ImageOutputCount>(1);
  const [videoModel, setVideoModel] = useState<string>(VIDEO_MODEL_OPTIONS[0].value);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoReference, setVideoReference] = useState<PromptImage>();
  const [videoReferenceName, setVideoReferenceName] = useState<string>();
  const [videoAspectRatio, setVideoAspectRatio] = useState<VideoAspectRatio>("adaptive");
  const [videoResolution, setVideoResolution] = useState<VideoResolution>("768P");
  const [videoDuration, setVideoDuration] = useState(6);
  const [model3D, setModel3D] = useState<string>(MODEL_3D_OPTIONS[0].value);
  const [model3DSource, setModel3DSource] = useState<Model3DSource>("image");
  const [model3DPrompt, setModel3DPrompt] = useState("");
  const [modelReference, setModelReference] = useState<PromptImage>();
  const [modelReferenceName, setModelReferenceName] = useState<string>();
  const [model3DQuality, setModel3DQuality] = useState<Model3DQuality>("standard");
  const [model3DTexture, setModel3DTexture] = useState(true);
  const [model3DTextureResolution, setModel3DTextureResolution] = useState<Model3DTextureResolution>("2K");
  const [model3DPbr, setModel3DPbr] = useState(true);
  const [model3DPose, setModel3DPose] = useState<Model3DPose>("auto");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PreviewResult>();
  const [selectedResult, setSelectedResult] = useState(0);
  const [generationError, setGenerationError] = useState<string>();
  const [referenceError, setReferenceError] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectsError, setProjectsError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ type: "success" | "error"; message: string }>();
  const mounted = useRef(true);
  const uploadInput = useRef<HTMLInputElement>(null);
  const resultActions = useRef<HTMLDivElement>(null);

  const selectedImageModel = imageModels.find((model) => modelKey(model) === imageModelKey);
  const supportedImageResolutions = IMAGE_RESOLUTIONS.filter((candidate) =>
    selectedImageModel?.generationOptions.some((option) => option.resolution === candidate),
  );
  const supportedImageAspectRatios = IMAGE_ASPECT_RATIOS.filter((candidate) =>
    selectedImageModel?.generationOptions.some((option) => option.resolution === resolution && option.aspectRatio === candidate),
  );
  const selectedFile = result?.run.files[selectedResult];
  const selectedUrl = result?.urls[selectedResult];
  const canGenerate = mode === "image"
    ? Boolean(imagePrompt.trim() && selectedImageModel)
    : mode === "video"
      ? Boolean(videoPrompt.trim())
      : model3DSource === "text" ? Boolean(model3DPrompt.trim()) : Boolean(modelReference);

  useEffect(() => {
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const reload = () => void loadImageConfig();
    window.addEventListener(MODELS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, reload);
  }, []);

  useEffect(() => () => {
    result?.urls.forEach((url) => URL.revokeObjectURL(url));
  }, [result]);

  useEffect(() => {
    if (!selectedImageModel) return;
    const option = selectedImageModel.generationOptions.find((candidate) => candidate.resolution === resolution && candidate.aspectRatio === aspectRatio)
      ?? selectedImageModel.generationOptions[0];
    if (option) {
      setResolution(option.resolution);
      setAspectRatio(option.aspectRatio);
    }
    if (outputs > selectedImageModel.maxOutputs) setOutputs(selectedImageModel.maxOutputs);
    if (!selectedImageModel.supportsReferenceImage) {
      setImageReference(undefined);
      setImageReferenceName(undefined);
    }
  }, [selectedImageModel]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!resultActions.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  async function load(): Promise<void> {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      if (!mounted.current) return;
      setPhase("ready");
      await Promise.all([loadImageConfig(), loadProjectList()]);
    } catch (cause) {
      if (!mounted.current) return;
      setLoadError(errorMessage(cause));
      setPhase("error");
    }
  }

  async function loadImageConfig(): Promise<void> {
    setImagePhase("loading");
    setImageLoadError(undefined);
    try {
      const [models, settings] = await Promise.all([listImageModels(), getImageGenerationSettings()]);
      if (!mounted.current) return;
      setImageModels(models);
      const selected = settings.model && models.some((model) => model.provider === settings.model?.provider && model.id === settings.model?.id)
        ? settings.model
        : models[0];
      setImageModelKey(selected ? modelKey(selected) : "");
      setImagePhase("ready");
    } catch (cause) {
      if (!mounted.current) return;
      setImageModels([]);
      setImageModelKey("");
      setImageLoadError(errorMessage(cause));
      setImagePhase("error");
    }
  }

  async function loadProjectList(): Promise<void> {
    setProjectsError(undefined);
    try {
      const loadedProjects = await listProjects();
      if (!mounted.current) return;
      setProjects(loadedProjects);
    } catch (cause) {
      if (!mounted.current) return;
      setProjects([]);
      setProjectsError(errorMessage(cause));
    }
  }

  async function generate(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!canGenerate || generating) return;
    setGenerating(true);
    setGenerationError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
    try {
      let nextRun: ToolRun;
      if (mode === "image") {
        if (!selectedImageModel) throw new Error("Connect an image model before generating");
        await updateImageGenerationSettings({ model: { provider: selectedImageModel.provider, id: selectedImageModel.id } });
        nextRun = await runTool("generate-image", {
          prompt: imagePrompt.trim(), resolution, aspectRatio, outputs,
          ...(imageReference ? { image: imageReference } : {}),
        });
      } else if (mode === "video") {
        nextRun = await runTool("generate-video", {
          prompt: videoPrompt.trim(), duration: videoDuration, aspectRatio: videoAspectRatio, resolution: videoResolution,
          ...(videoReference ? { image: videoReference } : {}),
        });
      } else {
        nextRun = await runTool("image-to-3d", {
          ...(model3DSource === "text" ? { prompt: model3DPrompt.trim() } : { image: modelReference! }),
          model: "meshy-7",
          quality: model3DQuality,
          texture: model3DTexture,
          textureResolution: model3DTextureResolution,
          pbr: model3DPbr,
          pose: model3DPose,
        });
      }
      const blobs = await Promise.all(nextRun.files.map((file) => getToolRunFile(nextRun.id, file.name)));
      if (!mounted.current) return;
      setResult({ run: nextRun, urls: blobs.map((blob) => URL.createObjectURL(blob)) });
      setSelectedResult(0);
    } catch (cause) {
      if (mounted.current) setGenerationError(errorMessage(cause));
    } finally {
      if (mounted.current) setGenerating(false);
    }
  }

  async function addToProject(project: ProjectState): Promise<void> {
    if (!result || !selectedFile || adding) return;
    setAdding(true);
    setActionStatus(undefined);
    setMenuOpen(false);
    try {
      await addToolResultToProject(project.id, { runId: result.run.id, fileName: selectedFile.name });
      if (mounted.current) setActionStatus({ type: "success", message: `Added to ${project.name}` });
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      if (mounted.current) setAdding(false);
    }
  }

  function chooseMode(nextMode: StudioMode): void {
    if (nextMode === mode || generating) return;
    setMode(nextMode);
    setResult(undefined);
    setSelectedResult(0);
    setGenerationError(undefined);
    setReferenceError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
  }

  function chooseImageResolution(nextResolution: ImageResolution): void {
    if (!selectedImageModel) return;
    const option = selectedImageModel.generationOptions.find((candidate) => candidate.resolution === nextResolution && candidate.aspectRatio === aspectRatio)
      ?? selectedImageModel.generationOptions.find((candidate) => candidate.resolution === nextResolution);
    if (!option) return;
    setResolution(option.resolution);
    setAspectRatio(option.aspectRatio);
  }

  function chooseImageAspectRatio(nextAspectRatio: ImageAspectRatio): void {
    if (!selectedImageModel?.generationOptions.some((option) => option.resolution === resolution && option.aspectRatio === nextAspectRatio)) return;
    setAspectRatio(nextAspectRatio);
  }

  const reference = mode === "image" ? imageReference : mode === "video" ? videoReference : modelReference;
  const referenceName = mode === "image" ? imageReferenceName : mode === "video" ? videoReferenceName : modelReferenceName;

  async function selectReference(file?: File): Promise<void> {
    if (!file) return;
    try {
      const nextImage = await readImage(file, mode === "image");
      if (!mounted.current) return;
      if (mode === "image") { setImageReference(nextImage); setImageReferenceName(file.name); }
      else if (mode === "video") { setVideoReference(nextImage); setVideoReferenceName(file.name); }
      else { setModelReference(nextImage); setModelReferenceName(file.name); }
      setReferenceError(undefined);
    } catch (cause) {
      if (mounted.current) setReferenceError(errorMessage(cause));
    }
  }

  return (
    <main className="home-shell asset-studio-shell">
      <AppSidebar active="asset-studio" onNavigate={onNavigate} />
      <section className="asset-studio-content">
        <WindowDragRegion />
        <div className="asset-studio-workspace">
          <form className="asset-config-panel" onSubmit={generate}>
            <ModeSwitcher mode={mode} disabled={generating} onChange={chooseMode} />
            {phase === "loading" ? <div className="asset-config-state"><LoaderCircle className="spin" size={16} />Loading studio</div> : null}
            {phase === "error" ? <div className="asset-config-state asset-config-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}><RefreshCw size={13} />Retry</button></div> : null}
            {phase === "ready" ? (
              <div className="asset-config-fields">
                {mode === "image" ? (
                  <>
                    <Field label="Model" htmlFor="asset-model">
                      {imagePhase === "loading" ? <p className="asset-inline-state"><LoaderCircle className="spin" size={13} />Loading models</p> : null}
                      {imagePhase === "error" ? <div className="asset-inline-error" role="alert"><span>{imageLoadError}</span><button type="button" onClick={() => void loadImageConfig()}><RefreshCw size={12} />Retry</button></div> : null}
                      {imagePhase === "ready" && imageModels.length ? <ModelSelect id="asset-model" value={imageModelKey} options={imageModels.map((model) => ({ value: modelKey(model), label: model.name }))} disabled={generating} onChange={setImageModelKey} /> : null}
                      {imagePhase === "ready" && !imageModels.length ? <p className="asset-inline-state">No image model is connected</p> : null}
                    </Field>
                    <PromptField id="asset-image-prompt" label="Prompt" value={imagePrompt} disabled={generating} placeholder="A stylized floating island at sunrise, soft volumetric light, game concept art..." onChange={setImagePrompt} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <Field label="Model" htmlFor="asset-video-model"><ModelSelect id="asset-video-model" value={videoModel} options={VIDEO_MODEL_OPTIONS} disabled={generating} onChange={setVideoModel} /></Field>
                    <PromptField id="asset-video-prompt" label="Prompt" value={videoPrompt} disabled={generating} placeholder="Describe the scene, motion, and camera movement..." onChange={setVideoPrompt} />
                  </>
                ) : (
                  <>
                    <Field label="Model" htmlFor="asset-3d-model"><ModelSelect id="asset-3d-model" value={model3D} options={MODEL_3D_OPTIONS} disabled={generating} onChange={setModel3D} /></Field>
                    <Model3DInputField
                      source={model3DSource}
                      prompt={model3DPrompt}
                      image={modelReference}
                      imageName={modelReferenceName}
                      disabled={generating}
                      onSourceChange={setModel3DSource}
                      onPromptChange={setModel3DPrompt}
                      onChooseImage={() => uploadInput.current?.click()}
                      onClearImage={() => {
                        setModelReference(undefined);
                        setModelReferenceName(undefined);
                        setReferenceError(undefined);
                      }}
                    />
                  </>
                )}

                {mode !== "3d" ? <ReferenceField label={mode === "video" ? "First frame" : "Reference image"} image={reference} name={referenceName} optional allowWebP={mode === "image"} disabled={generating || (mode === "image" && !selectedImageModel?.supportsReferenceImage)} onChoose={() => uploadInput.current?.click()} onClear={() => {
                  if (mode === "image") { setImageReference(undefined); setImageReferenceName(undefined); }
                  else { setVideoReference(undefined); setVideoReferenceName(undefined); }
                  setReferenceError(undefined);
                }} /> : null}
                {referenceError && (mode !== "3d" || model3DSource === "image") ? <p className="asset-field-error" role="alert">{referenceError}</p> : null}
                <input ref={uploadInput} hidden type="file" accept={mode === "image" ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg"} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void selectReference(file);
                }} />

                {mode === "image" && selectedImageModel ? (
                  <>
                    <OptionGroup label="Resolution" values={supportedImageResolutions} value={resolution} disabled={generating} onChange={chooseImageResolution} />
                    <OptionGroup label="Aspect ratio" values={supportedImageAspectRatios} value={aspectRatio} disabled={generating} onChange={chooseImageAspectRatio} />
                    <OptionGroup label="Outputs" values={IMAGE_OUTPUT_COUNTS} value={outputs} disabled={generating} isOptionDisabled={(value) => value > selectedImageModel.maxOutputs} onChange={setOutputs} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <OptionGroup label="Resolution" values={VIDEO_RESOLUTIONS} value={videoResolution} disabled={generating} onChange={setVideoResolution} />
                    <OptionGroup label="Aspect ratio" values={videoReference ? (["adaptive"] as const) : VIDEO_ASPECT_RATIOS} value={videoReference ? "adaptive" : videoAspectRatio} disabled={generating} format={(value) => value === "adaptive" ? "Auto" : value} onChange={setVideoAspectRatio} />
                    <RangeField label="Duration" value={videoDuration} min={4} max={15} disabled={generating} onChange={setVideoDuration} />
                  </>
                ) : (
                  <div className="asset-3d-options">
                    <SettingsSection title="Geometry">
                      <OptionGroup equal label="Quality" values={MODEL_3D_QUALITIES} value={model3DQuality} disabled={generating} format={titleCase} onChange={setModel3DQuality} />
                      <OptionGroup equal label="Pose" values={MODEL_3D_POSES} value={model3DPose} disabled={generating} format={(value) => value === "auto" ? "Auto" : value === "a-pose" ? "A-Pose" : "T-Pose"} onChange={setModel3DPose} />
                    </SettingsSection>
                    <SettingsSection title="Materials">
                      <ToggleField label="Texture" checked={model3DTexture} disabled={generating} onChange={setModel3DTexture} />
                      {model3DTexture ? <OptionGroup equal label="Resolution" values={MODEL_3D_TEXTURE_RESOLUTIONS} value={model3DTextureResolution} disabled={generating} onChange={setModel3DTextureResolution} /> : null}
                      {model3DTexture ? <ToggleField label="PBR" checked={model3DPbr} disabled={generating} onChange={setModel3DPbr} /> : null}
                    </SettingsSection>
                  </div>
                )}
              </div>
            ) : null}
            <button className="asset-generate-button" type="submit" disabled={phase !== "ready" || !canGenerate || generating}>
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "Generating..." : "Generate"}
            </button>
          </form>

          <section className="asset-result-panel" aria-label="Generation result">
            <header><h1>Result</h1><div className="asset-result-actions" ref={resultActions}><button type="button" aria-label="Result actions" aria-expanded={menuOpen} disabled={!result || generating} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>{menuOpen && result && selectedFile && selectedUrl ? <div className="asset-result-menu" role="menu">
              <a href={selectedUrl} download={selectedFile.name} role="menuitem"><Download size={14} />Download</a>
              {projects.length ? <div className="asset-result-projects">
                <button type="button" role="menuitem" aria-haspopup="menu" disabled={adding}><FolderInput size={14} /><span>Add to Project</span><ChevronRight className="asset-result-menu-chevron" size={13} /></button>
                <div className="asset-result-submenu" role="menu">
                  {projects.map((project) => <button type="button" role="menuitem" key={project.id} disabled={adding} title={project.name} onClick={() => void addToProject(project)}><span>{project.name}</span></button>)}
                </div>
              </div> : null}
              {projectsError ? <button type="button" role="menuitem" onClick={() => void loadProjectList()}><RefreshCw size={14} />Retry projects</button> : null}
              <button type="button" role="menuitem" disabled={generating} onClick={() => void generate()}><RefreshCw size={14} />Regenerate</button>
            </div> : null}</div></header>
            <div className={`asset-result-canvas${result && result.urls.length > 1 ? " asset-result-grid" : ""}`}>
              {generating ? <div className="asset-result-empty"><LoaderCircle className="spin" size={28} /><strong>Generating your {mode === "3d" ? "model" : mode}</strong><span>This may take a moment.</span></div> : null}
              {!generating && generationError ? <div className="asset-result-empty asset-result-error" role="alert"><strong>Generation failed</strong><span>{generationError}</span></div> : null}
              {!generating && !generationError && !result ? <div className="asset-result-empty"><span className="asset-result-empty-icon"><Image size={24} /></span><strong>Your result will appear here</strong><span>{mode === "3d" ? model3DSource === "text" ? "Add a prompt and generate your first model." : "Add a reference and generate your first model." : `Add a prompt and generate your first ${mode}.`}</span></div> : null}
              {!generating && !generationError && result ? result.urls.map((url, index) => {
                const media = <ResultMedia mode={mode} url={url} label={imagePrompt || `Generated image ${index + 1}`} />;
                return result.urls.length > 1
                  ? <button className={`asset-result-preview${selectedResult === index ? " is-selected" : ""}`} type="button" key={url} onClick={() => setSelectedResult(index)} aria-label={`Select result ${index + 1}`}>{media}</button>
                  : <div className="asset-result-preview is-selected" key={url}>{media}</div>;
              }) : null}
            </div>
            {actionStatus ? <p className={`asset-result-notice${actionStatus.type === "error" ? " is-error" : ""}`} role={actionStatus.type === "error" ? "alert" : "status"}>{actionStatus.message}</p> : null}
          </section>
        </div>
      </section>
    </main>
  );
}

function ModeSwitcher({ mode, disabled, onChange }: { mode: StudioMode; disabled: boolean; onChange: (mode: StudioMode) => void }) {
  return <div className="asset-mode-switcher" aria-label="Media type">{(["image", "video", "3d"] as const).map((value) => <button key={value} type="button" className={mode === value ? "is-active" : undefined} aria-pressed={mode === value} disabled={disabled} onClick={() => onChange(value)}>{value === "3d" ? "3D" : value[0].toUpperCase() + value.slice(1)}</button>)}</div>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <div className="asset-field"><label htmlFor={htmlFor}>{label}</label>{children}</div>;
}

function ModelSelect({ id, value, options, disabled, onChange }: { id: string; value: string; options: readonly { value: string; label: string }[]; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="asset-select-wrap"><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={14} /></div>;
}

function PromptField({ id, label, value, placeholder, maxLength = 2000, disabled, onChange }: { id: string; label: string; value: string; placeholder: string; maxLength?: number; disabled: boolean; onChange: (value: string) => void }) {
  return <Field label={label} htmlFor={id}><PromptControl id={id} value={value} placeholder={placeholder} maxLength={maxLength} disabled={disabled} onChange={onChange} /></Field>;
}

function PromptControl({ id, value, placeholder, maxLength, ariaLabel, disabled, onChange }: { id: string; value: string; placeholder: string; maxLength: number; ariaLabel?: string; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="asset-prompt-wrap"><textarea id={id} aria-label={ariaLabel} maxLength={maxLength} value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span>{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span></div>;
}

function Model3DInputField({ source, prompt, image, imageName, disabled, onSourceChange, onPromptChange, onChooseImage, onClearImage }: { source: Model3DSource; prompt: string; image?: PromptImage; imageName?: string; disabled: boolean; onSourceChange: (source: Model3DSource) => void; onPromptChange: (prompt: string) => void; onChooseImage: () => void; onClearImage: () => void }) {
  return <div className={`asset-3d-input is-${source}`}><div className="asset-3d-input-header"><span>Input</span><SourceSwitch value={source} disabled={disabled} onChange={onSourceChange} /></div><div className="asset-3d-input-body">{source === "text"
    ? <PromptControl id="asset-3d-prompt" ariaLabel="3D prompt" value={prompt} maxLength={800} disabled={disabled} placeholder="A stylized wooden treasure chest with iron bands and a hinged lid..." onChange={onPromptChange} />
    : <ReferenceControl label="Reference image" image={image} name={imageName} optional={false} allowWebP={false} disabled={disabled} onChoose={onChooseImage} onClear={onClearImage} />}</div></div>;
}

function SourceSwitch({ value, disabled, onChange }: { value: Model3DSource; disabled: boolean; onChange: (value: Model3DSource) => void }) {
  return <fieldset className="asset-source-switch" disabled={disabled}><legend className="visually-hidden">3D input type</legend>{MODEL_3D_SOURCE_OPTIONS.map((option) => <label key={option.value}><input type="radio" name="asset-3d-source" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span>{option.label}</span></label>)}</fieldset>;
}

function ReferenceField({ label, image, name, optional, allowWebP, disabled, onChoose, onClear }: { label: string; image?: PromptImage; name?: string; optional: boolean; allowWebP: boolean; disabled: boolean; onChoose: () => void; onClear: () => void }) {
  return <Field label={label}><ReferenceControl label={label} image={image} name={name} optional={optional} allowWebP={allowWebP} disabled={disabled} onChoose={onChoose} onClear={onClear} /></Field>;
}

function ReferenceControl({ label, image, name, optional, allowWebP, disabled, onChoose, onClear }: { label: string; image?: PromptImage; name?: string; optional: boolean; allowWebP: boolean; disabled: boolean; onChoose: () => void; onClear: () => void }) {
  return <div className={`asset-reference${image ? " has-image" : ""}`}><button type="button" disabled={disabled} onClick={onChoose}>{image ? <img src={`data:${image.mediaType};base64,${image.data}`} alt="Reference" /> : <span className="asset-reference-icon"><Plus size={16} /></span>}<span className="asset-reference-copy"><strong>{name ?? `Add ${label.toLowerCase()}`}</strong><small>{name ?? `PNG, JPG${allowWebP ? " or WebP" : ""}${optional ? " · optional" : ""}`}</small></span></button>{image ? <button className="asset-reference-clear" type="button" aria-label={`Remove ${label.toLowerCase()}`} disabled={disabled} onClick={onClear}><X size={13} /></button> : null}</div>;
}

function ResultMedia({ mode, url, label }: { mode: StudioMode; url: string; label: string }) {
  if (mode === "3d") return <ModelPreview source={url} label="Generated 3D model" minHeight={420} />;
  if (mode === "video") return <video src={url} controls preload="metadata" />;
  return <img src={url} alt={label} />;
}

function OptionGroup<T extends string | number>({ label, values, value, disabled, equal = false, isOptionDisabled, format, onChange }: { label: string; values: readonly T[]; value: T; disabled: boolean; equal?: boolean; isOptionDisabled?: (value: T) => boolean; format?: (value: T) => string; onChange: (value: T) => void }) {
  return <fieldset className={`asset-option-group${equal ? " is-equal" : ""}`} disabled={disabled}><legend>{label}</legend><div style={equal ? { gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` } : undefined}>{values.map((option) => <button type="button" key={option} className={option === value ? "is-active" : undefined} aria-pressed={option === value} disabled={disabled || isOptionDisabled?.(option)} onClick={() => onChange(option)}>{format ? format(option) : option}</button>)}</div></fieldset>;
}

function RangeField({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  const style = { "--asset-range-progress": `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
  return <div className="asset-range-field"><div><label htmlFor="asset-video-duration">{label}</label><output htmlFor="asset-video-duration">{value}s</output></div><input id="asset-video-duration" type="range" value={value} min={min} max={max} step={1} disabled={disabled} style={style} onChange={(event) => onChange(Number(event.target.value))} /><div className="asset-range-bounds"><span>{min}s</span><span>{max}s</span></div></div>;
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="asset-settings-section"><h2>{title}</h2><div>{children}</div></section>;
}

function ToggleField({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div className="asset-toggle-field"><span>{label}</span><button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

async function readImage(file: File, allowWebP: boolean): Promise<PromptImage> {
  const supported = file.type === "image/png" || file.type === "image/jpeg" || (allowWebP && file.type === "image/webp");
  if (!supported) throw new Error(`Use a PNG, JPEG${allowWebP ? ", or WebP" : ""} image`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  return { mediaType: file.type as PromptImage["mediaType"], data };
}

function modelKey(model: Pick<ImageModel, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
