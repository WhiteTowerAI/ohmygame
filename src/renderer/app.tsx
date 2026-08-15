import { useEffect, useState } from "react";
import { Community } from "./community.js";
import { Home } from "./home.js";
import { ProjectShell } from "./project-shell.js";
import { conversationHash, parseAppRoute, projectHash } from "./routes.js";
import { ImagesPage } from "./tools.js";

export function App() {
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const [initialPrompt, setInitialPrompt] = useState<{ conversationId: string; prompt: string }>();

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
    return <Home onCommunity={openCommunity} onHome={goHome} onCreate={openCreatedProject} onOpen={openProject} onImages={openImages} />;
  }
  if (route.page === "community") return <Community onHome={goHome} />;
  if (route.page === "images") return <ImagesPage onCommunity={openCommunity} onHome={goHome} />;
  return (
    <ProjectShell
      key={route.projectId}
      projectId={route.projectId}
      conversationId={route.conversationId}
      initialPrompt={initialPrompt && initialPrompt.conversationId === route.conversationId ? initialPrompt.prompt : undefined}
      onInitialPromptHandled={clearInitialPrompt}
      onOpenConversation={(conversationId, replace = false) => navigateToConversation(route.projectId, conversationId, replace)}
      onHome={goHome}
    />
  );

  function openCreatedProject(projectId: string, conversationId: string, prompt: string): void {
    setInitialPrompt({ conversationId, prompt });
    navigateToConversation(projectId, conversationId);
  }

  function openProject(projectId: string): void {
    setInitialPrompt(undefined);
    navigateToProject(projectId);
  }

  function clearInitialPrompt(): void {
    setInitialPrompt(undefined);
  }

  function navigateToProject(projectId: string): void {
    window.history.pushState(null, "", projectHash(projectId));
    setRoute({ page: "project", projectId });
  }

  function navigateToConversation(projectId: string, conversationId: string, replace = false): void {
    const hash = conversationHash(projectId, conversationId);
    window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    setRoute({ page: "project", projectId, conversationId });
  }

  function goHome(): void {
    window.history.pushState(null, "", "#/");
    setRoute({ page: "home" });
  }

  function openCommunity(): void {
    window.history.pushState(null, "", "#/community");
    setRoute({ page: "community" });
  }

  function openImages(): void {
    window.history.pushState(null, "", "#/images");
    setRoute({ page: "images" });
  }
}
