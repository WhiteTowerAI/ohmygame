import { ArrowUp, FolderCode, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentModelRef, ProjectState } from "../shared/contracts.js";
import { createConversation, createProject, listProjects, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";

interface HomeProps {
  onCommunity: () => void;
  onCreate: (projectId: string, conversationId: string, prompt: string) => void;
  onOpen: (projectId: string) => void;
  onTools: () => void;
}

export function Home({ onCommunity, onCreate, onOpen, onTools }: HomeProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const modelCatalog = useAgentModels();

  async function loadProjects() {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      setProjects(await listProjects());
      setPhase("ready");
    } catch (error) {
      setLoadError(errorMessage(error));
      setPhase("error");
    }
  }

  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => {
    if (!model && modelCatalog.defaultModel) setModel(modelCatalog.defaultModel);
  }, [model, modelCatalog.defaultModel]);

  async function submitPrompt() {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || creating) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const project = await createProject();
      const conversation = await createConversation(project.id, model);
      onCreate(project.id, conversation.id, nextPrompt);
    } catch (error) {
      setCreateError(errorMessage(error));
      setCreating(false);
    }
  }

  return (
    <main className="home-shell">
      <AppSidebar active="home" onCommunity={onCommunity} onTools={onTools} />

      <section className="home-content">
        <div className="home-start">
          <h1>OpenGame</h1>
          <PromptBox
            actions={(
              <>
                <ModelSelector models={modelCatalog.models} value={model} disabled={creating} onChange={setModel} />
                <button
                  className="icon-button send-button"
                  type="submit"
                  disabled={!prompt.trim() || creating}
                  title="Create project"
                  aria-label="Create project"
                >
                  {creating ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}
                </button>
              </>
            )}
            disabled={creating}
            onChange={setPrompt}
            onSubmit={() => void submitPrompt()}
            placeholder="Ask your agent to build anything"
            value={prompt}
            variant="home"
          />
          {createError ? <p className="home-notice" role="alert">{createError}</p> : null}
        </div>

        <section className="home-projects" aria-labelledby="projects-heading">
          <div className="home-section-heading">
            <h2 id="projects-heading">Projects</h2>
            {phase === "error" ? (
              <button type="button" onClick={() => void loadProjects()}>
                <RefreshCw size={14} />Retry
              </button>
            ) : null}
          </div>

          {phase === "loading" ? <ProjectGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? (
            <p className="home-project-state">No projects yet</p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="home-project-grid">
              {projects.map((project) => (
                <button className="home-project" type="button" key={project.id} onClick={() => onOpen(project.id)}>
                  <span className="home-project-icon"><FolderCode size={22} /></span>
                  <span className="home-project-name" title={project.name}>{project.name}</span>
                  <span className={`home-project-status home-project-status-${project.preview.status}`}>
                    {projectStatus(project)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="home-project-grid" aria-label="Loading projects">
      {[0, 1, 2, 3].map((item) => <div className="home-project home-project-skeleton" key={item} />)}
    </div>
  );
}

function projectStatus(project: ProjectState): string {
  if (project.preview.status === "ready") return "Preview ready";
  if (project.preview.status === "error") return "Preview failed";
  if (project.preview.status === "waiting") return "Not built yet";
  return "Ready to open";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
