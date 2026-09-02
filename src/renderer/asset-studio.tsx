import { Box, ChevronDown, ChevronRight, Download, Film, FolderInput, Image, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Sparkles, X } from "./icons.js";
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
import { defaultTemplateForMode, templatesForMode, type AssetTemplate, type Model3DSource, type StudioMode } from "./asset-templates.js";
import { AppSidebar } from "./app-sidebar.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { ModelPreview } from "./model-preview.js";
import { WindowDragRegion } from "./window-drag-region.js";

interface AssetStudioPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
}

const VIDEO_MODEL_OPTIONS = [{ value: "MiniMax-H3", label: "MiniMax H3" }] as const;
const MODEL_3D_OPTIONS = [{ value: "meshy-7", label: "Meshy 7" }] as const;
const HISTORY_LIMIT = 20;
const MODEL_3D_SOURCE_OPTIONS = [
  { value: "image", label: "Image" },
  { value: "text", label: "Text" },
] as const;

interface PreviewResult {
  run: ToolRun;
  urls: string[];
  templateName: string;
}

type AssetPanelView = "templates" | "history";

export function AssetStudioPage({ onNavigate }: AssetStudioPageProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [mode, setMode] = useState<StudioMode>("image");
  const [templateId, setTemplateId] = useState(defaultTemplateForMode("image").id);
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
  const [history, setHistory] = useState<PreviewResult[]>([]);
  const [panelView, setPanelView] = useState<AssetPanelView>("templates");
  const [selectedResult, setSelectedResult] = useState(0);
  const [generationError, setGenerationError] = useState<string>();
  const [referenceError, setReferenceError] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectsError, setProjectsError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ type: "success" | "error"; message: string }>();
  const mounted = useRef(true);
  const historyRef = useRef<PreviewResult[]>([]);
  const uploadInput = useRef<HTMLInputElement>(null);
  const resultActions = useRef<HTMLDivElement>(null);

  const templates = templatesForMode(mode);
  const selectedTemplate = templates.find((template) => template.id === templateId) ?? defaultTemplateForMode(mode);
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
    return () => {
      mounted.current = false;
      historyRef.current.forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    };
  }, []);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const reload = () => void loadImageConfig();
    window.addEventListener(MODELS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, reload);
  }, []);

  useEffect(() => {
    if (!selectedImageModel) return;
    const defaults = selectedTemplate.mode === "image" ? selectedTemplate.defaults : undefined;
    const option = selectedImageModel.generationOptions.find((candidate) =>
      candidate.resolution === defaults?.imageResolution && candidate.aspectRatio === defaults.imageAspectRatio,
    ) ?? selectedImageModel.generationOptions.find((candidate) => candidate.aspectRatio === defaults?.imageAspectRatio)
      ?? selectedImageModel.generationOptions.find((candidate) => candidate.resolution === resolution && candidate.aspectRatio === aspectRatio)
      ?? selectedImageModel.generationOptions[0];
    if (option) {
      setResolution(option.resolution);
      setAspectRatio(option.aspectRatio);
    }
    setOutputs(Math.min(defaults?.imageOutputs ?? outputs, selectedImageModel.maxOutputs) as ImageOutputCount);
    if (!selectedImageModel.supportsReferenceImage) {
      setImageReference(undefined);
      setImageReferenceName(undefined);
    }
  }, [selectedImageModel, selectedTemplate]);

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
    setPanelView("history");
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
      const nextResult = { run: nextRun, urls: blobs.map((blob) => URL.createObjectURL(blob)), templateName: selectedTemplate.name };
      setResult(nextResult);
      addHistoryResult(nextResult);
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
    applyTemplate(defaultTemplateForMode(nextMode));
    setPanelView("templates");
    setResult(undefined);
    setSelectedResult(0);
    setGenerationError(undefined);
    setReferenceError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
  }

  function applyTemplate(template: AssetTemplate): void {
    setTemplateId(template.id);
    const prompt = template.defaultPrompt ?? "";
    const defaults = template.defaults;
    if (template.mode === "image") {
      setImagePrompt(prompt);
    } else if (template.mode === "video") {
      setVideoPrompt(prompt);
      if (defaults?.videoResolution) setVideoResolution(defaults.videoResolution);
      if (defaults?.videoAspectRatio) setVideoAspectRatio(defaults.videoAspectRatio);
      if (defaults?.videoDuration) setVideoDuration(defaults.videoDuration);
    } else if (template.mode === "3d") {
      setModel3DPrompt(prompt);
      if (defaults?.model3DQuality) setModel3DQuality(defaults.model3DQuality);
      if (defaults?.model3DPose) setModel3DPose(defaults.model3DPose);
      if (defaults?.model3DSource) setModel3DSource(defaults.model3DSource);
    }
    setGenerationError(undefined);
    setReferenceError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
  }

  function addHistoryResult(entry: PreviewResult): void {
    const entries = [entry, ...historyRef.current];
    const evicted = entries.splice(HISTORY_LIMIT);
    evicted.forEach((result) => result.urls.forEach((url) => URL.revokeObjectURL(url)));
    historyRef.current = entries;
    setHistory(entries);
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
  const modeHistory = history.filter((entry) => studioModeForTool(entry.run.toolId) === mode);

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
                    <PromptField id="asset-image-prompt" label={selectedTemplate.promptLabel} value={imagePrompt} disabled={generating} placeholder={selectedTemplate.promptPlaceholder} onChange={setImagePrompt} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <Field label="Model" htmlFor="asset-video-model"><ModelSelect id="asset-video-model" value={videoModel} options={VIDEO_MODEL_OPTIONS} disabled={generating} onChange={setVideoModel} /></Field>
                    <PromptField id="asset-video-prompt" label={selectedTemplate.promptLabel} value={videoPrompt} disabled={generating} placeholder={selectedTemplate.promptPlaceholder} onChange={setVideoPrompt} />
                  </>
                ) : (
                  <>
                    <Field label="Model" htmlFor="asset-3d-model"><ModelSelect id="asset-3d-model" value={model3D} options={MODEL_3D_OPTIONS} disabled={generating} onChange={setModel3D} /></Field>
                    <Model3DInputField
                      source={model3DSource}
                      prompt={model3DPrompt}
                      image={modelReference}
                      imageName={modelReferenceName}
                      promptLabel={selectedTemplate.promptLabel}
                      promptPlaceholder={selectedTemplate.promptPlaceholder}
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

          <section className="asset-result-panel" aria-label={panelView === "templates" ? "Asset templates" : "Generation history"}>
            <header><PanelViewSwitcher view={panelView} disabled={generating} onChange={setPanelView} /><div className="asset-result-actions" ref={resultActions}>{panelView === "history" && result ? <button type="button" aria-label="Result actions" aria-expanded={menuOpen} disabled={generating} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button> : null}{menuOpen && result && selectedFile && selectedUrl ? <div className="asset-result-menu" role="menu">
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
            <div className={`asset-result-canvas${panelView === "templates" ? " asset-template-gallery" : " asset-history-view"}${panelView === "history" && modeHistory.length ? " asset-history-grid" : ""}`}>
              {panelView === "templates" ? <TemplateGallery templates={templates} selectedId={selectedTemplate.id} onSelect={applyTemplate} /> : null}
              {panelView === "history" && generating ? <div className="asset-result-empty"><LoaderCircle className="spin" size={28} /><strong>Generating your {mode === "3d" ? "model" : mode}</strong><span>This may take a moment.</span></div> : null}
              {panelView === "history" && !generating && generationError && !modeHistory.length ? <div className="asset-result-empty asset-result-error" role="alert"><strong>Generation failed</strong><span>{generationError}</span></div> : null}
              {panelView === "history" && !generating && !generationError && !modeHistory.length ? <div className="asset-result-empty"><span className="asset-result-empty-icon"><HistoryIcon mode={mode} /></span><strong>No history yet</strong><span>Generated {mode === "3d" ? "models" : `${mode}s`} from this session will appear here.</span></div> : null}
              {panelView === "history" && !generating && modeHistory.length ? modeHistory.flatMap((entry) => entry.urls.map((url, index) => {
                const selected = result?.run.id === entry.run.id && selectedResult === index;
                return <button className={`asset-history-item${selected ? " is-selected" : ""}`} type="button" key={`${entry.run.id}:${index}`} aria-label={`Select ${entry.templateName} result`} onClick={() => { setResult(entry); setSelectedResult(index); setActionStatus(undefined); setMenuOpen(false); }}><span className="asset-history-preview"><ResultMedia mode={mode} url={url} label={entry.templateName} /></span><span className="asset-history-copy"><strong>{entry.templateName}</strong><small>{formatHistoryTime(entry.run.createdAt)}</small></span></button>;
              })) : null}
            </div>
            {generationError && modeHistory.length ? <p className="asset-result-notice is-error" role="alert">Generation failed: {generationError}</p> : actionStatus ? <p className={`asset-result-notice${actionStatus.type === "error" ? " is-error" : ""}`} role={actionStatus.type === "error" ? "alert" : "status"}>{actionStatus.message}</p> : null}
          </section>
        </div>
      </section>
    </main>
  );
}

