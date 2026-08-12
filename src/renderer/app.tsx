import { useEffect, useState } from "react";
import { Community } from "./community.js";
import { Home } from "./home.js";
import { ProjectShell } from "./project-shell.js";
import { parseAppRoute, projectHash } from "./routes.js";
import { Tools } from "./tools.js";

export function App() {
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const [initialPrompt, setInitialPrompt] = useState<{ projectId: string; prompt: string }>();

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
    return <Home onCommunity={openCommunity} onCreate={openCreatedProject} onOpen={openProject} onTools={openTools} />;
  }
  if (route.page === "community") return <Community onHome={goHome} />;
  if (route.page === "tools") return <Tools onCommunity={openCommunity} onHome={goHome} />;
  return (
    <ProjectShell
      key={route.projectId}
      projectId={route.projectId}
      initialPrompt={initialPrompt?.projectId === route.projectId ? initialPrompt.prompt : undefined}
      onInitialPromptHandled={clearInitialPrompt}
      onHome={goHome}
    />
  );

  function openCreatedProject(projectId: string, prompt: string): void {
    setInitialPrompt({ projectId, prompt });
    navigateToProject(projectId);
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

  function goHome(): void {
    window.history.pushState(null, "", "#/");
    setRoute({ page: "home" });
  }

  function openCommunity(): void {
    window.history.pushState(null, "", "#/community");
    setRoute({ page: "community" });
  }

  function openTools(): void {
    window.history.pushState(null, "", "#/tools");
    setRoute({ page: "tools" });
  }
}
