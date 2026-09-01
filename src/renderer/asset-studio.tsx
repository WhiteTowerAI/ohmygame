import { ChevronDown, Download, FolderInput, Image, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Sparkles, X } from "./icons.js";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageModel,
  type ImageOutputCount,
  type ImageResolution,
  type ProjectState,
  type PromptImage,
  type ToolRun,
  type VideoAspectRatio,
  type VideoResolution,
} from "../shared/contracts.js";
import { addToolResultToProject, getImageGenerationSettings, getToolRunFile, listImageModels, listProjects, runTool, updateImageGenerationSettings, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";
import { ModelPreview } from "./model-preview.js";
import { WindowDragRegion } from "./window-drag-region.js";

interface AssetStudioPageProps {
  onNavigate: (page: SidebarPage) => void;
}

type StudioMode = "image" | "video" | "3d";

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
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoReference, setVideoReference] = useState<PromptImage>();
  const [videoReferenceName, setVideoReferenceName] = useState<string>();
  const [videoAspectRatio, setVideoAspectRatio] = useState<VideoAspectRatio>("16:9");
  const [videoResolution, setVideoResolution] = useState<VideoResolution>("720p");
  const [videoDuration, setVideoDuration] = useState(6);
  const [modelReference, setModelReference] = useState<PromptImage>();
  const [modelReferenceName, setModelReferenceName] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PreviewResult>();
  const [selectedResult, setSelectedResult] = useState(0);
  const [generationError, setGenerationError] = useState<string>();
  const [referenceError, setReferenceError] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectsError, setProjectsError] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ type: "success" | "error"; message: string }>();
  const mounted = useRef(true);
  const uploadInput = useRef<HTMLInputElement>(null);
  const resultActions = useRef<HTMLDivElement>(null);

  const selectedImageModel = imageModels.find((model) => modelKey(model) === imageModelKey);
  const selectedFile = result?.run.files[selectedResult];
  const selectedUrl = result?.urls[selectedResult];
  const canGenerate = mode === "image"
    ? Boolean(imagePrompt.trim() && selectedImageModel)
    : mode === "video"
      ? Boolean(videoPrompt.trim())
      : Boolean(modelReference);

  useEffect(() => {
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    void load();
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
      setSelectedProjectId(loadedProjects[0]?.id ?? "");
    } catch (cause) {
      if (!mounted.current) return;
      setProjects([]);
      setSelectedProjectId("");
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
        nextRun = await runTool("image-to-3d", { image: modelReference! });
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

  async function addToProject(): Promise<void> {
    if (!result || !selectedFile || !selectedProjectId || adding) return;
    setAdding(true);
    setActionStatus(undefined);
    try {
      const asset = await addToolResultToProject(selectedProjectId, { runId: result.run.id, fileName: selectedFile.name });
      if (mounted.current) setActionStatus({ type: "success", message: `Added to ${asset.path}` });
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
                      {imagePhase === "ready" && imageModels.length ? <div className="asset-select-wrap"><select id="asset-model" value={imageModelKey} disabled={generating} onChange={(event) => setImageModelKey(event.target.value)}>{imageModels.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.name}</option>)}</select><ChevronDown size={14} /></div> : null}
                      {imagePhase === "ready" && !imageModels.length ? <p className="asset-inline-state">No image model is connected</p> : null}
                    </Field>
                    <PromptField id="asset-image-prompt" label="Prompt" value={imagePrompt} disabled={generating} placeholder="A stylized floating island at sunrise, soft volumetric light, game concept art..." onChange={setImagePrompt} />
                  </>
                ) : mode === "video" ? (
                  <PromptField id="asset-video-prompt" label="Prompt" value={videoPrompt} disabled={generating} placeholder="Describe the scene, motion, and camera movement..." onChange={setVideoPrompt} />
                ) : null}

                <ReferenceField image={reference} name={referenceName} optional={mode !== "3d"} allowWebP={mode === "image"} disabled={generating || (mode === "image" && !selectedImageModel?.supportsReferenceImage)} onChoose={() => uploadInput.current?.click()} onClear={() => {
                  if (mode === "image") { setImageReference(undefined); setImageReferenceName(undefined); }
                  else if (mode === "video") { setVideoReference(undefined); setVideoReferenceName(undefined); }
                  else { setModelReference(undefined); setModelReferenceName(undefined); }
                  setReferenceError(undefined);
                }} />
                {referenceError ? <p className="asset-field-error" role="alert">{referenceError}</p> : null}
                <input ref={uploadInput} hidden type="file" accept={mode === "image" ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg"} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void selectReference(file);
                }} />

                {mode === "image" ? (
                  <>
                    <OptionGroup label="Resolution" values={IMAGE_RESOLUTIONS} value={resolution} disabled={generating} isOptionDisabled={(value) => !selectedImageModel?.generationOptions.some((option) => option.resolution === value)} onChange={chooseImageResolution} />
                    <OptionGroup label="Aspect ratio" values={IMAGE_ASPECT_RATIOS} value={aspectRatio} disabled={generating} isOptionDisabled={(value) => !selectedImageModel?.generationOptions.some((option) => option.resolution === resolution && option.aspectRatio === value)} onChange={chooseImageAspectRatio} />
                    <OptionGroup label="Outputs" values={IMAGE_OUTPUT_COUNTS} value={outputs} disabled={generating} isOptionDisabled={(value) => !selectedImageModel || value > selectedImageModel.maxOutputs} onChange={setOutputs} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <OptionGroup label="Resolution" values={VIDEO_RESOLUTIONS} value={videoResolution} disabled={generating} onChange={setVideoResolution} />
                    <OptionGroup label="Aspect ratio" values={VIDEO_ASPECT_RATIOS} value={videoAspectRatio} disabled={generating} onChange={setVideoAspectRatio} />
                    <OptionGroup label="Duration" values={VIDEO_DURATIONS} value={videoDuration} disabled={generating} format={(value) => `${value}s`} onChange={setVideoDuration} />
                  </>
                ) : null}
              </div>
            ) : null}
            <button className="asset-generate-button" type="submit" disabled={phase !== "ready" || !canGenerate || generating}>
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "Generating..." : "Generate"}
            </button>
          </form>

          <section className="asset-result-panel" aria-label="Generation result">
            <header><h1>Result</h1><div className="asset-result-actions" ref={resultActions}><button type="button" aria-label="Result actions" aria-expanded={menuOpen} disabled={!result || generating} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>{menuOpen && result && selectedFile && selectedUrl ? <div className="asset-result-menu">
              <a href={selectedUrl} download={selectedFile.name}><Download size={14} />Download</a>
              {projects.length ? <><select aria-label="Project" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" disabled={adding} onClick={() => void addToProject()}>{adding ? <LoaderCircle className="spin" size={14} /> : <FolderInput size={14} />}Add to Project</button></> : null}
              {projectsError ? <button type="button" onClick={() => void loadProjectList()}><RefreshCw size={14} />Retry projects</button> : null}
              <button type="button" disabled={generating} onClick={() => void generate()}><RefreshCw size={14} />Regenerate</button>
            </div> : null}</div></header>
            <div className={`asset-result-canvas${result && result.urls.length > 1 ? " asset-result-grid" : ""}`}>
              {generating ? <div className="asset-result-empty"><LoaderCircle className="spin" size={28} /><strong>Generating your {mode === "3d" ? "model" : mode}</strong><span>This may take a moment.</span></div> : null}
              {!generating && generationError ? <div className="asset-result-empty asset-result-error" role="alert"><strong>Generation failed</strong><span>{generationError}</span></div> : null}
              {!generating && !generationError && !result ? <div className="asset-result-empty"><span className="asset-result-empty-icon"><Image size={24} /></span><strong>Your result will appear here</strong><span>{mode === "3d" ? "Add a reference and generate your first model." : `Add a prompt and generate your first ${mode}.`}</span></div> : null}
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

function PromptField({ id, label, value, placeholder, disabled, onChange }: { id: string; label: string; value: string; placeholder: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Field label={label} htmlFor={id}><div className="asset-prompt-wrap"><textarea id={id} maxLength={2000} value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span>{value.length.toLocaleString()} / 2,000</span></div></Field>;
}

function ReferenceField({ image, name, optional, allowWebP, disabled, onChoose, onClear }: { image?: PromptImage; name?: string; optional: boolean; allowWebP: boolean; disabled: boolean; onChoose: () => void; onClear: () => void }) {
  return <Field label="Reference image"><div className={`asset-reference${image ? " has-image" : ""}`}><button type="button" disabled={disabled} onClick={onChoose}>{image ? <img src={`data:${image.mediaType};base64,${image.data}`} alt="Reference" /> : <span className="asset-reference-icon"><Plus size={16} /></span>}<span className="asset-reference-copy"><strong>{name ?? "Add a reference"}</strong><small>{name ?? `PNG, JPG${allowWebP ? " or WebP" : ""}${optional ? " · optional" : ""}`}</small></span></button>{image ? <button className="asset-reference-clear" type="button" aria-label="Remove reference" disabled={disabled} onClick={onClear}><X size={13} /></button> : null}</div></Field>;
}

function ResultMedia({ mode, url, label }: { mode: StudioMode; url: string; label: string }) {
  if (mode === "3d") return <ModelPreview source={url} label="Generated 3D model" minHeight={420} />;
  if (mode === "video") return <video src={url} controls preload="metadata" />;
  return <img src={url} alt={label} />;
}

function OptionGroup<T extends string | number>({ label, values, value, disabled, isOptionDisabled, format, onChange }: { label: string; values: readonly T[]; value: T; disabled: boolean; isOptionDisabled?: (value: T) => boolean; format?: (value: T) => string; onChange: (value: T) => void }) {
  return <fieldset className="asset-option-group" disabled={disabled}><legend>{label}</legend><div>{values.map((option) => <button type="button" key={option} className={option === value ? "is-active" : undefined} aria-pressed={option === value} disabled={disabled || isOptionDisabled?.(option)} onClick={() => onChange(option)}>{format ? format(option) : option}</button>)}</div></fieldset>;
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
