import { lazy, Suspense, useEffect, useState } from "react";
import { Home } from "./home.js";
// Only lazy routes use this; loading it eagerly keeps it ahead of styles.css as before code splitting.
import "./plugin-builder.css";
import { communityHash, createdProjectView, conversationHash, DEFAULT_SETTINGS_SECTION, gameHash, parseAppRoute, pluginHash, projectHash, projectsHash, settingsHash, sidebarHash, type AppNavigationTarget, type SettingsSection, type SidebarPage } from "./routes.js";
import { historyState, useAppNavigation } from "./app-navigation.js";
import { invalidateQuickStartModels, loadQuickStartModels } from "./asset-canvas-quick-start.js";
import { SidebarPageLayout } from "./sidebar-page.js";
import { WindowDragRegion } from "./window-drag-region.js";
import type { PluginMention, ProjectState, PromptAttachment, PromptImage, PromptMode } from "../shared/contracts.js";
import type { PluginDetail } from "../shared/plugins.js";
import { pluginMentionToken } from "../shared/plugins.js";
import { createConversation, createProject, getProject, MODELS_CHANGED_EVENT } from "./api.js";
import type { ComposerDraft } from "./composer.js";
import { runtimeConnection, useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Onboarding, OnboardingArrival, OnboardingLoading } from "./onboarding.js";
import { useOnboarding } from "./use-onboarding.js";
import { usePluginIntegrationGate } from "./plugin-integration.js";

// Home and onboarding stay in the main chunk; every other route loads on first visit.
const CommunityProfilePage = lazy(() => import("./community-profile.js").then((module) => ({ default: module.CommunityProfilePage })));
const GamesPage = lazy(() => import("./games.js").then((module) => ({ default: module.GamesPage })));
const GamePlayer = lazy(() => import("./games.js").then((module) => ({ default: module.GamePlayer })));
const LibraryPage = lazy(() => import("./library.js").then((module) => ({ default: module.LibraryPage })));
const ProjectsPage = lazy(() => import("./projects.js").then((module) => ({ default: module.ProjectsPage })));
const ProjectShell = lazy(() => import("./project-shell.js").then((module) => ({ default: module.ProjectShell })));
const AssetCanvasHome = lazy(() => import("./asset-canvas-home.js").then((module) => ({ default: module.AssetCanvasHome })));
const GameStudioHome = lazy(() => import("./game-studio-home.js").then((module) => ({ default: module.GameStudioHome })));
const SettingsPage = lazy(() => import("./settings-page.js").then((module) => ({ default: module.SettingsPage })));
const PluginsSettings = lazy(() => import("./plugins.js").then((module) => ({ default: module.PluginsSettings })));
const PluginBuilder = lazy(() => import("./plugin-builder.js").then((module) => ({ default: module.PluginBuilder })));

