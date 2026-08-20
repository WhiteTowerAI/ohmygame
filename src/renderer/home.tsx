import { ArrowUp, Image, LoaderCircle, MoreHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ProjectState, PromptImage } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { createConversation, createProject, deleteProject, duplicateProject, getProjectCover, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import type { SidebarPage } from "./routes.js";
import { useAuth } from "./auth.js";
import { UserAvatar } from "./user-avatar.js";

interface HomeProps {
  onNavigate: (page: SidebarPage) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, images: PromptImage[]) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_LIMIT = 4;

export function Home({ onNavigate, onCreate, onOpen }: HomeProps) {
  const auth = useAuth();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string>();
  const [projectActionError, setProjectActionError] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const modelCatalog = useAgentModels();

  async function loadProjects() {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      setProjects(await listProjects());
      setPhase("ready");
    } catch (error) {
      setLoadError(errorMessage(error));
      setPhase("error");
    }
  }

  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => {
    if (modelCatalog.models.some((candidate) => sameModel(candidate, model))) return;
    const fallback = modelCatalog.models.find((candidate) => sameModel(candidate, modelCatalog.defaultModel))
      ?? modelCatalog.models[0];
    if (!fallback || !sameModel(fallback, model)) setModel(fallback);
  }, [model, modelCatalog.models, modelCatalog.defaultModel]);
  useEffect(() => {
    const selected = modelCatalog.models.find((candidate) => sameModel(candidate, model));
    if (!selected) return;
    const next = clampReasoningLevel(reasoningLevel ?? modelCatalog.defaultReasoningLevel, selected.reasoningLevels);
    if (next && next !== reasoningLevel) setReasoningLevel(next);
  }, [model, modelCatalog.models, modelCatalog.defaultReasoningLevel, reasoningLevel]);
  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenProjectMenuId(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenProjectMenuId(undefined);
    };
    document.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  async function submitPrompt() {
    const nextPrompt = prompt.trim();
    if ((!nextPrompt && images.length === 0) || creating) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const project = await createProject();
      const conversation = await createConversation(project.id, model, reasoningLevel);
      onCreate(project.id, conversation.id, nextPrompt, promptImages(images));
    } catch (error) {
      setCreateError(errorMessage(error));
      setCreating(false);
    }
  }

  async function rename(project: ProjectState) {
    setOpenProjectMenuId(undefined);
    const name = window.prompt("Rename project", project.name)?.trim();
    if (!name || name === project.name) return;
    await runProjectAction(() => renameProject(project.id, name));
  }

  async function duplicate(project: ProjectState) {
    setOpenProjectMenuId(undefined);
    await runProjectAction(() => duplicateProject(project.id));
  }

  async function remove(project: ProjectState) {
    setOpenProjectMenuId(undefined);
    if (!window.confirm(`Delete “${project.name}”? This cannot be undone.`)) return;
    await runProjectAction(() => deleteProject(project.id));
  }

  async function runProjectAction(action: () => Promise<unknown>) {
    setProjectActionError(undefined);
    try {
      await action();
      await loadProjects();
    } catch (error) {
      setProjectActionError(errorMessage(error));
    }
  }

  const visibleProjects = showAllProjects ? projects : projects.slice(0, RECENT_PROJECT_LIMIT);

  return (
    <main className="home-shell">
      <AppSidebar active="home" onNavigate={onNavigate} />

      <section className="home-content">
        <div className="home-content-drag-region" aria-hidden="true" />
        <div className="home-start">
          <h1>Open Game</h1>
          <PromptBox
            actions={(
              <>
                <ModelSelector
                  models={modelCatalog.models}
                  value={model}
                  reasoningLevel={reasoningLevel}
                  disabled={creating}
                  onChange={setModel}
                  onReasoningChange={setReasoningLevel}
                />
                <button
                  className="icon-button send-button"
                  type="submit"
                  disabled={(!prompt.trim() && images.length === 0) || creating}
                  title="Create project"
                  aria-label="Create project"
                >
                  {creating ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}
                </button>
              </>
            )}
            content={<ImageAttachmentStrip images={images} onRemove={(id) => setImages((items) => items.filter((image) => image.id !== id))} />}
            disabled={creating}
            leading={<ImagePickerButton disabled={creating} onImages={(next) => { setCreateError(undefined); setImages((items) => [...items, ...next]); }} onError={setCreateError} />}
            onChange={setPrompt}
            onSubmit={() => void submitPrompt()}
            placeholder="Ask your agent to build anything"
            value={prompt}
            variant="home"
          />
          {createError ? <p className="home-notice" role="alert">{createError}</p> : null}
        </div>

        <section className="home-discover" aria-labelledby="whats-new-heading">
          <div className="home-section-heading">
            <h2 id="whats-new-heading">What's New</h2>
          </div>
          <div className="home-whats-new-grid">
            <button className="home-whats-new-item" type="button" onClick={() => onNavigate("images")}>
              <span className="home-whats-new-icon"><Image size={23} /></span>
              <span className="home-whats-new-copy">
                <strong>Image generation</strong>
                <span>Create game-ready images</span>
                <span className="home-whats-new-action">Try now <span aria-hidden="true">→</span></span>
              </span>
            </button>
          </div>

          <div className="home-section-heading home-project-heading">
            <h2 id="projects-heading">Recent projects</h2>
            {phase === "error" ? (
              <button type="button" onClick={() => void loadProjects()}>
                <RefreshCw size={14} />Retry
              </button>
            ) : projects.length > RECENT_PROJECT_LIMIT ? (
              <button className="home-show-all" type="button" onClick={() => setShowAllProjects((current) => !current)}>
                {showAllProjects ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>

          {phase === "loading" ? <ProjectGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? (
            <p className="home-project-state">No projects yet</p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="home-project-grid">
              {visibleProjects.map((project, index) => (
                <article className="home-project" key={project.id}>
                  <button className="home-project-open" type="button" onClick={() => onOpen(project.id)} aria-label={`Open ${project.name}`}>
                  <ProjectCover projectId={project.id} fallback={index % 4} />
                  <span className="home-project-meta">
                    {auth.state.status === "signed-in" ? (
                      <UserAvatar className="home-project-avatar" name={auth.state.user.name} avatarUrl={auth.state.user.avatarUrl} />
                    ) : <UserAvatar className="home-project-avatar" name="OpenGame" />}
                    <span className="home-project-copy">
                      <span className="home-project-name" title={project.name}>{project.name}</span>
                      <span className="home-project-time">{projectTime(project.updatedAt)}</span>
                    </span>
                  </span>
                  </button>
                  <div className="home-project-actions" ref={openProjectMenuId === project.id ? menuRef : undefined}>
                    <button
                      className="home-project-menu"
                      type="button"
                      aria-label={`Project actions for ${project.name}`}
                      aria-expanded={openProjectMenuId === project.id}
                      onClick={() => setOpenProjectMenuId((current) => current === project.id ? undefined : project.id)}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {openProjectMenuId === project.id ? (
                      <div className="home-project-actions-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => void rename(project)}>Rename</button>
                        <button type="button" role="menuitem" onClick={() => void duplicate(project)}>Duplicate</button>
                        <button className="home-project-actions-delete" type="button" role="menuitem" onClick={() => void remove(project)}>Delete</button>
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {projectActionError ? <p className="home-notice" role="alert">{projectActionError}</p> : null}
        </section>
      </section>
    </main>
  );
}

function sameModel(model: AgentModel, value?: AgentModelRef): boolean {
  return Boolean(value && model.provider === value.provider && model.id === value.id);
}

function ProjectCover({ projectId, fallback }: { projectId: string; fallback: number }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let objectUrl: string | undefined;
    let disposed = false;
    void getProjectCover(projectId).then((cover) => {
      if (!cover || disposed) return;
      objectUrl = URL.createObjectURL(cover);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId]);

  return (
    <span className={`home-project-preview home-project-preview-${fallback}`} aria-hidden="true">
      {url ? <img src={url} alt="" /> : null}
    </span>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="home-project-grid" aria-label="Loading projects">
      {[0, 1, 2, 3].map((item) => <div className="home-project home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Edited just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Edited ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Edited ${days}d ago`;
}
