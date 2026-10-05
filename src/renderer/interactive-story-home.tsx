import { Plus, RefreshCw } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import type { PluginMention, ProjectState, PromptAttachment, PromptImage, PromptMode } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ExampleShelf, useExamples } from "./examples.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

const RECENT_STORY_LIMIT = 4;

export function InteractiveStoryHome({ onNavigate, onCreate, onOpenProject }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectState>();
  const renameTrigger = useRef<HTMLElement | null>(null);
  const { examples, covers } = useExamples();
  const storyExamples = examples.filter((example) => example.type === "interactive-story").slice(0, RECENT_STORY_LIMIT);

  async function load(): Promise<void> {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      setProjects(recentInteractiveStoryProjects(await listProjects()));
      setPhase("ready");
    } catch (cause) {
      setLoadError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  function rename(project: ProjectState, input: string): void {
    const name = input.trim();
    if (!name || name === project.name) return;
    void runAction(() => renameProject(project.id, name));
  }

  function duplicate(project: ProjectState): void {
    void runAction(() => duplicateProject(project.id));
  }

  function remove(project: ProjectState): void {
    if (!window.confirm(projectDeletionConfirmation(project))) return;
    void runAction(() => deleteProject(project.id));
  }

  return (
    <main className="home-shell">
      <AppSidebar active="interactive-story" onNavigate={onNavigate} />
      <section className="home-content interactive-story-home">
        <WindowDragRegion />
        <div className="home-start">
          <h1>What story are we telling?</h1>
          <ProjectPromptCreator
            projectType="interactive-story"
            placeholder="Describe the interactive story you want to create..."
            onOpenProject={onOpenProject}
            onCreate={onCreate}
          />
          <button className="home-start-blank" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />New story
          </button>
        </div>

        {storyExamples.length ? (
          <section className="home-discover interactive-story-explore" aria-labelledby="story-examples-heading">
            <div className="home-section-heading">
              <h2 id="story-examples-heading">Explore</h2>
            </div>
            <ExampleShelf examples={storyExamples} covers={covers} onOpenProject={onOpenProject} />
          </section>
        ) : null}

        <section className="home-discover interactive-story-recent" aria-labelledby="recent-stories-heading">
          <div className="home-section-heading">
            <h2 id="recent-stories-heading">Recent stories</h2>
            {phase === "error" ? (
              <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button>
            ) : null}
          </div>
          {phase === "loading" ? <StoryGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? (
            <p className="home-project-state">{storyExamples.length ? "No stories yet. Play an example above, or describe a story to start." : "No stories yet"}</p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="home-project-grid">
              {projects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  fallback={index % 4}
                  onOpen={() => onOpenProject(project.id)}
                  actions={{ onRename: () => {
                    renameTrigger.current = document.querySelector<HTMLElement>('.project-card-menu[aria-expanded="true"]');
                    setRenameTarget(project);
                  }, onDuplicate: () => duplicate(project), onDelete: () => remove(project) }}
                />
              ))}
            </div>
          ) : null}
          {actionError ? <p className="home-notice" role="alert">{actionError}</p> : null}
        </section>
      </section>
      {renameTarget ? <ProjectRenameDialog name={renameTarget.name} returnFocus={renameTrigger.current} onClose={() => setRenameTarget(undefined)} onConfirm={(name) => {
        const project = renameTarget;
        setRenameTarget(undefined);
        rename(project, name);
      }} /> : null}
      {createOpen ? <ProjectCreateDialog fixedType="interactive-story" onClose={() => setCreateOpen(false)} onCreated={(project) => {
        setCreateOpen(false);
        onOpenProject(project.id);
      }} /> : null}
    </main>
  );
}

export function recentInteractiveStoryProjects(projects: readonly ProjectState[]): ProjectState[] {
  return projects
    .filter((project) => project.type === "interactive-story")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_STORY_LIMIT);
}

function StoryGridSkeleton() {
  return (
    <div className="home-project-grid" aria-label="Loading stories">
      {[0, 1, 2, 3].map((item) => <div className="project-card home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
