import { useEffect, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { matchesWhen, type WhenContext } from "../shared/plugin-when.js";
import type { ProjectPluginChange, ProjectPluginCommand } from "../shared/plugins.js";
import { getPluginPanels, getProjectPlugins, listProjectPluginChanges, listProjectPluginCommands, undoProjectPluginChange, type PluginPanel } from "./api.js";
import { language, t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Alert, Button, Empty, Sheet, Skeleton } from "./ui/index.js";
import type { PanelId } from "./workspace-layout.js";

// What a project's format 2 plugins add to its workspace: panels beside the
// built-in ones, and commands in the slots their manifests name. The project
// shell reads them again whenever its plugins may have changed.

export const pluginPanelId = (panel: Pick<PluginPanel, "plugin" | "id">): PanelId => `plugin:${panel.plugin}:${panel.id}`;

/** What `when` sees in a project; names nothing here knows stay undefined. */
export function projectWhenContext(project: Pick<ProjectState, "type" | "pluginType">, plugins: Iterable<string>): WhenContext {
  return {
    values: {
      "project.type": project.pluginType?.id ?? project.type,
      platform: typeof window === "undefined" ? undefined : window.ohMyGameDesktop?.platform ?? "web",
    },
    plugins: new Set(plugins),
  };
}

/** What a prompt command sends, naming its skill first when it has one. */
export function commandPrompt(run: { prompt: string; skill?: string }): string {
  return run.skill ? `Use the ${run.skill} skill.\n\n${run.prompt}` : run.prompt;
}

/**
 * How a plugin page's `command.run` is carried out. Tool and native commands
 * run in the plugin. A page never sends a message: a prompt only fills the
 * composer, and only for a page allowed to; other app commands run as from a menu.
 */
export function pageCommand(panel: Pick<PluginPanel, "plugin" | "capabilities">, command: ProjectPluginCommand | undefined):
  | { kind: "plugin" }
  | { kind: "fill"; text: string }
  | { kind: "app"; command: ProjectPluginCommand } {
  if (!command || "tool" in command.run || "native" in command.run) return { kind: "plugin" };
  if (!("prompt" in command.run)) return { kind: "app", command };
  if (!panel.capabilities.composer) throw new Error(`${panel.plugin} can't use the composer`);
  return { kind: "fill", text: commandPrompt(command.run) };
}

/** The commands a slot shows, in manifest order. */
export function commandsForSlot(commands: readonly ProjectPluginCommand[], slot: string, context: WhenContext): ProjectPluginCommand[] {
  return commands.filter((command) => command.slots.some((entry) => entry.slot === slot && matchesWhen(entry.when, context)));
}

/** The "/" list: commands with a `slash` name, and those in the `composer.slash` slot. */
export function slashCommands(commands: readonly ProjectPluginCommand[], context: WhenContext): ProjectPluginCommand[] {
  const slotted = new Set(commandsForSlot(commands, "composer.slash", context));
  return commands.filter((command) => slotted.has(command) || (command.slash && !command.slots.some((entry) => entry.slot === "composer.slash")));
}

export function useProjectPluginContributions(project: Pick<ProjectState, "id" | "type" | "pluginType"> | undefined, revision: number): {
  panels: PluginPanel[];
  commands: ProjectPluginCommand[];
  when?: WhenContext;
} {
  const generation = useReadyRuntimeGeneration();
  const [loaded, setLoaded] = useState<{ projectId: string; panels: PluginPanel[]; commands: ProjectPluginCommand[]; active: string[] }>();
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    // A project whose plugins can't be read shows only the built-in panels.
    void Promise.all([
      getPluginPanels(projectId, language).catch((): PluginPanel[] => []),
      listProjectPluginCommands(projectId).catch((): ProjectPluginCommand[] => []),
      // `project.plugin('<id>')` asks about every active plugin, with or without panels.
      getProjectPlugins(projectId)
        .then((view) => view.plugins.flatMap((plugin) => plugin.status === "active" ? [plugin.id] : []))
        .catch((): string[] => []),
    ]).then(([panels, commands, active]) => {
      if (!disposed) setLoaded({ projectId, panels, commands, active });
    });
    return () => { disposed = true; };
  }, [projectId, revision, generation]);
  if (!project || loaded?.projectId !== project.id) return { panels: [], commands: [] };
  const when = projectWhenContext(project, [...loaded.active, ...[...loaded.panels, ...loaded.commands].map((item) => item.plugin)]);
  return {
    // A page needs its address; one without it can't be shown.
    panels: loaded.panels.filter((panel) => panel.url && matchesWhen(panel.when, when)),
    commands: loaded.commands,
    when,
  };
}

/** What the project's plugins changed outside a turn, each with its own Undo. */
export function PluginChangesSheet({ projectId, open, busy, onClose, onUndone }: {
  projectId: string;
  open: boolean;
  /** An agent is working; an undo waits until it is done. */
  busy: boolean;
  onClose: () => void;
  onUndone: () => void;
}) {
  const [changes, setChanges] = useState<ProjectPluginChange[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const load = () => listProjectPluginChanges(projectId).then((next) => { setChanges(next); setError(undefined); });
  useEffect(() => {
    if (!open) return;
    setChanges(undefined);
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [open, projectId]);

  async function undo(change: ProjectPluginChange): Promise<void> {
    setPending(change.id);
    setError(undefined);
    try {
      await undoProjectPluginChange(projectId, change.id);
      onUndone();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }

  return <Sheet open={open} onClose={onClose} title={t("pluginChanges.title")}>
    <div className="project-plugins">
      <p className="project-plugins-intro">{t("pluginChanges.hint")}</p>
      {error ? <Alert tone="danger" title={error} /> : null}
      {busy ? <Alert title={t("pluginChanges.busy")} /> : null}
      {!changes && !error ? <Skeleton height={120} /> : null}
      {changes && !changes.length ? <Empty title={t("pluginChanges.empty")} /> : null}
      {changes?.map((change) => <div className="project-plugin" key={change.id}>
        <span className="project-plugin-text">
          <strong>{change.title}</strong>
          <small>
            {change.plugin} · {new Date(change.at).toLocaleString(language)}
            {" · "}{t("pluginChanges.files", { count: change.changed.length })}
          </small>
          {change.failed ? <small>{t("pluginChanges.failed", { error: change.failed })}</small> : null}
        </span>
        {change.undone ? <span className="project-plugins-count">{t("pluginChanges.undone")}</span>
          : change.changed.length ? <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void undo(change)}>{t("pluginChanges.undo")}</Button> : null}
      </div>)}
    </div>
  </Sheet>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
