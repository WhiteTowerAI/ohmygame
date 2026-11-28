import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { ChevronDown, ChevronUp, CircleHelp, Plus, RefreshCw } from "./icons.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { listPluginStarters, listProjects, waitForRuntime } from "./api.js";
import type { ProjectPluginCommand } from "../shared/plugins.js";
import { matchesWhen } from "../shared/plugin-when.js";
import { composerDrafts, homeDraftScope } from "./composer-drafts.js";
import { commandPrompt, PluginPanelToolbar } from "./project-plugin-contributions.js";
import { ExampleShelf, useExamples } from "./examples.js";
import { PROJECTS_CHANGED_EVENT, publishSidebarProjects } from "./sidebar-projects.js";
import { PageFrame } from "./page-frame.js";
import { ProjectCard, projectTime, useProjectActions } from "./project-card.js";
import { NEW_GAME_TYPES, NewGameCard, openNewGame } from "./new-game.js";
import { usePluginProjectTypes } from "./project-type-choices.js";
import { GENERAL_PREFERENCES_EVENT, readGeneralPreferences, setGeneralPreference, type HomeContinue } from "./general-preferences.js";
import type { AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { useProjectShelfLayout } from "./use-project-shelf-layout.js";
import { useProjectActivity } from "./use-project-activity.js";
import { Button, IconButton, Tooltip } from "./ui/index.js";
import "./home.css";
import type { OnboardingStart } from "./onboarding.js";
import { t } from "./i18n.js";

interface HomeProps {
  inert?: boolean;
  /** Where setup's last step sent the person; Home acts on it once. */
  start?: OnboardingStart;
  onStartHandled?: () => void;
  onNavigate: (page: AppNavigationTarget) => void;
  onOpen: (projectId: string, view?: "design") => void;
}

// Home is where projects start and continue: 继续 reopens the latest ones, and
// 新建游戏's type cards open the new game dialog (new-game.tsx) on their type.
/** Plugins' ways to start (`home.starters`): their prompt waits in the new game dialog's box. */
function PluginStarters() {
  const generation = useReadyRuntimeGeneration();
  const [starters, setStarters] = useState<{ plugins: string[]; commands: ProjectPluginCommand[] }>({ plugins: [], commands: [] });
  useEffect(() => {
    let active = true;
    // An answer of another shape, as from a service that predates starters, shows none.
    void listPluginStarters().catch(() => undefined).then((next) => {
      if (active) setStarters(Array.isArray(next?.commands) && Array.isArray(next.plugins) ? next : { plugins: [], commands: [] });
    });
    return () => { active = false; };
  }, [generation]);
  // Outside a project, `when` sees the platform and the plugins a new project starts with.
  const context = {
    values: { platform: typeof window === "undefined" ? undefined : window.ohMyGameDesktop?.platform ?? "web" },
    plugins: new Set(starters.plugins),
  };
  const shown = starters.commands.filter((command) => command.slots.some((slot) => matchesWhen(slot.when, context)));
  return <PluginPanelToolbar commands={shown} onRun={async (command) => {
    if (!("prompt" in command.run)) return;
    composerDrafts.get(homeDraftScope("home")).insertPrompt(commandPrompt(command.run));
    openNewGame();
  }} />;
}

export function Home({ onNavigate, onOpen, inert = false, start, onStartHandled }: HomeProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const activity = useProjectActivity(phase === "ready" && projects.length > 0, setProjects);
  // Renames, removals and automatic names reach the sidebar too.
  useEffect(() => { if (phase === "ready") publishSidebarProjects(projects); }, [phase, projects]);
  const [loadError, setLoadError] = useState<string>();
  const { examples, covers: exampleCovers } = useExamples();
  const { sectionRef, columns } = useProjectShelfLayout();
  const projectActions = useProjectActions(loadProjects);
  const { types: pluginTypes = [] } = usePluginProjectTypes();
  const continueMode = useHomeContinue();

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
  // A change from the sidebar's menu: read the list again without the loading state.
  useEffect(() => {
    const refresh = () => void listProjects().then(setProjects, () => undefined);
    window.addEventListener(PROJECTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, refresh);
  }, []);

  // Setup's last step: describe a game, start blank, or choose a folder.
  useEffect(() => {
    if (!start || inert) return;
    onStartHandled?.();
    openNewGame(start === "prompt" ? {} : { start });
  }, [start, inert]);

  const firstRun = phase === "ready" && projects.length === 0;
  const visibleExamples = examples.slice(0, columns * 2);

  // + opens the dialog without choosing a type (also ⌘N). Plugins can add types; the mark
  // only says so, so Home doesn't send the person off to Plugins.
  const newGameActions = <>
    <Tooltip content={t("projectTypeChoice.pluginsAddTypes")}>
      <IconButton size="sm" label={t("projectTypeChoice.more")} title=""><CircleHelp size="sm" /></IconButton>
    </Tooltip>
    <Tooltip content={`${t("home.newGame")} ${isMac() ? "⌘N" : "Ctrl N"}`}>
      <IconButton size="sm" label={t("home.newGame")} title="" onClick={() => openNewGame({ type: "general" })}><Plus size="sm" /></IconButton>
    </Tooltip>
  </>;

  return (
    <PageFrame active="home" inert={inert} onNavigate={onNavigate}>
      <main className="home-page">
        <WindowDragRegion />
        <div className="home-body">
          {firstRun ? <header className="home-first">
            <div className="home-first-copy">
              <h1 id="home-first-heading">{t("home.firstTitle")}</h1>
              <p>{t("home.firstHint")}</p>
            </div>
            <span className="home-section-actions">{newGameActions}</span>
          </header> : null}

          {phase === "error" ? <p className="home-notice" role="alert">
            {loadError}{" "}
            <Button size="sm" variant="ghost" icon={<RefreshCw size="sm" />} onClick={() => void loadProjects()}>{t("common.retry")}</Button>
          </p> : null}
          {phase === "loading" ? <div className="home-continue-skeleton" aria-label={t("projects.loading")} /> : null}
          {phase === "ready" && projects.length > 0 ? <ContinueSection
            projects={projects}
            mode={continueMode}
            columns={columns}
            activity={activity}
            actionsFor={projectActions.actionsFor}
            onOpen={onOpen}
            onAll={() => onNavigate("projects")}
          /> : null}
          {projectActions.error ? <p className="home-notice" role="alert">{projectActions.error}</p> : null}

          {/* On first run the big heading above names this section and holds its actions. */}
          <section ref={sectionRef} className="home-section home-new" aria-labelledby={firstRun ? "home-first-heading" : "home-new-heading"}>
            {firstRun ? null : <header className="home-section-head">
              <h2 id="home-new-heading">{t("home.newGame")}</h2>
              <span className="home-section-actions">{newGameActions}</span>
            </header>}
            <div className="home-new-grid">
              {NEW_GAME_TYPES.map((type) => <NewGameCard key={type} type={type} pluginTypes={pluginTypes} />)}
              {pluginTypes.map((type) => <NewGameCard key={type.id} type={type.id} pluginTypes={pluginTypes} />)}
            </div>
            <div className="home-starts"><PluginStarters /></div>
          </section>

          {visibleExamples.length > 0 ? <section className="home-section home-explore" aria-labelledby="home-examples-heading">
            <header className="home-section-head">
              <h2 id="home-examples-heading">{t("home.explore")}</h2>
              <Button size="sm" variant="ghost" onClick={() => onNavigate("community")}>{t("home.toCommunity")}</Button>
            </header>
            <ExampleShelf examples={visibleExamples} covers={exampleCovers} onOpenProject={onOpen} />
          </section> : null}
        </div>
      </main>
      {projectActions.dialogs}
    </PageFrame>
  );
}

/** Home's 继续: shown in full, or folded to one line. */
function useHomeContinue(): HomeContinue {
  return useSyncExternalStore((change) => {
    window.addEventListener(GENERAL_PREFERENCES_EVENT, change);
    window.addEventListener("storage", change);
    return () => {
      window.removeEventListener(GENERAL_PREFERENCES_EVENT, change);
      window.removeEventListener("storage", change);
    };
  }, () => readGeneralPreferences().homeContinue);
}

function ContinueSection({ projects, mode, columns, activity, actionsFor, onOpen, onAll }: {
  projects: ProjectState[];
  mode: HomeContinue;
  /** How many cards fit a row of the shelf below, so 继续 lines up with it. */
  columns: number;
  activity: ReturnType<typeof useProjectActivity>;
  actionsFor: ReturnType<typeof useProjectActions>["actionsFor"];
  onOpen: (projectId: string) => void;
  onAll: () => void;
}) {
  const [latest] = projects;
  const collapsed = mode === "collapsed";
  const toggle = () => setGeneralPreference("homeContinue", collapsed ? "shown" : "collapsed");
  const latestStatus = activity.get(latest.id);
  return (
    <section className={`home-section home-continue${collapsed ? " is-collapsed" : ""}`} aria-labelledby="home-continue-heading">
      <header className="home-section-head">
        <h2 id="home-continue-heading">{t("home.continue")}</h2>
        {collapsed ? <span className="home-continue-line">
          <span className="home-continue-line-name">{latest.name}</span>
          <span className="home-continue-line-time">{latestStatus ? t("projectCard.working") : projectTime(latest.updatedAt)}</span>
          <Button size="sm" onClick={() => onOpen(latest.id)}>{t("home.open")}</Button>
        </span> : null}
        <span className="home-section-actions">
          {collapsed || projects.length < 2 ? null : <Button size="sm" variant="ghost" onClick={onAll}>{t("home.allProjects")}</Button>}
          <IconButton size="sm" label={collapsed ? t("home.expandContinue") : t("home.collapseContinue")} aria-expanded={!collapsed} onClick={toggle}>
            {collapsed ? <ChevronDown size="md" /> : <ChevronUp size="md" />}
          </IconButton>
        </span>
      </header>
      {/* One row of cards the size of 探索's, so a single project sits at the
          row's start like any shelf instead of stretching across it. */}
      {collapsed ? null : <div className="home-continue-body">
        {projects.slice(0, columns).map((project) => (
          <ProjectCard key={project.id} project={project} agentStatus={activity.get(project.id)} onOpen={() => onOpen(project.id)} actions={actionsFor(project)} />
        ))}
      </div>}
    </section>
  );
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
