import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Globe2, LoaderCircle, RefreshCw } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ProjectState, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { createConversation, createProject, deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";
import { matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ProjectCard } from "./project-card.js";
import type { SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import playableCanvas from "./assets/home/playable-canvas.svg";
import cozyTown from "./assets/home/cozy-town.svg";
import dialogueDirector from "./assets/home/dialogue-director.svg";
import creatorWeek from "./assets/home/creator-week.svg";
import neonDrift from "./assets/home/neon-drift.svg";

interface HomeProps {
  onNavigate: (page: SidebarPage) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, images: PromptImage[], mode: PromptMode) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_LIMIT = 4;
const PROJECT_TYPES = [
  { label: "Web Game", value: "web-game" },
  { label: "Interactive Drama", value: "interactive-drama" },
  { label: "Godot", value: "godot-game" },
] as const satisfies ReadonlyArray<{ label: string; value: ProjectType }>;
const WHATS_NEW = [
  { title: "Playable Canvas is here", image: playableCanvas, page: "home" as SidebarPage },
  { title: "Cozy Town Starter Kit", image: cozyTown, page: "library" as SidebarPage },
  { title: "Dialogue Director", image: dialogueDirector, page: "interactive-drama" as SidebarPage },
  { title: "Creator Week rewards", image: creatorWeek, page: "community" as SidebarPage },
  { title: "Neon Drift", image: neonDrift, page: "community" as SidebarPage },
];

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
  const [projectType, setProjectType] = useState<ProjectType>("web-game");
  const [whatsNewScroll, setWhatsNewScroll] = useState({ canGoBack: false, canGoForward: false });
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const whatsNewRef = useRef<HTMLDivElement>(null);
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
    const carousel = whatsNewRef.current;
    if (!carousel) return;
    const updateScrollState = () => {
      const maxScrollLeft = carousel.scrollWidth - carousel.clientWidth;
      const canGoBack = carousel.scrollLeft > 1;
      const canGoForward = carousel.scrollLeft < maxScrollLeft - 1;
      setWhatsNewScroll((current) => (
        current.canGoBack === canGoBack && current.canGoForward === canGoForward
          ? current
          : { canGoBack, canGoForward }
      ));
    };
    updateScrollState();
    carousel.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      carousel.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, []);
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
      const project = await createProject({ type: projectType });
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

  const visibleProjects = showAllProjects ? projects : projects.slice(0, RECENT_PROJECT_LIMIT);

  return (
    <main className="home-shell">
      <AppSidebar active="home" onNavigate={onNavigate} />

      <section className="home-content">
        <WindowDragRegion />
        <div className="home-start">
          <h1>What are we making today?</h1>
          <fieldset className="home-category-control">
            <legend className="visually-hidden">Project type</legend>
            {PROJECT_TYPES.map(({ label, value }) => (
              <label
                className={value === projectType ? "is-active" : ""}
                key={value}
              >
                <input
                  className="visually-hidden"
                  type="radio"
                  name="home-project-type"
                  value={value}
                  checked={value === projectType}
                  onChange={() => setProjectType(value)}
                />
                <ProjectTypeIcon type={value} />
                {label}
              </label>
            ))}
          </fieldset>
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
                <ProjectTypeSelector disabled={creating} value={projectType} onChange={setProjectType} />
                {planning ? <PlanModeIndicator disabled={creating} onExit={togglePlanning} /> : null}
              </>
            )}
            onChange={setPrompt}
            onSubmit={() => void submitPrompt()}
            overlay={matchesPlanCommand(prompt) ? <PlanCommandMenu planning={planning} onToggle={togglePlanning} /> : null}
            placeholder={planning ? "Describe what to plan" : "Describe the game you want to create..."}
            textareaRef={promptRef}
            value={prompt}
            variant="home"
          />
          {createError ? <p className="home-notice" role="alert">{createError}</p> : null}
        </div>

        <section className="home-discover" aria-labelledby="whats-new-heading">
          <div className="home-section-heading">
            <h2 id="whats-new-heading">What's New</h2>
            <div className="home-carousel-controls">
              <button type="button" aria-label="Previous What's New items" disabled={!whatsNewScroll.canGoBack} onClick={() => whatsNewRef.current?.scrollBy({ left: -244, behavior: "smooth" })}>
                <ChevronLeft size={14} />
              </button>
              <button type="button" aria-label="Next What's New items" disabled={!whatsNewScroll.canGoForward} onClick={() => whatsNewRef.current?.scrollBy({ left: 244, behavior: "smooth" })}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <div className="home-whats-new-grid" ref={whatsNewRef}>
            {WHATS_NEW.map(({ title, image, page }) => (
              <button className="home-whats-new-item" key={title} type="button" onClick={() => onNavigate(page)}>
                <span className="home-whats-new-icon"><img src={image} alt="" /></span>
                <span className="home-whats-new-copy">
                  <strong>{title}</strong>
                </span>
              </button>
            ))}
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

function ProjectTypeIcon({ type }: { type: ProjectType }) {
  if (type === "web-game") return <Globe2 size={14} aria-hidden="true" />;
  if (type === "interactive-drama") return <Clapperboard size={14} aria-hidden="true" />;
  return <span className="home-category-godot-icon" aria-hidden="true" />;
}

function ProjectTypeSelector({
  value,
  disabled,
  onChange,
}: {
  value: ProjectType;
  disabled?: boolean;
  onChange: (value: ProjectType) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = PROJECT_TYPES.find((option) => option.value === value)!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  return (
    <div className="home-project-type-selector" ref={root}>
      <button
        ref={trigger}
        className="home-project-type-trigger"
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <ProjectTypeIcon type={current.value} />
        <span>{current.label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={menu}
          className="home-project-type-menu"
          id={menuId}
          role="menu"
          aria-label="Project type"
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[nextIndex]?.focus();
          }}
        >
          {PROJECT_TYPES.map((option) => {
            const selected = option.value === value;
            return (
              <button
                className={selected ? "is-active" : undefined}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <ProjectTypeIcon type={option.value} />
                <span>{option.label}</span>
                {selected ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
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
