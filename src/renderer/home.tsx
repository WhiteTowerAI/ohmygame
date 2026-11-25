import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { ChevronDown, ChevronUp, Spinner, MoreHorizontal, Pencil, Plus, RefreshCw } from "./icons.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { listPluginStarters, listProjects, waitForRuntime } from "./api.js";
import type { ProjectPluginCommand } from "../shared/plugins.js";
import { matchesWhen } from "../shared/plugin-when.js";
import { composerDrafts, homeDraftScope } from "./composer-drafts.js";
import { commandPrompt, PluginPanelToolbar } from "./project-plugin-contributions.js";
import { ExampleShelf, useExamples } from "./examples.js";
import { publishSidebarProjects } from "./sidebar-projects.js";
import { PageFrame } from "./page-frame.js";
import { ProjectCard, ProjectRow, projectTime, useProjectActions } from "./project-card.js";
import { NEW_GAME_TYPES, NewGameCard, openNewGame } from "./new-game.js";
import { openMoreProjectTypes } from "./project-type-choices.js";
import { usePluginProjectTypes } from "./project-type-choices.js";
import { GENERAL_PREFERENCES_EVENT, readGeneralPreferences, setGeneralPreference, type HomeContinue } from "./general-preferences.js";
import { PixelTemplateDensityDialog } from "./pixel-template-density-dialog.js";
import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { pixelAssetTemplateCategories, type PixelAssetTemplateCategory } from "./asset-canvas-pixel-workflows.js";
import { templateAssetUrl } from "./template-assets.js";
import { effectLibraryCoverForLevel } from "./asset-canvas-effect-covers.js";
import type { AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { useProjectShelfLayout } from "./use-project-shelf-layout.js";
import { useProjectActivity } from "./use-project-activity.js";
import { Button, DropdownMenu, IconButton } from "./ui/index.js";
import "./home.css";
import type { OnboardingStart } from "./onboarding.js";
import { t } from "./i18n.js";

const PIXEL_TEMPLATE_COVERS: Record<PixelAssetTemplateCategory, string> = {
  characters: templateAssetUrl("examples/characters-cover.webp"),
  creatures: templateAssetUrl("examples/creatures-cover.webp"),
  animation: templateAssetUrl("examples/animation-cover.webp"),
  scenes: templateAssetUrl("examples/scenes-cover.webp"),
  terrain: templateAssetUrl("examples/terrain-cover.webp"),
  objects: templateAssetUrl("examples/objects-cover.webp"),
  skins: templateAssetUrl("examples/skins-cover.webp"),
};

interface HomeProps {
  inert?: boolean;
  /** Where setup's last step sent the person; Home acts on it once. */
  start?: OnboardingStart;
  onStartHandled?: () => void;
  onNavigate: (page: AppNavigationTarget) => void;
  onOpen: (projectId: string, view?: "design") => void;
  /** Opens an Asset Canvas project on the node a creation template starts from. */
  onOpenAssetCanvas: (projectId: string, nodeId?: string) => void;
}

/** The projects 继续 lists beside the latest one. */
const CONTINUE_ROWS = 3;

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

export function Home({ onNavigate, onOpen, onOpenAssetCanvas, inert = false, start, onStartHandled }: HomeProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const activity = useProjectActivity(phase === "ready" && projects.length > 0, setProjects);
  // Renames, removals and automatic names reach the sidebar too.
  useEffect(() => { if (phase === "ready") publishSidebarProjects(projects); }, [phase, projects]);
  const [loadError, setLoadError] = useState<string>();
  const [templateCreating, setTemplateCreating] = useState<PixelAssetTemplateCategory | "effect-library">();
  const [templateDensityCategory, setTemplateDensityCategory] = useState<PixelAssetTemplateCategory | "effects">();
  const [templateError, setTemplateError] = useState<string>();
  const templateTrigger = useRef<HTMLElement | null>(null);
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

  // Templates make an Asset Canvas project with its starting board and open it there.
  async function createTemplate(category: PixelAssetTemplateCategory | "effects", level: PixelArtLevel): Promise<void> {
    setTemplateCreating(category === "effects" ? "effect-library" : category);
    setTemplateError(undefined);
    try {
      const created = category === "effects"
        ? await (await import("./asset-canvas-templates.js")).createEffectLibraryProject(level)
        : await (await import("./asset-canvas-template-project.js")).createPixelAssetTemplateProject(category, level);
      onOpenAssetCanvas(created.projectId, created.nodeId);
    } catch (error) {
      setTemplateError(errorMessage(error));
    } finally {
      setTemplateCreating(undefined);
    }
  }

  // Setup's last step: describe a game, start blank, or choose a folder.
  useEffect(() => {
    if (!start || inert) return;
    onStartHandled?.();
    openNewGame(start === "prompt" ? {} : { start });
  }, [start, inert]);

  const firstRun = phase === "ready" && projects.length === 0;
  // Two rows, so every example type has room; Home scrolls when the window is short.
  const visibleExamples = examples.slice(0, columns * 2);

  // Describing a game skips choosing a type; More types finds plugins that add one.
  const newGameActions = <>
    <Button size="sm" variant="ghost" icon={<Plus size="sm" />} onClick={openMoreProjectTypes}>{t("projectTypeChoice.more")}</Button>
    <Button size="sm" variant="ghost" icon={<Pencil size="sm" />} onClick={() => openNewGame({ type: "general" })}>
      {t("home.describe")}<kbd className="home-shortcut">{isMac() ? "⌘N" : "Ctrl N"}</kbd>
    </Button>
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
          {phase === "loading" && continueMode !== "hidden" ? <div className="home-continue-skeleton" aria-label={t("projects.loading")} /> : null}
          {phase === "ready" && projects.length > 0 && continueMode !== "hidden" ? <ContinueSection
            projects={projects}
            mode={continueMode}
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

          <section className="home-section home-explore home-templates" aria-labelledby="home-templates-heading">
            <header className="home-section-head">
              <h2 id="home-templates-heading">{t("home.templates")}</h2>
            </header>
            <div className="home-whats-new-grid">
              {pixelAssetTemplateCategories().map((category) => (
                <button
                  className="home-whats-new-item home-template-card"
                  type="button"
                  key={category.id}
                  disabled={templateCreating !== undefined}
                  aria-busy={templateCreating === category.id}
                  onClick={(event) => {
                    templateTrigger.current = event.currentTarget;
                    setTemplateDensityCategory(category.id);
                  }}
                >
                  <span className="home-whats-new-icon home-explore-cover">
                    <img src={PIXEL_TEMPLATE_COVERS[category.id]} alt="" />
                    {templateCreating === category.id ? <span className="home-template-loading"><Spinner size="md" /></span> : null}
                  </span>
                  <span className="home-whats-new-copy">
                    <strong>{category.label}</strong>
                    <small>{category.description}</small>
                  </span>
                </button>
              ))}
              <button
                className="home-whats-new-item home-template-card home-effect-template-card"
                type="button"
                disabled={templateCreating !== undefined}
                aria-busy={templateCreating === "effect-library"}
                onClick={(event) => {
                  templateTrigger.current = event.currentTarget;
                  setTemplateDensityCategory("effects");
                }}
              >
                <span className="home-whats-new-icon home-explore-cover">
                  <img src={effectLibraryCoverForLevel()} alt="" />
                  {templateCreating === "effect-library" ? <span className="home-template-loading"><Spinner size="md" /></span> : null}
                </span>
                <span className="home-whats-new-copy">
                  <strong>{t("effectLibrary.title")}</strong>
                  <small>{t("effectLibrary.cardDescription")}</small>
                </span>
              </button>
            </div>
            {templateError ? <p className="home-notice" role="alert">{templateError}</p> : null}
          </section>
        </div>
      </main>
      {projectActions.dialogs}
      {templateDensityCategory ? <PixelTemplateDensityDialog
        category={templateDensityCategory}
        returnFocus={templateTrigger.current}
        onClose={() => setTemplateDensityCategory(undefined)}
        onConfirm={(level) => {
          setTemplateDensityCategory(undefined);
          void createTemplate(templateDensityCategory, level);
        }}
      /> : null}
    </PageFrame>
  );
}

/** Home's 继续: shown in full, folded to one line, or left off Home until Settings → General brings it back. */
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

function ContinueSection({ projects, mode, activity, actionsFor, onOpen, onAll }: {
  projects: ProjectState[];
  mode: HomeContinue;
  activity: ReturnType<typeof useProjectActivity>;
  actionsFor: ReturnType<typeof useProjectActions>["actionsFor"];
  onOpen: (projectId: string) => void;
  onAll: () => void;
}) {
  const [latest, ...others] = projects;
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
          {collapsed ? null : <Button size="sm" variant="ghost" onClick={onAll}>{t("home.allProjects")}</Button>}
          <IconButton size="sm" label={collapsed ? t("home.expandContinue") : t("home.collapseContinue")} aria-expanded={!collapsed} onClick={toggle}>
            {collapsed ? <ChevronDown size="md" /> : <ChevronUp size="md" />}
          </IconButton>
          <DropdownMenu placement="bottom-end" items={[
            { label: collapsed ? t("home.expandContinue") : t("home.collapseContinue"), onSelect: toggle },
            { label: t("home.hideContinue"), description: t("home.hideContinueHint"), onSelect: () => setGeneralPreference("homeContinue", "hidden") },
          ]} trigger={(props) => (
            <IconButton {...props} size="sm" label={t("home.continueMenu")}><MoreHorizontal size="md" /></IconButton>
          )} />
        </span>
      </header>
      {collapsed ? null : <div className="home-continue-body">
        <div className="home-continue-feature">
          <ProjectCard project={latest} agentStatus={latestStatus} onOpen={() => onOpen(latest.id)} actions={actionsFor(latest)} />
          <Button className="home-continue-open" size="sm" onClick={() => onOpen(latest.id)}>{t("home.open")}</Button>
        </div>
        {others.length ? <div className="home-continue-list">
          {others.slice(0, CONTINUE_ROWS).map((project) => (
            <ProjectRow key={project.id} project={project} agentStatus={activity.get(project.id)} onOpen={() => onOpen(project.id)} actions={actionsFor(project)} />
          ))}
        </div> : null}
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
