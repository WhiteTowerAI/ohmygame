import { useEffect, useState } from "react";
import { CommunityProfilePage } from "./community-profile.js";
import { GamePlayer, GamesPage } from "./games.js";
import { Home } from "./home.js";
import { LibraryPage } from "./library.js";
import { ProjectsPage } from "./projects.js";
import { ProjectShell } from "./project-shell.js";
import { communityHash, createdProjectView, conversationHash, DEFAULT_SETTINGS_SECTION, gameHash, parseAppRoute, pluginHash, projectHash, projectsHash, settingsHash, sidebarHash, type AppNavigationTarget, type SettingsSection } from "./routes.js";
import { historyState, useAppNavigation } from "./app-navigation.js";
import { AssetCanvasHome } from "./asset-canvas-home.js";
import { invalidateQuickStartModels, loadQuickStartModels } from "./asset-canvas-quick-start.js";
import { GameStudioHome } from "./game-studio-home.js";
import { SettingsPage } from "./settings-page.js";
import { PluginBuilder } from "./plugin-builder.js";
import type { PluginMention, ProjectState, PromptAttachment, PromptImage, PromptMode } from "../shared/contracts.js";
import type { PluginDetail } from "../shared/plugins.js";
import { pluginMentionToken } from "../shared/plugins.js";
import { createConversation, createProject, MODELS_CHANGED_EVENT } from "./api.js";
import type { ComposerDraft } from "./composer.js";
import { runtimeConnection, useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Onboarding, OnboardingLoading } from "./onboarding.js";
import { useOnboarding } from "./use-onboarding.js";

export function App() {
  const serviceGeneration = useReadyRuntimeGeneration();
  const { route, navigate, projectReturnTo, projectBackLabel } = useAppNavigation();
  const onboarding = useOnboarding(route.page === "home");
  const [initialPrompt, setInitialPrompt] = useState<{ generation: number; conversationId: string; prompt: string; mentions: PluginMention[]; images: PromptImage[]; mode: PromptMode; attachments?: PromptAttachment[] }>();
  const [initialDraft, setInitialDraft] = useState<{ conversationId: string; draft: ComposerDraft }>();
  const [initialCanvasNode, setInitialCanvasNode] = useState<{ projectId: string; nodeId: string }>();

  // Provider catalogs are slow; load them now so asset canvas quick starts open without waiting.
  useEffect(() => {
    invalidateQuickStartModels();
    void loadQuickStartModels();
    if (serviceGeneration > 1) window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
    const refresh = () => { invalidateQuickStartModels(); void loadQuickStartModels(); };
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, refresh);
  }, [serviceGeneration]);

  if ((route.page === "home" || onboarding.replaying) && onboarding.state?.status === "pending") {
    return <Onboarding step={onboarding.state.step}
      onStepChange={(step) => onboarding.save({ status: "pending", step })}
      onFinish={async (status) => { await onboarding.save({ status, step: onboarding.state?.step ?? "welcome" }); navigate("#/"); }} />;
  }
  if (route.page === "home" && !onboarding.state) return <OnboardingLoading error={onboarding.error} onRetry={onboarding.retry} />;
  if (route.page === "plugin-builder") return <PluginBuilder key={route.sessionId} sessionId={route.sessionId} />;
  if (route.page === "settings") {
    return <SettingsPage section={route.section} pluginId={route.pluginId} onBack={leaveSettings} onSectionChange={navigateToSettingsSection} onPluginChange={navigateToPlugin} onTryPlugin={tryPlugin} onOpenOnboarding={onboarding.open} />;
  }
  if (route.page === "home") {
    return <Home onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpen={openProject} />;
  }
  if (route.page === "community") {
    return <GamesPage onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} />;
  }
  if (route.page === "community-profile") return <CommunityProfilePage authorId={route.authorId} onNavigate={navigateToSidebarPage} onBack={goToGames} onOpenGame={ohMyGame} />;
  if (route.page === "game") return <GamePlayer gameId={route.gameId} onBack={goToGames} onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} />;
  if (route.page === "projects") return <ProjectsPage projectType={route.projectType} query={route.query} sort={route.sort} onFiltersChange={(filters, replace) => navigate(projectsHash(filters), { replace })} onNavigate={navigateToSidebarPage} onOpenProject={openProject} />;
  if (route.page === "general" || route.page === "web-game" || route.page === "interactive-story" || route.page === "godot") return <GameStudioHome key={route.page} projectType={route.page === "godot" ? "godot-game" : route.page} onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpenProject={openProject} />;
  if (route.page === "asset-canvas") return <AssetCanvasHome onNavigate={navigateToSidebarPage} onOpenProject={openAssetCanvasProject} />;
  if (route.page === "library") return <LibraryPage onNavigate={navigateToSidebarPage} />;
  if (route.page === "playtest") return null;
  if (route.page !== "project") return null;
  return (
    <ProjectShell
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
      onInitialPromptHandled={clearInitialPrompt}
      onInitialDraftHandled={() => setInitialDraft(undefined)}
      onOpenConversation={(conversationId, replace = false) => navigateToConversation(route.projectId, conversationId, replace)}
      onHome={() => navigate(projectReturnTo)}
      homeLabel={projectBackLabel}
    />
  );

  function openCreatedProject(project: ProjectState, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]): void {
    const connection = runtimeConnection();
    setInitialPrompt({ generation: connection.status === "ready" ? connection.generation : -1, conversationId, prompt, mentions, images, mode, attachments });
    navigateToConversation(project.id, conversationId, false, createdProjectView(project.type));
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
    const project = projectId ? { id: projectId, type: undefined } : await createProject({ type: plugin.projectTypes?.[0] ?? "web-game" });
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
    navigateToConversation(project.id, conversation.id, false, createdProjectView(project.type));
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
    navigate(pluginId ? pluginHash(pluginId) : settingsHash("plugins"), { replace: true, state: historyState() });
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
