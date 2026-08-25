import { ArrowUp, Image, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ProjectState, PromptImage, PromptMode } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { createConversation, createProject, deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";
import { matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ProjectCard } from "./project-card.js";
import type { SidebarPage } from "./routes.js";

interface HomeProps {
  onNavigate: (page: SidebarPage) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, images: PromptImage[], mode: PromptMode) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_LIMIT = 4;

export function Home({ onNavigate, onCreate, onOpen }: HomeProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string>();
  const promptRef = useRef<HTMLTextAreaElement>(null);
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
  async function submitPrompt() {
    if (matchesPlanCommand(prompt)) {
      togglePlanning();
      return;
    }
    const nextPrompt = prompt.trim();
    if ((!nextPrompt && images.length === 0) || creating) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const project = await createProject({ type: "general" });
      const conversation = await createConversation(project.id, model, reasoningLevel);
      onCreate(project.id, conversation.id, nextPrompt, promptImages(images), planning ? "planning" : "normal");
    } catch (error) {
      setCreateError(errorMessage(error));
      setCreating(false);
    }
  }

  function togglePlanning() {
    setPlanning((value) => !value);
    setPrompt("");
    promptRef.current?.focus();
  }

  async function rename(project: ProjectState) {
    const name = window.prompt("Rename project", project.name)?.trim();
    if (!name || name === project.name) return;
    await runProjectAction(() => renameProject(project.id, name));
  }

  async function duplicate(project: ProjectState) {
    await runProjectAction(() => duplicateProject(project.id));
  }

  async function remove(project: ProjectState) {
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

  const generalProjects = projects.filter((project) => project.type === "general");
  const visibleProjects = showAllProjects ? generalProjects : generalProjects.slice(0, RECENT_PROJECT_LIMIT);

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
            leading={(
              <>
                <ImagePickerButton disabled={creating} onImages={(next) => { setCreateError(undefined); setImages((items) => [...items, ...next]); }} onError={setCreateError} />
                {planning ? <PlanModeIndicator disabled={creating} onExit={togglePlanning} /> : null}
              </>
            )}
            onChange={setPrompt}
            onSubmit={() => void submitPrompt()}
            overlay={matchesPlanCommand(prompt) ? <PlanCommandMenu planning={planning} onToggle={togglePlanning} /> : null}
            placeholder={planning ? "Describe what to plan" : "Ask your agent to build anything"}
            textareaRef={promptRef}
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
            <button className="home-whats-new-item" type="button" onClick={() => onNavigate("asset-studio")}>
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
            ) : generalProjects.length > RECENT_PROJECT_LIMIT ? (
              <button className="home-show-all" type="button" onClick={() => setShowAllProjects((current) => !current)}>
                {showAllProjects ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>

          {phase === "loading" ? <ProjectGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && generalProjects.length === 0 ? (
            <p className="home-project-state">No projects yet</p>
          ) : null}
          {phase === "ready" && generalProjects.length > 0 ? (
            <div className="home-project-grid">
              {visibleProjects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  fallback={index % 4}
                  onOpen={() => onOpen(project.id)}
                  actions={{ onRename: () => void rename(project), onDuplicate: () => void duplicate(project), onDelete: () => void remove(project) }}
                />
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

function ProjectGridSkeleton() {
  return (
    <div className="home-project-grid" aria-label="Loading projects">
      {[0, 1, 2, 3].map((item) => <div className="project-card home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
