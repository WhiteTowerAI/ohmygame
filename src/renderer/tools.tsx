import { Download, FolderInput, Image, LoaderCircle, Minus, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ImageSize, ProjectState, ToolDefinition, ToolRun } from "../shared/contracts.js";
import { addToolResultToProject, getToolRunFile, getToolSettings, listProjects, listTools, runTool, updateToolSettings, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";

interface ImagesPageProps {
  onCommunity: () => void;
  onHome: () => void;
}

export function ImagesPage({ onCommunity, onHome }: ImagesPageProps) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [selectedTool, setSelectedTool] = useState<ToolDefinition>();
  const [enabledTools, setEnabledTools] = useState<ToolDefinition["id"][]>([]);
  const [updatingTool, setUpdatingTool] = useState<ToolDefinition["id"]>();
  const [settingsError, setSettingsError] = useState<string>();

  async function load() {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const [loadedTools, settings] = await Promise.all([listTools(), getToolSettings()]);
      setTools(loadedTools.filter((tool) => tool.category === "images"));
      setEnabledTools(settings.enabledTools);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function toggleTool(tool: ToolDefinition) {
    if (updatingTool) return;
    setUpdatingTool(tool.id);
    setSettingsError(undefined);
    const enabled = enabledTools.includes(tool.id);
    const next = enabled ? enabledTools.filter((id) => id !== tool.id) : [...enabledTools, tool.id];
    try {
      const settings = await updateToolSettings({ enabledTools: next });
      setEnabledTools(settings.enabledTools);
    } catch (cause) {
      setSettingsError(errorMessage(cause));
    } finally {
      setUpdatingTool(undefined);
    }
  }

  return (
    <main className="home-shell">
      <AppSidebar active="images" onCommunity={onCommunity} onHome={onHome} />
      <section className="tools-content">
        <header className="tools-heading">
          <div>
            <h1>Images</h1>
            <p>Generate an image before adding it to a project.</p>
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
              const enabled = enabledTools.includes(tool.id);
              const updating = updatingTool === tool.id;
              return (
                <article className="tool-card" key={tool.id}>
                  <div className="tool-card-summary">
                    <span className="tool-card-icon"><Image size={24} /></span>
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
                      disabled={Boolean(updatingTool)}
                      onClick={() => void toggleTool(tool)}
                    >
                      {updating ? <LoaderCircle className="spin" size={13} /> : enabled ? <Minus size={13} /> : <Plus size={13} />}
                      {enabled ? "Remove from Agent" : "Add to Agent"}
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
  const [size, setSize] = useState<ImageSize>(tool.defaultSize);
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

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    promptRef.current?.focus();
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
    if (!nextPrompt || busy) return;
    setGenerating(true);
    setError(undefined);
    setAddError(undefined);
    setAddedPath(undefined);
    try {
      const nextRun = await runTool(tool.id, { prompt: nextPrompt, size });
      if (!mountedRef.current) return;
      const file = nextRun.files[0];
      if (!file) throw new Error("The tool did not return an image");
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
            <span className="tool-dialog-icon"><Image size={18} /></span>
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
                <img src={previewUrl} alt={prompt} />
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
                  {tool.sizes.map((option) => (
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
            <button className="tool-primary-button" type="submit" form="tool-form" disabled={!prompt.trim() || generating}>
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "Generating..." : "Generate"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function sizeLabel(size: ImageSize): string {
  if (size === "1536x1024") return "Landscape";
  if (size === "1024x1536") return "Portrait";
  return "Square";
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
