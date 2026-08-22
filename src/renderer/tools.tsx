import { Box, Check, Download, FolderInput, Image, LoaderCircle, RefreshCw, Sparkles, Upload, Video, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { VIDEO_ASPECT_RATIOS, VIDEO_DURATIONS, VIDEO_RESOLUTIONS, type ImageModel, type ImageSize, type ProjectState, type PromptImage, type ToolDefinition, type ToolRun, type VideoAspectRatio, type VideoResolution } from "../shared/contracts.js";
import { addToolResultToProject, getImageGenerationSettings, getToolRunFile, getToolSettings, listImageModels, listProjects, listTools, runTool, updateImageGenerationSettings, updateToolSettings, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";
import { ModelPreview } from "./model-preview.js";

interface ImagesPageProps {
  page: "images" | "3d" | "video";
  onNavigate: (page: SidebarPage) => void;
}

export function ImagesPage({ page, onNavigate }: ImagesPageProps) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [selectedTool, setSelectedTool] = useState<ToolDefinition>();
  const [installedTools, setInstalledTools] = useState<ToolDefinition["id"][]>([]);
  const [enabledTools, setEnabledTools] = useState<ToolDefinition["id"][]>([]);
  const [updatingTool, setUpdatingTool] = useState<ToolDefinition["id"]>();
  const [settingsError, setSettingsError] = useState<string>();

  async function load() {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const [loadedTools, settings] = await Promise.all([listTools(), getToolSettings()]);
      setTools(loadedTools.filter((tool) => tool.category === page));
      setInstalledTools(settings.installedTools);
      setEnabledTools(settings.enabledTools);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, [page]);

  async function installTool(tool: ToolDefinition) {
    if (updatingTool || installedTools.includes(tool.id)) return;
    setUpdatingTool(tool.id);
    setSettingsError(undefined);
    try {
      const settings = await updateToolSettings({
        installedTools: [...installedTools, tool.id],
        enabledTools: [...enabledTools, tool.id],
      });
      setInstalledTools(settings.installedTools);
      setEnabledTools(settings.enabledTools);
    } catch (cause) {
      setSettingsError(errorMessage(cause));
    } finally {
      setUpdatingTool(undefined);
    }
  }

  return (
    <main className="home-shell">
      <AppSidebar active={page} onNavigate={onNavigate} />
      <section className="tools-content">
        <header className="tools-heading">
          <div>
            <h1>{page === "3d" ? "3D" : page === "video" ? "Video" : "Images"}</h1>
            <p>{page === "3d" ? "Turn a reference image into a project-ready 3D asset." : page === "video" ? "Animate a reference image into a project-ready video." : "Generate an image before adding it to a project."}</p>
          </div>
          {phase === "error" ? (
            <button className="tools-retry" type="button" onClick={() => void load()}>
              <RefreshCw size={14} /> Retry
            </button>
          ) : null}
        </header>

        {phase === "loading" ? <div className="tools-state"><LoaderCircle className="spin" size={18} />Loading tools</div> : null}
        {phase === "error" ? <div className="tools-state tools-error" role="alert">{error}</div> : null}
        {settingsError ? <div className="tools-inline-error" role="alert">{settingsError}</div> : null}
        {phase === "ready" ? (
          <div className="tools-grid">
            {tools.map((tool) => {
              const installed = installedTools.includes(tool.id);
              const updating = updatingTool === tool.id;
              return (
                <article className="tool-card" key={tool.id}>
                  <div className="tool-card-summary">
                    <span className="tool-card-icon">{tool.outputKind === "model" ? <Box size={24} /> : tool.outputKind === "video" ? <Video size={24} /> : <Image size={24} />}</span>
                    <span className="tool-card-copy">
                      <strong>{tool.name}</strong>
                      <span>{tool.description}</span>
                    </span>
                  </div>
                  <div className="tool-card-actions">
                    <button className="tool-card-action" type="button" onClick={() => setSelectedTool(tool)}>Open</button>
                    <button
                      className="tool-agent-toggle"
                      type="button"
                      disabled={Boolean(updatingTool) || installed}
                      onClick={() => void installTool(tool)}
                    >
                      {updating ? <LoaderCircle className="spin" size={13} /> : installed ? <Check size={13} /> : null}
                      {updating ? "Installing…" : installed ? "Installed" : "Install"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      {selectedTool ? <ToolDialog tool={selectedTool} onClose={() => setSelectedTool(undefined)} /> : null}
    </main>
  );
}

function ToolDialog({ tool, onClose }: { tool: ToolDefinition; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [imageModel, setImageModel] = useState<string>("");
  const [imageModelError, setImageModelError] = useState<string>();
  const [size, setSize] = useState<ImageSize>(tool.inputKind === "prompt" ? tool.defaultSize : "1024x1024");
  const [sourceImage, setSourceImage] = useState<PromptImage>();
  const [sourceName, setSourceName] = useState<string>();
  const [videoMode, setVideoMode] = useState<"text" | "image">("image");
  const [videoAspectRatio, setVideoAspectRatio] = useState<VideoAspectRatio>("16:9");
  const [videoResolution, setVideoResolution] = useState<VideoResolution>("720p");
  const [videoDuration, setVideoDuration] = useState(6);
  const [generating, setGenerating] = useState(false);
  const [run, setRun] = useState<ToolRun>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectsPhase, setProjectsPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string>();
  const [addedPath, setAddedPath] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const busy = generating || adding;
  const selectedImageModel = imageModels.find((model) => imageModelKey(model) === imageModel);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (tool.inputKind === "prompt" || tool.inputKind === "image-prompt") promptRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (tool.id !== "generate-image") return;
    void Promise.all([listImageModels(), getImageGenerationSettings()]).then(([models, settings]) => {
      if (!mountedRef.current) return;
      setImageModels(models);
      const selected = settings.model && models.some((model) => model.provider === settings.model?.provider && model.id === settings.model?.id)
        ? settings.model
        : models[0];
      setImageModel(selected ? imageModelKey(selected) : "");
    }).catch((cause) => {
      if (mountedRef.current) setImageModelError(errorMessage(cause));
    });
  }, [tool.id]);

  useEffect(() => {
    if (!selectedImageModel || selectedImageModel.sizes.includes(size)) return;
    setSize(selectedImageModel.sizes[0] ?? "1024x1024");
  }, [selectedImageModel, size]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function loadProjects() {
    setProjectsPhase("loading");
    setAddError(undefined);
    try {
      const loaded = await listProjects();
      if (!mountedRef.current) return;
      setProjects(loaded);
      setSelectedProjectId(loaded[0]?.id ?? "");
      setProjectsPhase("ready");
    } catch (cause) {
      if (!mountedRef.current) return;
      setAddError(errorMessage(cause));
      setProjectsPhase("error");
    }
  }

  useEffect(() => {
    if (!previewUrl) return;
    void loadProjects();
  }, [previewUrl]);

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    const nextPrompt = prompt.trim();
    if (busy || (tool.inputKind === "prompt" ? !nextPrompt : tool.inputKind === "image-prompt" ? !nextPrompt || (videoMode === "image" && !sourceImage) : !sourceImage)) return;
    setGenerating(true);
    setError(undefined);
    setAddError(undefined);
    setAddedPath(undefined);
    try {
      if (tool.inputKind === "prompt") {
        if (!selectedImageModel) throw new Error("Connect an image model before generating");
        await updateImageGenerationSettings({ model: { provider: selectedImageModel.provider, id: selectedImageModel.id } });
      }
      const nextRun = tool.inputKind === "prompt"
          ? await runTool(tool.id, { prompt: nextPrompt, size })
          : tool.inputKind === "image-prompt"
          ? await runTool(tool.id, { prompt: nextPrompt, duration: videoDuration, aspectRatio: videoAspectRatio, resolution: videoResolution, ...(videoMode === "image" ? { image: sourceImage! } : {}) })
          : await runTool(tool.id, { image: sourceImage! });
      if (!mountedRef.current) return;
      const file = nextRun.files[0];
      if (!file) throw new Error("The tool did not return a result");
      const blob = await getToolRunFile(nextRun.id, file.name);
      if (!mountedRef.current) return;
      setRun(nextRun);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }

  async function addToProject() {
    const file = run?.files[0];
    if (!run || !file || !selectedProjectId || busy) return;
    setAdding(true);
    setAddError(undefined);
    try {
      const asset = await addToolResultToProject(selectedProjectId, { runId: run.id, fileName: file.name });
      if (mountedRef.current) setAddedPath(asset.path);
    } catch (cause) {
      if (mountedRef.current) setAddError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setAdding(false);
    }
  }

  return (
    <div className="tool-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section ref={dialogRef} className="tool-dialog" role="dialog" aria-modal="true" aria-labelledby="tool-dialog-title" tabIndex={-1}>
        <header className="tool-dialog-header">
          <div>
            <span className="tool-dialog-icon">{tool.outputKind === "model" ? <Box size={18} /> : tool.outputKind === "video" ? <Video size={18} /> : <Image size={18} />}</span>
            <div>
              <h2 id="tool-dialog-title">{tool.name}</h2>
              <p>{tool.description}</p>
            </div>
          </div>
          <button className="icon-button quiet-button" type="button" onClick={onClose} disabled={busy} title="Close" aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="tool-dialog-body">
          {previewUrl ? (
            <>
              <div className="tool-result-preview">
                {tool.outputKind === "model" ? <ModelPreview source={previewUrl} label="Generated 3D model" minHeight={360} /> : tool.outputKind === "video" ? <video className="tool-result-video" src={previewUrl} controls preload="metadata" /> : <img src={previewUrl} alt={prompt} />}
              </div>
              <div className="tool-project-target">
                <label htmlFor="tool-project">Project</label>
                {projectsPhase === "loading" ? <span className="tool-project-state"><LoaderCircle className="spin" size={14} />Loading projects</span> : null}
                {projectsPhase === "error" ? (
                  <button className="tool-secondary-button" type="button" disabled={busy} onClick={() => void loadProjects()}>
                    <RefreshCw size={14} /> Retry
                  </button>
                ) : null}
                {projectsPhase === "ready" && projects.length === 0 ? <span className="tool-project-state">No projects available</span> : null}
                {projectsPhase === "ready" && projects.length > 0 ? (
                  <div>
                    <select id="tool-project" value={selectedProjectId} disabled={busy} onChange={(event) => {
                      setSelectedProjectId(event.target.value);
                      setAddedPath(undefined);
                      setAddError(undefined);
                    }}>
                      {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
                    </select>
                    <button className="tool-secondary-button" type="button" disabled={!selectedProjectId || busy} onClick={() => void addToProject()}>
                      {adding ? <LoaderCircle className="spin" size={15} /> : <FolderInput size={15} />}
                      {adding ? "Adding..." : "Add to Project"}
                    </button>
                  </div>
                ) : null}
                {addedPath ? <p className="tool-project-success">Added to {addedPath}</p> : null}
                {addError ? <p className="tool-dialog-error" role="alert">{addError}</p> : null}
              </div>
            </>
          ) : (
            <form id="tool-form" className="tool-form" onSubmit={generate}>
              {tool.inputKind === "prompt" ? (
                <>
                  <label htmlFor="tool-image-model">Model</label>
                  {imageModels.length > 0 ? <select id="tool-image-model" value={imageModel} disabled={generating} onChange={(event) => {
                    setImageModel(event.target.value);
                    setImageModelError(undefined);
                  }}>
                    {imageModels.map((model) => <option key={imageModelKey(model)} value={imageModelKey(model)}>{model.providerName} · {model.name}</option>)}
                  </select> : <span className="tool-project-state">No image model is connected</span>}
                  {imageModelError ? <p className="tool-dialog-error" role="alert">{imageModelError}</p> : null}
                  <label htmlFor="tool-prompt">Prompt</label>
                  <textarea
                    id="tool-prompt"
                    ref={promptRef}
                    rows={5}
                    value={prompt}
                    disabled={generating}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Describe the image you want to create"
                  />
                  <fieldset disabled={generating}>
                    <legend>Size</legend>
                    <div className="tool-size-options">
                      {(selectedImageModel?.sizes ?? tool.sizes).map((option) => (
                        <button
                          className={option === size ? "tool-size-active" : undefined}
                          type="button"
                          key={option}
                          onClick={() => setSize(option)}
                          aria-pressed={option === size}
                        >
                          {sizeLabel(option)}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </>
              ) : tool.inputKind === "image-prompt" ? (
                <VideoInput
                  prompt={prompt}
                  image={sourceImage}
                  name={sourceName}
                  mode={videoMode}
                  disabled={generating}
                  promptRef={promptRef}
                  onModeChange={(mode) => { setVideoMode(mode); setSourceImage(undefined); setSourceName(undefined); setError(undefined); }}
                  aspectRatio={videoAspectRatio}
                  resolution={videoResolution}
                  duration={videoDuration}
                  onAspectRatioChange={setVideoAspectRatio}
                  onResolutionChange={setVideoResolution}
                  onDurationChange={setVideoDuration}
                  onPromptChange={setPrompt}
                  onChange={(image, name) => { setSourceImage(image); setSourceName(name); setError(undefined); }}
                  onError={setError}
                />
              ) : (
                <ImageTo3DInput image={sourceImage} name={sourceName} disabled={generating} onChange={(image, name) => {
                  setSourceImage(image);
                  setSourceName(name);
                  setError(undefined);
                }} onError={setError} />
              )}
            </form>
          )}
          {error ? <p className="tool-dialog-error" role="alert">{error}</p> : null}
        </div>

        <footer className="tool-dialog-footer">
          {previewUrl && run ? (
            <>
              <button className="tool-secondary-button" type="button" onClick={() => void generate()} disabled={busy}>
                {generating ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                Regenerate
              </button>
              <a className="tool-primary-button" href={previewUrl} download={run.files[0]?.name ?? "output.webp"}>
                <Download size={15} /> Download
              </a>
            </>
          ) : (
            <button className="tool-primary-button" type="submit" form="tool-form" disabled={(tool.inputKind === "prompt" ? !prompt.trim() || !imageModel : tool.inputKind === "image-prompt" ? !prompt.trim() || (videoMode === "image" && !sourceImage) : !sourceImage) || generating}>
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "Generating..." : "Generate"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function VideoInput({ prompt, image, name, mode, aspectRatio, resolution, duration, disabled, promptRef, onModeChange, onAspectRatioChange, onResolutionChange, onDurationChange, onPromptChange, onChange, onError }: {
  prompt: string;
  image?: PromptImage;
  name?: string;
  mode: "text" | "image";
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  duration: number;
  disabled: boolean;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  onModeChange: (mode: "text" | "image") => void;
  onAspectRatioChange: (value: VideoAspectRatio) => void;
  onResolutionChange: (value: VideoResolution) => void;
  onDurationChange: (value: number) => void;
  onPromptChange: (value: string) => void;
  onChange: (image: PromptImage, name: string) => void;
  onError: (message?: string) => void;
}) {
  return (
    <>
      <fieldset disabled={disabled}>
        <legend>Mode</legend>
        <div className="tool-size-options">
          <button type="button" className={mode === "text" ? "tool-size-active" : undefined} aria-pressed={mode === "text"} onClick={() => onModeChange("text")}>Text to Video</button>
          <button type="button" className={mode === "image" ? "tool-size-active" : undefined} aria-pressed={mode === "image"} onClick={() => onModeChange("image")}>Image to Video</button>
        </div>
      </fieldset>
      <label htmlFor="tool-video-prompt">Motion prompt</label>
      <textarea id="tool-video-prompt" ref={promptRef} rows={5} value={prompt} disabled={disabled} onChange={(event) => onPromptChange(event.target.value)} placeholder="Describe the motion and camera movement" />
      <div className="tool-video-options">
        <div className="tool-video-field">
          <label htmlFor="tool-video-aspect-ratio">Aspect ratio</label>
          <select id="tool-video-aspect-ratio" value={aspectRatio} disabled={disabled} onChange={(event) => onAspectRatioChange(event.target.value as VideoAspectRatio)}>
            {VIDEO_ASPECT_RATIOS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="tool-video-field">
          <label htmlFor="tool-video-resolution">Resolution</label>
          <select id="tool-video-resolution" value={resolution} disabled={disabled} onChange={(event) => onResolutionChange(event.target.value as VideoResolution)}>
            {VIDEO_RESOLUTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="tool-video-field">
          <label htmlFor="tool-video-duration">Duration</label>
          <select id="tool-video-duration" value={duration} disabled={disabled} onChange={(event) => onDurationChange(Number(event.target.value))}>
            {VIDEO_DURATIONS.map((option) => <option key={option} value={option}>{option}s</option>)}
          </select>
        </div>
      </div>
      {mode === "image" ? <ImageTo3DInput image={image} name={name} disabled={disabled} onChange={onChange} onError={onError} /> : null}
    </>
  );
}

function ImageTo3DInput({ image, name, disabled, onChange, onError }: {
  image?: PromptImage;
  name?: string;
  disabled: boolean;
  onChange: (image: PromptImage, name: string) => void;
  onError: (message?: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <label>Reference image</label>
      <button className="tool-image-input" type="button" disabled={disabled} onClick={() => input.current?.click()}>
        {image ? <img src={`data:${image.mediaType};base64,${image.data}`} alt={name ?? "Reference"} /> : <span><Upload size={20} />Choose a PNG or JPEG</span>}
      </button>
      {name ? <p className="tool-image-name">{name}</p> : null}
      <input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        void readImage(file).then((next) => onChange(next, file.name)).catch((cause) => onError(errorMessage(cause)));
      }} />
    </>
  );
}

async function readImage(file: File): Promise<PromptImage> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("Use a PNG or JPEG image");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  return { mediaType: file.type, data };
}

function sizeLabel(size: ImageSize): string {
  if (size === "1536x1024") return "Landscape";
  if (size === "1024x1536") return "Portrait";
  return "Square";
}

function imageModelKey(model: Pick<ImageModel, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
  ));
}
