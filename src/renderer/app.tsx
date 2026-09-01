import { useEffect, useState } from "react";
import { Community, CommunityGamePlayer } from "./community.js";
import { Home } from "./home.js";
import { LibraryPage } from "./library.js";
import { PluginsPage } from "./plugins.js";
import { ProjectsPage } from "./projects.js";
import { ProjectShell } from "./project-shell.js";
import { communityGameHash, conversationHash, parseAppRoute, projectHash, sidebarHash, type SidebarPage } from "./routes.js";
import { AssetStudioPage } from "./asset-studio.js";
import type { PromptImage, PromptMode } from "../shared/contracts.js";
import { createPluginAuthoringSession } from "./api.js";

export function App() {
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const [initialPrompt, setInitialPrompt] = useState<{ conversationId: string; prompt: string; images: PromptImage[]; mode: PromptMode }>();
  const [initialDraft, setInitialDraft] = useState<{ conversationId: string; prompt: string }>();

  useEffect(() => {
    const updateRoute = () => setRoute(parseAppRoute(window.location.hash));
    window.addEventListener("hashchange", updateRoute);
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  if (route.page === "home") {
    return <Home onNavigate={navigateToSidebarPage} onCreate={openCreatedProject} onOpen={openProject} />;
  }
  if (route.page === "community") return <Community onNavigate={navigateToSidebarPage} onOpenGame={openCommunityGame} />;
  if (route.page === "community-game") return <CommunityGamePlayer gameId={route.gameId} onBack={goToCommunity} />;
  if (route.page === "plugins") return <PluginsPage onNavigate={navigateToSidebarPage} onAddPlugin={addPlugin} />;
  if (route.page === "projects") return <ProjectsPage onNavigate={navigateToSidebarPage} onOpenProject={openProject} />;
  if (route.page === "interactive-drama") return <ProjectsPage workspace="interactive-drama" onNavigate={navigateToSidebarPage} onOpenProject={openProject} />;
  if (route.page === "library") return <LibraryPage onNavigate={navigateToSidebarPage} onOpenProject={openProject} />;
  if (route.page === "asset-studio") return <AssetStudioPage onNavigate={navigateToSidebarPage} />;
  if (route.page === "playtest") return null;
  if (route.page !== "project") return null;
  return (
    <ProjectShell
      key={route.projectId}
      projectId={route.projectId}
      conversationId={route.conversationId}
      initialPrompt={initialPrompt && initialPrompt.conversationId === route.conversationId ? initialPrompt : undefined}
      initialDraft={initialDraft && initialDraft.conversationId === route.conversationId ? initialDraft.prompt : undefined}
      onInitialPromptHandled={clearInitialPrompt}
      onInitialDraftHandled={() => setInitialDraft(undefined)}
      onOpenConversation={(conversationId, replace = false) => navigateToConversation(route.projectId, conversationId, replace)}
      onHome={goHome}
    />
  );

  function openCreatedProject(projectId: string, conversationId: string, prompt: string, images: PromptImage[], mode: PromptMode): void {
    setInitialPrompt({ conversationId, prompt, images, mode });
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
    setInitialDraft({ conversationId: session.conversationId, prompt: "$plugin-creator Create an OpenGame plugin that " });
    navigateToConversation(session.projectId, session.conversationId);
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

  function openCommunityGame(gameId: string): void {
    window.history.pushState(null, "", communityGameHash(gameId));
    setRoute({ page: "community-game", gameId });
  }

  function goToCommunity(): void {
    window.history.replaceState(null, "", sidebarHash("community"));
    setRoute({ page: "community" });
  }

  function navigateToSidebarPage(page: SidebarPage): void {
    const hash = sidebarHash(page);
    if (window.location.hash === hash) return;
    window.history.pushState(null, "", hash);
    setRoute({ page });
  }
}
