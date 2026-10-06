import { useEffect, useState } from "react";
import { GamePlayer, GamesPage } from "./games.js";
import { Home } from "./home.js";
import { LibraryPage } from "./library.js";
import { ProjectsPage } from "./projects.js";
import { ProjectShell } from "./project-shell.js";
import { communityHash, conversationHash, DEFAULT_SETTINGS_SECTION, gameHash, parseAppRoute, pluginHash, projectHash, settingsHash, sidebarHash, type AppNavigationTarget, type SettingsSection } from "./routes.js";
import { AssetCanvasHome } from "./asset-canvas-home.js";
import { loadQuickStartModels } from "./asset-canvas-quick-start.js";
import { GameStudioHome } from "./game-studio-home.js";
import { SettingsPage } from "./settings-page.js";
import type { PluginMention, PromptAttachment, PromptImage, PromptMode } from "../shared/contracts.js";
import type { PluginDetail } from "../shared/plugins.js";
import { pluginMentionToken } from "../shared/plugins.js";
import { createConversation, createPluginAuthoringSession, createProject } from "./api.js";
import type { ComposerDraft } from "./composer.js";

export function App() {
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const [initialPrompt, setInitialPrompt] = useState<{ conversationId: string; prompt: string; mentions: PluginMention[]; images: PromptImage[]; mode: PromptMode; attachments?: PromptAttachment[] }>();
  const [initialDraft, setInitialDraft] = useState<{ conversationId: string; draft: ComposerDraft }>();
  const [initialCanvasNode, setInitialCanvasNode] = useState<{ projectId: string; nodeId: string }>();

  // Provider catalogs are slow; load them now so asset canvas quick starts open without waiting.
  useEffect(() => { void loadQuickStartModels(); }, []);

  useEffect(() => {
    const updateRoute = () => {
      const next = parseAppRoute(window.location.hash);
      if (next.page === "settings" && next.section === "plugins" && window.location.hash.startsWith("#/plugins")) {
        window.history.replaceState(window.history.state, "", next.pluginId ? pluginHash(next.pluginId) : settingsHash("plugins"));
      }
      setRoute(next);
    };
    updateRoute();
    window.addEventListener("hashchange", updateRoute);
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  if (route.page === "settings") {
    return <SettingsPage section={route.section} pluginId={route.pluginId} onBack={leaveSettings} onSectionChange={navigateToSettingsSection} onPluginChange={navigateToPlugin} onAddPlugin={addPlugin} onTryPlugin={tryPlugin} />;
  }
  if (route.page === "home") {
    return <Home onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpen={openProject} />;
  }
  if (route.page === "community") {
    return <GamesPage onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} />;
  }
  if (route.page === "game") return <GamePlayer gameId={route.gameId} onBack={goToGames} onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} />;
  if (route.page === "projects") return <ProjectsPage projectType={route.projectType} onNavigate={navigateToSidebarPage} onOpenProject={openProject} />;
  if (route.page === "web-game" || route.page === "interactive-story" || route.page === "godot") return <GameStudioHome key={route.page} projectType={route.page === "godot" ? "godot-game" : route.page} onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpenProject={openProject} />;
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
      onViewChange={(view) => {
        const next = { ...route, view: view === "design" ? "design" as const : undefined };
        window.history.pushState(null, "", next.conversationId ? conversationHash(next.projectId, next.conversationId, next.view) : projectHash(next.projectId, next.view));
        setRoute(next);
      }}
      initialPrompt={initialPrompt && initialPrompt.conversationId === route.conversationId ? initialPrompt : undefined}
      initialDraft={initialDraft && initialDraft.conversationId === route.conversationId ? initialDraft.draft : undefined}
      initialCanvasNodeId={initialCanvasNode?.projectId === route.projectId ? initialCanvasNode.nodeId : undefined}
      onInitialCanvasNodeHandled={() => setInitialCanvasNode(undefined)}
      onInitialPromptHandled={clearInitialPrompt}
      onInitialDraftHandled={() => setInitialDraft(undefined)}
      onOpenConversation={(conversationId, replace = false) => navigateToConversation(route.projectId, conversationId, replace)}
      onHome={goHome}
    />
  );

  function openCreatedProject(projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]): void {
    setInitialPrompt({ conversationId, prompt, mentions, images, mode, attachments });
    navigateToConversation(projectId, conversationId);
  }

  function openProject(projectId: string, view?: "design"): void {
    setInitialPrompt(undefined);
    setInitialDraft(undefined);
    setInitialCanvasNode(undefined);
    navigateToProject(projectId, view);
  }

  function openAssetCanvasProject(projectId: string, nodeId?: string): void {
    setInitialPrompt(undefined);
    setInitialDraft(undefined);
    setInitialCanvasNode(nodeId ? { projectId, nodeId } : undefined);
    navigateToProject(projectId);
  }

  async function addPlugin(): Promise<void> {
    const session = await createPluginAuthoringSession();
    setInitialPrompt(undefined);
    setInitialDraft({ conversationId: session.conversationId, draft: { prompt: "$plugin-creator Create an OhMyGame plugin that ", mentions: [] } });
    navigateToConversation(session.projectId, session.conversationId);
  }

  async function tryPlugin(plugin: PluginDetail, prompt: string, projectId?: string): Promise<void> {
    const project = projectId ? { id: projectId } : await createProject({ type: plugin.projectTypes?.[0] ?? "web-game" });
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
    navigateToConversation(project.id, conversation.id);
  }

  function clearInitialPrompt(): void {
    setInitialPrompt(undefined);
  }

  function navigateToProject(projectId: string, view?: "design"): void {
    window.history.pushState(null, "", projectHash(projectId, view));
    setRoute({ page: "project", projectId, ...(view ? { view } : {}) });
  }

  function navigateToConversation(projectId: string, conversationId: string, replace = false): void {
    const current = parseAppRoute(window.location.hash);
    const view = current.page === "project" && current.projectId === projectId ? current.view : undefined;
    window.history[replace ? "replaceState" : "pushState"](null, "", conversationHash(projectId, conversationId, view));
    setRoute({ page: "project", projectId, conversationId, ...(view ? { view } : {}) });
  }

  function goHome(): void {
    window.history.pushState(null, "", "#/");
    setRoute({ page: "home" });
  }

  function ohMyGame(gameId: string): void {
    window.history.pushState(null, "", gameHash(gameId));
    setRoute({ page: "game", gameId });
  }

  function goToGames(): void {
    const hash = communityHash();
    window.history.replaceState(null, "", hash);
    setRoute({ page: "community" });
  }

  function navigateToSidebarPage(page: AppNavigationTarget): void {
    if (page === "settings") {
      const hash = settingsHash(DEFAULT_SETTINGS_SECTION);
      window.history.pushState({ ...historyState(), settingsEntry: true }, "", hash);
      setRoute({ page: "settings", section: DEFAULT_SETTINGS_SECTION });
      return;
    }
    if (page === "community") {
      const hash = communityHash();
      if (window.location.hash === hash) return;
      window.history.pushState(null, "", hash);
      setRoute({ page: "community" });
      return;
    }
    const hash = sidebarHash(page);
    if (window.location.hash === hash) return;
    window.history.pushState(null, "", hash);
    setRoute({ page });
  }

  function navigateToSettingsSection(section: SettingsSection): void {
    window.history.replaceState(historyState(), "", settingsHash(section));
    setRoute({ page: "settings", section });
  }

  function navigateToPlugin(pluginId?: string): void {
    window.history.replaceState(historyState(), "", pluginId ? pluginHash(pluginId) : settingsHash("plugins"));
    setRoute({ page: "settings", section: "plugins", ...(pluginId ? { pluginId } : {}) });
  }

  function leaveSettings(): void {
    const state = historyState();
    if (state.settingsEntry === true) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", "#/");
    setRoute({ page: "home" });
  }
}

function historyState(): Record<string, unknown> {
  return window.history.state && typeof window.history.state === "object"
    ? window.history.state as Record<string, unknown>
    : {};
}
