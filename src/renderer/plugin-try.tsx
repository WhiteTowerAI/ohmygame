import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PluginMention, ProjectState, ProjectType } from "../shared/contracts.js";
import { listProjects } from "./api.js";
import { t } from "./i18n.js";
import { ChevronRight, FolderPlus, LoaderCircle, Search } from "./icons.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";

/** What trying a plugin starts: a conversation with its prompt, in a project it works in. */
export interface PluginTryTarget {
  /** A plugin that applies by itself is mentioned in the prompt. */
  mention?: PluginMention;
  /** A plugin, by id, is turned on in the project first. */
  turnOn?: string;
  /** The type of a new project; absent when none of the app's types suits it. */
  newProjectType?: ProjectType;
}

export type TryPlugin = (target: PluginTryTarget, prompt: string, projectId?: string) => Promise<void>;

export interface PluginTryMenu {
  /** The prompt being tried, while the project picker is open. */
  prompt?: string;
  open: (prompt: string) => void;
  close: () => void;
  /** Goes on the element holding the button and `popover`; a click outside it closes the picker. */
  anchor: RefObject<HTMLDivElement | null>;
  popover: ReactNode;
}

/** The project picker a plugin's Try buttons open. */
export function usePluginTry({ displayName, suits, emptyLabel, target, onTry }: {
  displayName: string;
  /** Which of the person's projects it works in. */
  suits: (project: ProjectState) => boolean;
  /** What the list says when no project suits it. */
  emptyLabel: string;
  target: PluginTryTarget;
  onTry: TryPlugin;
}): PluginTryMenu {
  const [prompt, setPrompt] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "starting">("loading");
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prompt) return;
    const close = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setPrompt(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPrompt(undefined);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [prompt]);

  async function open(next: string): Promise<void> {
    setPrompt(next);
    setQuery("");
    setError(undefined);
    setPhase("loading");
    try {
      const items = await listProjects();
      setProjects(items.filter(suits).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  async function start(projectId?: string): Promise<void> {
    if (!prompt || phase === "starting") return;
    setPhase("starting");
    setError(undefined);
    try {
      await onTry(target, prompt, projectId);
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  const normalized = query.trim().toLowerCase();
  const visible = projects.filter((project) => !normalized || project.name.toLowerCase().includes(normalized));
  const popover = prompt ? <div className="plugin-try-popover project-switcher-popover" role="dialog" aria-label={t("plugins.tryName", { name: displayName })}>
    <div className="plugin-try-heading"><strong>{t("plugins.chooseProject")}</strong><span>{t("plugins.promptAdded")}</span></div>
    <label className="project-switcher-search">
      <Search size={13} />
      <input value={query} placeholder={t("projects.search")} aria-label={t("projects.search")} onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="project-switcher-list">
      {phase === "loading" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />{t("projects.loading")}</div> : null}
      {phase === "error" ? <div className="project-switcher-state is-error"><span>{error}</span><button type="button" onClick={() => void open(prompt)}>{t("common.retry")}</button></div> : null}
      {phase === "starting" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />{t("plugins.startingConversation")}</div> : null}
      {phase === "ready" ? visible.map((project) => <button className="project-switcher-item" type="button" key={project.id} onClick={() => void start(project.id)}>
        <ProjectTypeIcon type={project.type} />
        <span><strong>{project.name}</strong><small>{projectTypeLabel(project.type)}</small></span>
        <ChevronRight size={13} />
      </button>) : null}
      {phase === "ready" && !visible.length ? <div className="project-switcher-state">{normalized ? t("plugins.noMatchingProjects") : emptyLabel}</div> : null}
    </div>
    {target.newProjectType ? <div className="project-switcher-footer"><button type="button" disabled={phase === "starting"} onClick={() => void start()}><FolderPlus size={14} />{t("plugins.newProject", { type: projectTypeLabel(target.newProjectType) })}</button></div> : null}
  </div> : null;

  return { prompt, open: (next) => void open(next), close: () => setPrompt(undefined), anchor, popover };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