function ModeSwitcher({ mode, disabled, onChange }: { mode: StudioMode; disabled: boolean; onChange: (mode: StudioMode) => void }) {
  return <div className="asset-mode-switcher" aria-label="Media type">{(["image", "video", "3d"] as const).map((value) => <button key={value} type="button" className={mode === value ? "is-active" : undefined} aria-pressed={mode === value} disabled={disabled} onClick={() => onChange(value)}>{value === "3d" ? "3D" : value[0].toUpperCase() + value.slice(1)}</button>)}</div>;
}

function PanelViewSwitcher({ view, disabled, onChange }: { view: AssetPanelView; disabled: boolean; onChange: (view: AssetPanelView) => void }) {
  return <div className="asset-panel-switcher" aria-label="Asset Studio view">{(["templates", "history"] as const).map((value) => <button key={value} type="button" className={view === value ? "is-active" : undefined} aria-pressed={view === value} disabled={disabled} onClick={() => onChange(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>;
}

function TemplateGallery({ templates, selectedId, onSelect }: { templates: readonly AssetTemplate[]; selectedId: string; onSelect: (template: AssetTemplate) => void }) {
  return <div className="asset-template-list">{templates.map((template) => <button className={`asset-template-card${template.id === selectedId ? " is-selected" : ""}`} type="button" key={template.id} aria-label={`${template.name}: ${template.description}`} aria-pressed={template.id === selectedId} onClick={() => onSelect(template)}><span className="asset-template-preview"><img src={template.previewImage} alt="" /></span><span className="asset-template-card-copy"><strong>{template.name}</strong></span></button>)}</div>;
}

function HistoryIcon({ mode }: { mode: StudioMode }) {
  if (mode === "video") return <Film size={24} />;
  if (mode === "3d") return <Box size={24} />;
  return <Image size={24} />;
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

function Model3DInputField({ source, prompt, image, imageName, promptLabel, promptPlaceholder, disabled, onSourceChange, onPromptChange, onChooseImage, onClearImage }: { source: Model3DSource; prompt: string; image?: PromptImage; imageName?: string; promptLabel: string; promptPlaceholder: string; disabled: boolean; onSourceChange: (source: Model3DSource) => void; onPromptChange: (prompt: string) => void; onChooseImage: () => void; onClearImage: () => void }) {
  return <div className={`asset-3d-input is-${source}`}><div className="asset-3d-input-header"><span>Input</span><SourceSwitch value={source} disabled={disabled} onChange={onSourceChange} /></div><div className="asset-3d-input-body">{source === "text"
    ? <PromptControl id="asset-3d-prompt" ariaLabel={promptLabel} value={prompt} maxLength={800} disabled={disabled} placeholder={promptPlaceholder} onChange={onPromptChange} />
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

function studioModeForTool(toolId: ToolRun["toolId"]): StudioMode {
  if (toolId === "generate-video") return "video";
  if (toolId === "image-to-3d") return "3d";
  return "image";
}

function formatHistoryTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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
