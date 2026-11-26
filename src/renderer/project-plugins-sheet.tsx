import { useEffect, useState } from "react";
import type { ProjectPluginItem, ProjectPluginsView } from "../shared/plugins.js";
import { deleteProjectPluginCopy, forkProjectPlugin, getProjectPlugins, setProjectPlugin } from "./api.js";
import { t } from "./i18n.js";
import { ArrowLeft, History, MoreHorizontal } from "./icons.js";
import { PluginIcon } from "./plugin-icons.js";
import { PluginChanges } from "./project-plugin-contributions.js";
import { Alert, Badge, Button, DropdownMenu, IconButton, Sheet, Skeleton, Switch, type MenuEntry } from "./ui/index.js";

// A project's plugins: every one that suits it, each on or off here. Those on
// in every project start on; the project's `ohmygame.json` keeps only what
// differs from that. Its Change history lists what the plugins changed, to undo.
export function ProjectPluginsSheet({ projectId, open, busy, onClose, onChanged, onUndone, onOpenPlugins }: {
  projectId: string;
  open: boolean;
  /** An agent is working in the project; its plugins wait until it is done. */
  busy: boolean;
  onClose: () => void;
  /** A plugin was turned on or off here, so the skills and commands the chat offers may have changed. */
  onChanged?: () => void;
  /** A plugin's change to the project's files was undone. */
  onUndone?: () => void;
  onOpenPlugins?: () => void;
}) {
  const [history, setHistory] = useState(false);
  const [view, setView] = useState<ProjectPluginsView>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();

  const load = () => getProjectPlugins(projectId).then((next) => { setView(next); setError(undefined); });
  useEffect(() => {
    if (!open) return;
    setHistory(false);
    setView(undefined);
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [open, projectId]);

  // Turning a plugin on allows what it asks for.
  async function change(plugin: ProjectPluginItem, on: boolean): Promise<void> {
    setPending(plugin.id);
    setError(undefined);
    try {
      await setProjectPlugin(projectId, plugin.id, on);
      onChanged?.();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }

  // Copying a plugin into the project, or putting the installed one back, is a change Change history can undo.
  async function copy(plugin: ProjectPluginItem, action: "fork" | "delete"): Promise<void> {
    setPending(plugin.id);
    setError(undefined);
    try {
      await (action === "fork" ? forkProjectPlugin : deleteProjectPluginCopy)(projectId, plugin.id);
      onChanged?.();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }
  // A `project/` plugin is the project's own, with no installed one to go back to.
  const copyActions = (plugin: ProjectPluginItem): MenuEntry[] => plugin.id.startsWith("project/") ? [] : plugin.copy ? [
    ...(plugin.canCopy ? [{ label: t("projectPlugins.replaceCopy"), description: t("projectPlugins.replaceCopyHint"), onSelect: () => void copy(plugin, "fork") }] : []),
    { label: t("projectPlugins.deleteCopy"), description: t("projectPlugins.deleteCopyHint"), danger: true, onSelect: () => void copy(plugin, "delete") },
  ] : plugin.canCopy && plugin.used !== undefined ? [
    { label: t("projectPlugins.copyToProject"), description: t("projectPlugins.copyToProjectHint"), onSelect: () => void copy(plugin, "fork") },
  ] : [];

  const on = view?.plugins.filter((plugin) => plugin.used !== undefined).length ?? 0;
  const openPlugins = onOpenPlugins ? () => { onClose(); onOpenPlugins(); } : undefined;
  return (
    <Sheet open={open} onClose={onClose} title={t("projectPlugins.title")}
      footer={openPlugins ? <Button onClick={openPlugins}>{t("projectPlugins.manageAll")}</Button> : undefined}>
      {history ? <div className="project-plugins">
        <div><Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => setHistory(false)}>{t("common.back")}</Button></div>
        <PluginChanges projectId={projectId} busy={busy} onUndone={onUndone} />
      </div> : <div className="project-plugins">
        <p className="project-plugins-intro">{t("projectPlugins.intro")}</p>
        {error ? <Alert tone="danger" title={error} /> : null}
        {busy ? <Alert title={t("projectPlugins.busy")} /> : null}
        {!view && !error ? <Skeleton height={120} /> : null}
        <div><Button size="sm" variant="ghost" icon={<History size={14} />} onClick={() => setHistory(true)}>{t("pluginChanges.history")}</Button></div>
        {view ? <section className="project-plugins-section" aria-label={t("projectPlugins.title")}>
          <div className="project-plugins-count">{t("projectPlugins.onCount", { count: on })}</div>
          {view.plugins.length ? view.plugins.map((plugin) => (
            <div className="project-plugin" key={plugin.id}>
              <PluginIcon plugin={plugin} />
              <span className="project-plugin-text">
                <strong>
                  {plugin.displayName}
                  {plugin.providesType ? <Badge tone="outline">{t("projectPlugins.providesType")}</Badge> : null}
                  {plugin.used !== undefined && plugin.everyProject && !plugin.providesType ? <Badge tone="outline">{t("projectPlugins.everyProject")}</Badge> : null}
                  {plugin.used !== undefined && plugin.detected && !plugin.providesType ? <Badge tone="outline">{t("projectPlugins.detected")}</Badge> : null}
                  {plugin.copy ? <span title={t("projectPlugins.copyHint")}><Badge tone="outline">{t("projectPlugins.copy")}</Badge></span> : null}
                </strong>
                {pluginDescription(plugin) ? <small>{pluginDescription(plugin)}</small> : null}
              </span>
              {plugin.used && plugin.status === "needs-consent" ? (
                <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, true)}>{t("projectPlugins.allowHere")}</Button>
              ) : null}
              {openPlugins && (plugin.status === "not-installed" || plugin.status === "incompatible" || (plugin.providesType && plugin.status === "not-applicable")) ? (
                <Button size="sm" variant="ghost" onClick={openPlugins}>{t("projectPlugins.reinstall")}</Button>
              ) : null}
              {plugin.status === "not-installed" && !plugin.providesType ? (
                <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, false)}>{t("projectPlugins.removeHere")}</Button>
              ) : null}
              {copyActions(plugin).length ? <DropdownMenu placement="bottom-end" items={copyActions(plugin)} trigger={(props) => (
                <IconButton {...props} size="sm" label={t("projectPlugins.actions", { name: plugin.displayName })} disabled={busy || pending !== undefined}>
                  <MoreHorizontal size={14} />
                </IconButton>
              )} /> : null}
              {plugin.status !== "not-installed" ? <Switch size="sm" checked={plugin.used !== undefined} label={plugin.displayName}
                disabled={busy || plugin.providesType || pending !== undefined || (!plugin.used && !plugin.version) || plugin.status === "invalid"}
                onChange={(next) => void change(plugin, next)} /> : null}
            </div>
          )) : <p className="project-plugins-empty"><strong>{t("projectPlugins.noneInstalled")}</strong>{t("projectPlugins.noneInstalledHint")}</p>}
        </section> : null}
      </div>}
    </Sheet>
  );
}

function pluginDescription(plugin: ProjectPluginItem): string {
  if (!plugin.status || plugin.status === "active") return plugin.description;
  const status = t(`projectPlugins.status.${plugin.status}`);
  return plugin.issues?.length ? `${status}: ${plugin.issues[0]}` : status;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
