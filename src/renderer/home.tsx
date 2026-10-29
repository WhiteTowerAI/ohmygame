import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { FilePlus, Import, RefreshCw } from "./icons.js";
import { useEffect, useState } from "react";
import type { PluginMention, ProjectState, PromptAttachment, PromptImage, PromptMode } from "../shared/contracts.js";
import { listProjects, waitForRuntime } from "./api.js";
import { ExampleShelf, useExamples } from "./examples.js";
import { publishRecentProjects } from "./app-sidebar.js";
import { PageFrame } from "./page-frame.js";
import { ProjectCard, useProjectActions } from "./project-card.js";
import { ProjectCreateDialog, type FirstMessage } from "./project-create-dialog.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { createdProjectView, type AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { useProjectShelfLayout } from "./use-project-shelf-layout.js";
import { useProjectActivity } from "./use-project-activity.js";
import { Button } from "./ui/index.js";
import "./home.css";
import { t } from "./i18n.js";

interface HomeProps {
  inert?: boolean;
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (project: ProjectState, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]) => void;
  onOpen: (projectId: string, view?: "design") => void;
}

/** What the new-project dialog opens with, if it is open. */
interface CreateRequest {
  firstMessage?: FirstMessage;
  /** Empties Home's prompt box once the first message has been sent. */
  clearDraft?: () => void;
  workspacePath?: string;
}

// Home is where every project starts: the prompt opens the new-project dialog
// with the prompt as the first message; Start blank and Import folder open it
// without one.
export function Home({ onNavigate, onCreate, onOpen, inert = false }: HomeProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const activity = useProjectActivity(phase === "ready" && projects.length > 0, setProjects);
  // Renames, removals and automatic names reach the sidebar too.
  useEffect(() => { if (phase === "ready") publishRecentProjects(projects); }, [phase, projects]);
  const [loadError, setLoadError] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [creating, setCreating] = useState<CreateRequest>();
  const { examples, covers: exampleCovers } = useExamples();
  const { sectionRef, columns, recentProjectLimit } = useProjectShelfLayout();
  const projectActions = useProjectActions(loadProjects);
  const selectDirectory = window.ohMyGameDesktop?.selectProjectDirectory;

  async function loadProjects() {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      const loaded = await listProjects();
      setProjects(loaded);
      setPhase("ready");
    } catch (error) {
      setLoadError(errorMessage(error));
      setPhase("error");
    }
  }

  useEffect(() => { void loadProjects(); }, [serviceGeneration]);

  // An existing folder opens its project if it has one, or becomes a new project's workspace.
  async function importFolder(): Promise<void> {
    if (!selectDirectory) return;
    setImportError(undefined);
    try {
      const selected = await selectDirectory();
      if (!selected) return;
      const owner = (await listProjects()).find((project) => project.workspacePath === selected);
      if (owner) onOpen(owner.id);
      else setCreating({ workspacePath: selected });
    } catch (error) {
      setImportError(errorMessage(error));
    }
  }

  const visibleProjects = projects.slice(0, recentProjectLimit);
  // Two rows, so every example type has room; Home scrolls when the window is short.
  const visibleExamples = examples.slice(0, columns * 2);

  return (
    <PageFrame active="home" inert={inert} onNavigate={onNavigate}>
      <main className="home-page">
        <WindowDragRegion />
        <div className="home-body">
          <section className="home-hero">
            <h1>{t("home.title")}</h1>
            <ProjectPromptCreator
              draftKey="home"
              placeholder={t("home.placeholder")}
              onSubmit={(firstMessage, clearDraft) => setCreating({ firstMessage, clearDraft })}
            />
            <div className="home-starts">
              <Button variant="ghost" size="sm" icon={<FilePlus size={14} />} onClick={() => setCreating({})}>{t("home.startBlank")}</Button>
              {selectDirectory ? <Button variant="ghost" size="sm" icon={<Import size={14} />} onClick={() => void importFolder()}>{t("home.importFolder")}</Button> : null}
            </div>
            {importError ? <p className="home-notice" role="alert">{importError}</p> : null}
          </section>

          <section ref={sectionRef} className="home-section home-recent" aria-labelledby="projects-heading">
            <header className="home-section-head">
              <h2 id="projects-heading">{t("projects.recent")}</h2>
              {phase === "error" ? (
                <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void loadProjects()}>{t("common.retry")}</Button>
              ) : projects.length ? (
                <Button size="sm" variant="ghost" onClick={() => onNavigate("projects")}>{t("home.allProjects")}</Button>
              ) : null}
            </header>

            {phase === "loading" ? <ProjectGridSkeleton count={recentProjectLimit} /> : null}
            {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
            {phase === "ready" && projects.length === 0 ? <p className="home-project-state">{t("projects.none")}</p> : null}
            {phase === "ready" && projects.length > 0 ? (
              <div className="home-grid">
                {visibleProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    agentStatus={activity.get(project.id)}
                    onOpen={() => onOpen(project.id)}
                    actions={projectActions.actionsFor(project)}
                  />
                ))}
              </div>
            ) : null}
            {projectActions.error ? <p className="home-notice" role="alert">{projectActions.error}</p> : null}
          </section>

          {visibleExamples.length > 0 ? <section className="home-section home-explore" aria-labelledby="home-examples-heading">
            <header className="home-section-head">
              <h2 id="home-examples-heading">{t("home.explore")}</h2>
              <Button size="sm" variant="ghost" onClick={() => onNavigate("community")}>{t("home.toCommunity")}</Button>
            </header>
            <ExampleShelf examples={visibleExamples} covers={exampleCovers} showType onOpenProject={onOpen} />
          </section> : null}
        </div>
      </main>
      {projectActions.dialogs}
      {creating ? <ProjectCreateDialog
        firstMessage={creating.firstMessage}
        initialWorkspacePath={creating.workspacePath}
        onClose={() => setCreating(undefined)}
        onOpenProject={(projectId) => { setCreating(undefined); onOpen(projectId); }}
        onCreated={(project, start) => {
          setCreating(undefined);
          if (start) {
            creating.clearDraft?.();
            onCreate(project, start.conversationId, start.prompt, start.mentions, [], start.mode, start.attachments);
          }
          else onOpen(project.id, createdProjectView(project.type));
        }}
      /> : null}
    </PageFrame>
  );
}

function ProjectGridSkeleton({ count }: { count: number }) {
  return (
    <div className="home-grid" aria-label={t("projects.loading")}>
      {Array.from({ length: count }, (_, item) => <div className="home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
