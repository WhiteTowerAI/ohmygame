import { useEffect, useState } from "react";
import { GamePlayer, GamesPage } from "./games.js";
import { Home } from "./home.js";
import { LibraryPage } from "./library.js";
import { PluginsPage } from "./plugins.js";
import { ProjectsPage } from "./projects.js";
import { ProjectShell } from "./project-shell.js";
import { communityHash, conversationHash, gameHash, parseAppRoute, projectHash, settingsHash, sidebarHash, type AppNavigationTarget, type SettingsSection } from "./routes.js";
import { AssetStudioPage } from "./asset-studio.js";
import { InteractiveDramaHome } from "./interactive-drama-home.js";
import { SettingsPage } from "./settings-page.js";
import type { PluginMention, PromptImage, PromptMode } from "../shared/contracts.js";
import type { PluginDetail } from "../shared/plugins.js";
import { pluginMentionToken } from "../shared/plugins.js";
import { createConversation, createPluginAuthoringSession, createProject } from "./api.js";
import type { ComposerDraft } from "./composer.js";

export function App() {
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const [initialPrompt, setInitialPrompt] = useState<{ conversationId: string; prompt: string; mentions: PluginMention[]; images: PromptImage[]; mode: PromptMode }>();
  const [initialDraft, setInitialDraft] = useState<{ conversationId: string; draft: ComposerDraft }>();

  useEffect(() => {
    const updateRoute = () => setRoute(parseAppRoute(window.location.hash));
    window.addEventListener("hashchange", updateRoute);
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  if (route.page === "settings") {
    return <SettingsPage section={route.section} onBack={leaveSettings} onSectionChange={navigateToSettingsSection} />;
  }
  if (route.page === "home") {
    return <Home onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpen={openProject} />;
  }
  if (route.page === "community") {
    return <GamesPage onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} />;
  }
  if (route.page === "game") return <GamePlayer gameId={route.gameId} onBack={goToGames} onNavigate={navigateToSidebarPage} onOhMyGame={ohMyGame} />;
  if (route.page === "plugins") return <PluginsPage onNavigate={navigateToSidebarPage} onAddPlugin={addPlugin} onTryPlugin={tryPlugin} />;
  if (route.page === "projects") return <ProjectsPage onNavigate={navigateToSidebarPage} onOpenProject={openProject} />;
  if (route.page === "interactive-drama") return <InteractiveDramaHome onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpenProject={openProject} />;
  if (route.page === "library") return <LibraryPage onNavigate={navigateToSidebarPage} />;
  if (route.page === "asset-studio") return <AssetStudioPage onNavigate={navigateToSidebarPage} />;
  if (route.page === "playtest") return null;
  if (route.page !== "project") return null;
  return (
    <ProjectShell
      key={route.projectId}
      projectId={route.projectId}
      conversationId={route.conversationId}
      initialPrompt={initialPrompt && initialPrompt.conversationId === route.conversationId ? initialPrompt : undefined}
      initialDraft={initialDraft && initialDraft.conversationId === route.conversationId ? initialDraft.draft : undefined}
      onInitialPromptHandled={clearInitialPrompt}
      onInitialDraftHandled={() => setInitialDraft(undefined)}
      onOpenConversation={(conversationId, replace = false) => navigateToConversation(route.projectId, conversationId, replace)}
      onHome={goHome}
    />
  );

  function openCreatedProject(projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode): void {
    setInitialPrompt({ conversationId, prompt, mentions, images, mode });
    navigateToConversation(projectId, conversationId);
  }

  function openProject(projectId: string): void {
    setInitialPrompt(undefined);
    setInitialDraft(undefined);
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

  function navigateToProject(projectId: string): void {
    window.history.pushState(null, "", projectHash(projectId));
    setRoute({ page: "project", projectId });
  }

  function navigateToConversation(projectId: string, conversationId: string, replace = false): void {
    window.history[replace ? "replaceState" : "pushState"](null, "", conversationHash(projectId, conversationId));
    setRoute({ page: "project", projectId, conversationId });
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
      const hash = settingsHash("account");
      window.history.pushState({ ...historyState(), settingsEntry: true }, "", hash);
      setRoute({ page: "settings", section: "account" });
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