export function App() {
  const serviceGeneration = useReadyRuntimeGeneration();
  const { route, navigate, projectReturnTo, projectBackLabel } = useAppNavigation();
  const onboarding = useOnboarding(route.page === "home");
  const [welcoming, setWelcoming] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState<{ generation: number; conversationId: string; prompt: string; mentions: PluginMention[]; images: PromptImage[]; mode: PromptMode; attachments?: PromptAttachment[] }>();
  const [initialDraft, setInitialDraft] = useState<{ conversationId: string; draft: ComposerDraft }>();
  const [initialCanvasNode, setInitialCanvasNode] = useState<{ projectId: string; nodeId: string }>();
  const [playtestEditorProjectId, setPlaytestEditorProjectId] = useState<string>();
  const creationGate = usePluginIntegrationGate();

  // Provider catalogs are slow; load them now so asset canvas quick starts open without waiting.
  useEffect(() => {
    invalidateQuickStartModels();
    void loadQuickStartModels();
    if (serviceGeneration > 1) window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
    const refresh = () => { invalidateQuickStartModels(); void loadQuickStartModels(); };
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, refresh);
  }, [serviceGeneration]);

  // A Playtest window that cannot play asks for its project's editor.
  const routeProjectId = route.page === "project" ? route.projectId : undefined;
  useEffect(() => window.ohMyGameDesktop?.onShowPlaytestEditor?.((projectId) => {
    if (projectId !== routeProjectId) openProject(projectId);
    setPlaytestEditorProjectId(projectId);
  }), [routeProjectId]);

  if ((route.page === "home" || onboarding.replaying) && onboarding.state?.status === "pending") {
    return <Onboarding step={onboarding.state.step}
      onStepChange={(step) => onboarding.save({ status: "pending", step })}
      onFinish={async (status) => { await onboarding.save({ status, step: onboarding.state?.step ?? "welcome" }); setWelcoming(true); navigate("#/"); }} />;
  }
  if (route.page === "home" && !onboarding.state) return <OnboardingLoading error={onboarding.error} onRetry={onboarding.retry} />;
  if (route.page === "plugin-builder") return <Suspense fallback={<RouteLoading />}><PluginBuilder key={route.sessionId} sessionId={route.sessionId} /></Suspense>;
  if (route.page === "settings") {
    return <Suspense fallback={<RouteLoading />}><SettingsPage section={route.section} onBack={leaveSettings} onSectionChange={navigateToSettingsSection} onOpenOnboarding={onboarding.open} /></Suspense>;
  }
  if (route.page === "plugins") return <>{creationGate.dialog}<SidebarPageLayout active="plugins" onNavigate={navigateToSidebarPage}>
    <Suspense fallback={null}><PluginsSettings pluginId={route.pluginId} onPluginChange={navigateToPlugin} onTryPlugin={tryPlugin} /></Suspense>
  </SidebarPageLayout></>;
  if (route.page === "home") {
    return <><Home inert={welcoming} onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpen={openProject} />{welcoming ? <OnboardingArrival onComplete={() => setWelcoming(false)} /> : null}</>;
  }
  if (route.page === "community") {
    return <Suspense fallback={sidebarFallback("community")}><GamesPage onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} /></Suspense>;
  }
  if (route.page === "community-profile") return <Suspense fallback={sidebarFallback("community")}><CommunityProfilePage authorId={route.authorId} onNavigate={navigateToSidebarPage} onBack={goToGames} onOpenGame={ohMyGame} /></Suspense>;
  if (route.page === "game") return <Suspense fallback={sidebarFallback("community")}><GamePlayer gameId={route.gameId} onBack={goToGames} onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} /></Suspense>;
  if (route.page === "projects") return <Suspense fallback={sidebarFallback("projects")}><ProjectsPage projectType={route.projectType} query={route.query} sort={route.sort} onFiltersChange={(filters, replace) => navigate(projectsHash(filters), { replace })} onNavigate={navigateToSidebarPage} onOpenProject={openProject} /></Suspense>;
  if (route.page === "general" || route.page === "web-game" || route.page === "interactive-story" || route.page === "godot") return <Suspense fallback={sidebarFallback(route.page)}><GameStudioHome key={route.page} projectType={route.page === "godot" ? "godot-game" : route.page} onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpenProject={openProject} /></Suspense>;
  if (route.page === "asset-canvas") return <Suspense fallback={sidebarFallback("asset-canvas")}><AssetCanvasHome onNavigate={navigateToSidebarPage} onOpenProject={openAssetCanvasProject} /></Suspense>;
  if (route.page === "library") return <Suspense fallback={sidebarFallback("library")}><LibraryPage onNavigate={navigateToSidebarPage} /></Suspense>;
  if (route.page === "playtest") return null;
  if (route.page !== "project") return null;
  return (
    <Suspense fallback={<RouteLoading />}><ProjectShell
      key={route.projectId}
      projectId={route.projectId}
      conversationId={route.conversationId}
      view={route.view}
      onViewChange={(view, options) => {
        const nextView = view === "design" ? "design" : undefined;
        const hash = route.conversationId ? conversationHash(route.projectId, route.conversationId, nextView) : projectHash(route.projectId, nextView);
        navigate(hash, { replace: options?.replace });
      }}
      initialPrompt={initialPrompt && initialPrompt.conversationId === route.conversationId ? initialPrompt : undefined}
      initialDraft={initialDraft && initialDraft.conversationId === route.conversationId ? initialDraft.draft : undefined}
      initialCanvasNodeId={initialCanvasNode?.projectId === route.projectId ? initialCanvasNode.nodeId : undefined}
      onInitialCanvasNodeHandled={() => setInitialCanvasNode(undefined)}
      showStoryMap={playtestEditorProjectId === route.projectId}
      onStoryMapShown={() => setPlaytestEditorProjectId(undefined)}
      onInitialPromptHandled={clearInitialPrompt}
      onInitialDraftHandled={() => setInitialDraft(undefined)}
      onOpenConversation={(conversationId, replace = false) => navigateToConversation(route.projectId, conversationId, replace)}
      onHome={() => navigate(projectReturnTo)}
      homeLabel={projectBackLabel}
    /></Suspense>
  );

  // Keeps the sidebar in place while a sidebar page's chunk loads.
  function sidebarFallback(active: SidebarPage) {
    return <SidebarPageLayout active={active} onNavigate={navigateToSidebarPage}>{null}</SidebarPageLayout>;
  }

  function openCreatedProject(project: ProjectState, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]): void {
    const connection = runtimeConnection();
    setInitialPrompt({ generation: connection.status === "ready" ? connection.generation : -1, conversationId, prompt, mentions, images, mode, attachments });
    navigateToConversation(project.id, conversationId, false, project.integration ? undefined : createdProjectView(project.type));
  }

  function openProject(projectId: string, view?: "design"): void {
    setInitialPrompt(undefined);
    setInitialDraft(undefined);
    setInitialCanvasNode(undefined);
    navigate(projectHash(projectId, view));
  }

  function openAssetCanvasProject(projectId: string, nodeId?: string): void {
    setInitialPrompt(undefined);
    setInitialDraft(undefined);
    setInitialCanvasNode(nodeId ? { projectId, nodeId } : undefined);
    navigate(projectHash(projectId));
  }

  async function tryPlugin(plugin: PluginDetail, prompt: string, projectId?: string): Promise<void> {
    let project = projectId ? await getProject(projectId) : await createProject({ type: plugin.projectTypes?.[0] ?? "web-game", ...(plugin.integration ? { pluginId: plugin.id } : {}) });
    if (!projectId && plugin.integration) {
      const ready = await creationGate.ensure(project, plugin.id, { canCreate: !!plugin.integration.createProject });
      if (!ready) return;
      project = ready;
    }
    const conversation = await createConversation(project.id);
    const mention: PluginMention = {
      name: plugin.name,
      displayName: plugin.displayName,
      marketplaceId: plugin.marketplace.id,
    };
    setInitialPrompt(undefined);
    setInitialDraft({
      conversationId: conversation.id,
      draft: { prompt: `${pluginMentionToken(mention)} ${prompt}`, mentions: [mention] },
    });
    navigateToConversation(project.id, conversation.id, false, project.integration ? undefined : createdProjectView(project.type));
  }

  function clearInitialPrompt(): void {
    setInitialPrompt(undefined);
  }

  function navigateToConversation(projectId: string, conversationId: string, replace = false, initialView?: "design"): void {
    const current = parseAppRoute(window.location.hash);
    const view = initialView ?? (current.page === "project" && current.projectId === projectId ? current.view : undefined);
    navigate(conversationHash(projectId, conversationId, view), { replace });
  }

  function ohMyGame(gameId: string): void {
    navigate(gameHash(gameId));
  }

  function goToGames(): void {
    const hash = communityHash();
    navigate(hash, { replace: true });
  }

  function navigateToSidebarPage(page: AppNavigationTarget): void {
    if (page === "settings") {
      const hash = settingsHash(DEFAULT_SETTINGS_SECTION);
      navigate(hash, { state: { settingsEntry: true } });
      return;
    }
    const hash = sidebarHash(page);
    if (window.location.hash === hash) return;
    navigate(hash);
  }

  function navigateToSettingsSection(section: SettingsSection): void {
    navigate(settingsHash(section), { replace: true, state: historyState() });
  }

  function navigateToPlugin(pluginId?: string): void {
    navigate(pluginHash(pluginId), { replace: true, state: historyState() });
  }

  function leaveSettings(): void {
    const state = historyState();
    if (state.settingsEntry === true) {
      window.history.back();
      return;
    }
    navigate("#/", { replace: true });
  }
}

function RouteLoading() {
  return <main className="route-loading" aria-busy="true"><WindowDragRegion /></main>;
}
