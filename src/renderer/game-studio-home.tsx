import { useEffect, useRef, useState } from "react";
import type {
  PluginMention,
  ProjectState,
  PromptAttachment,
  PromptImage,
  PromptMode,
} from "../shared/contracts.js";
import {
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
  waitForRuntime,
} from "./api.js";
import { ExampleShelf, useExamples } from "./examples.js";
import { Plus, RefreshCw } from "./icons.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { projectsHash, type AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import {
  GAME_STUDIOS,
  recentStudioProjects,
  type GameStudioType,
} from "./studios.js";
import "./studios.css";

interface GameStudioHomeProps {
  projectType: GameStudioType;
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (
    projectId: string,
    conversationId: string,
    prompt: string,
    mentions: PluginMention[],
    images: PromptImage[],
    mode: PromptMode,
    attachments?: PromptAttachment[],
  ) => void;
  onOpenProject: (projectId: string) => void;
}

export function GameStudioHome({
  projectType,
  onNavigate,
  onCreate,
  onOpenProject,
}: GameStudioHomeProps) {
  const studio = GAME_STUDIOS[projectType];
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectState>();
  const renameTrigger = useRef<HTMLElement | null>(null);
  const { examples, covers } = useExamples();
  const studioExamples = examples
    .filter((example) => example.type === projectType)
    .slice(0, 4);

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      setProjects(recentStudioProjects(await listProjects(), projectType));
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }

  useEffect(() => {
    void load();
  }, [projectType]);

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function remove(project: ProjectState): void {
    if (window.confirm(projectDeletionConfirmation(project)))
      void runAction(() => deleteProject(project.id));
  }

  return (
    <main className="home-shell">
      <AppSidebar active={studio.page} onNavigate={onNavigate} />
      <section
        className={`home-content home-content-fitted game-studio-home studio-${studio.page}`}
      >
        <WindowDragRegion />
        <div className="home-start">
          <h1>{studio.title}</h1>
          <ProjectPromptCreator
            projectType={projectType}
            placeholder={studio.placeholder}
            onOpenProject={onOpenProject}
            onCreate={onCreate}
          />
          <button
            className="home-start-blank"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            {studio.newLabel}
          </button>
        </div>

        <section
          className="home-recent studio-projects"
          aria-labelledby="studio-projects-heading"
        >
          <div className="studio-section-heading">
            <h2 id="studio-projects-heading">Recent projects</h2>
            {phase === "error" ? (
              <button
                className="studio-text-link"
                type="button"
                onClick={() => void load()}
              >
                <RefreshCw size={13} />
                Retry
              </button>
            ) : (
              <a className="studio-text-link" href={projectsHash(projectType)}>
                View all
              </a>
            )}
          </div>
          {phase === "loading" ? (
            <div className="studio-project-grid" aria-label="Loading projects">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="studio-project-skeleton" key={index} />
              ))}
            </div>
          ) : null}
          {phase === "error" ? (
            <p className="home-project-state" role="alert">
              {error}
            </p>
          ) : null}
          {phase === "ready" && !projects.length ? (
            <p className="home-project-state">No projects yet</p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="studio-project-grid">
              {projects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  fallback={index % 4}
                  onOpen={() => onOpenProject(project.id)}
                  actions={{
                    onRename: () => {
                      renameTrigger.current =
                        document.querySelector<HTMLElement>(
                          '.project-card-menu[aria-expanded="true"]',
                        );
                      setRenameTarget(project);
                    },
                    onDuplicate: () =>
                      void runAction(() => duplicateProject(project.id)),
                    onDelete: () => remove(project),
                  }}
                />
              ))}
            </div>
          ) : null}
          {actionError ? (
            <p className="home-notice" role="alert">
              {actionError}
            </p>
          ) : null}
        </section>

        {studioExamples.length > 0 ? (
          <section
            className="home-discover home-explore studio-examples"
            aria-labelledby="studio-examples-heading"
          >
            <div className="studio-section-heading">
              <h2 id="studio-examples-heading">Examples</h2>
            </div>
            <ExampleShelf
              examples={studioExamples}
              covers={covers}
              onOpenProject={onOpenProject}
            />
          </section>
        ) : null}
      </section>
      {renameTarget ? (
        <ProjectRenameDialog
          name={renameTarget.name}
          returnFocus={renameTrigger.current}
          onClose={() => setRenameTarget(undefined)}
          onConfirm={(input) => {
            const project = renameTarget;
            setRenameTarget(undefined);
            const name = input.trim();
            if (name && name !== project.name)
              void runAction(() => renameProject(project.id, name));
          }}
        />
      ) : null}
      {createOpen ? (
        <ProjectCreateDialog
          fixedType={projectType}
          onClose={() => setCreateOpen(false)}
          onCreated={(project) => {
            setCreateOpen(false);
            onOpenProject(project.id);
          }}
        />
      ) : null}
    </main>
  );
}
