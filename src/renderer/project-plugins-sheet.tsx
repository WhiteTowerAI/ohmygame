import { useEffect, useState } from "react";
import type { ProjectPluginItem, ProjectPluginsView } from "../shared/plugins.js";
import { consentToPlugin, getProjectPlugins, setProjectPluginVersion } from "./api.js";
import { t } from "./i18n.js";
import { PluginIcon } from "./plugin-icons.js";
import { Alert, Badge, Button, Dialog, Sheet, Skeleton, Switch } from "./ui/index.js";

// A project's plugins. Plugins from the Plugins page are on for every project
// they work with, so they show here locked; those a project turns on itself
// are recorded in its `ohmygame.json` and switch here.
export function ProjectPluginsSheet({ projectId, open, busy, onClose, onChanged, onOpenPlugins }: {
  projectId: string;
  open: boolean;
  /** An agent is working in the project; its plugins wait until it is done. */
  busy: boolean;
  onClose: () => void;
  /** A plugin was turned on or off here, so the skills and commands the chat offers may have changed. */
  onChanged?: () => void;
  onOpenPlugins?: () => void;
}) {
  const [view, setView] = useState<ProjectPluginsView>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [consent, setConsent] = useState<ProjectPluginItem>();

  const load = () => getProjectPlugins(projectId).then((next) => { setView(next); setError(undefined); });
  useEffect(() => {
    if (!open) return;
    setView(undefined);
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [open, projectId]);

  async function change(plugin: ProjectPluginItem, on: boolean, consented = plugin.consented): Promise<void> {
    if (on && !consented) {
      setConsent(plugin);
      return;
    }
    setPending(plugin.id);
    setError(undefined);
    try {
      if (on && !plugin.consented) await consentToPlugin(plugin.id, plugin.capabilities);
      // Turning on again at the version in use is how a project allows a plugin it asks for.
      await setProjectPluginVersion(projectId, plugin.id, on ? plugin.used ?? plugin.version : null);
      onChanged?.();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t("projectPlugins.title")}
      footer={onOpenPlugins ? <Button onClick={() => { onClose(); onOpenPlugins(); }}>{t("projectPlugins.manageAll")}</Button> : undefined}>
      {/* A flat list as in the lab: this project's plugins, then those every project uses. */}
      <div className="project-plugins">
        <p className="project-plugins-intro">{t("projectPlugins.thisProjectHint")}</p>
        {error ? <Alert tone="danger" title={error} /> : null}
        {busy ? <Alert title={t("projectPlugins.busy")} /> : null}
        {!view && !error ? <Skeleton height={120} /> : null}
        {view ? <>
          <section className="project-plugins-section" aria-label={t("projectPlugins.thisProject")}>
            <div className="project-plugins-count">{t("projectPlugins.onCount", { count: view.plugins.filter((plugin) => plugin.used !== undefined).length })}</div>
            {view.plugins.length ? view.plugins.map((plugin) => (
              <div className="project-plugin" key={plugin.id}>
                <PluginIcon plugin={plugin} />
                <span className="project-plugin-text">
                  <strong>{plugin.displayName}{plugin.providesType ? <Badge tone="outline">{t("projectPlugins.providesType")}</Badge> : null}</strong>
                  {pluginDescription(plugin) ? <small>{pluginDescription(plugin)}</small> : null}
                </span>
                {plugin.used && (plugin.status === "needs-approval" || plugin.status === "needs-consent") ? (
                  <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, true)}>{t("projectPlugins.allowHere")}</Button>
                ) : null}
                <Switch size="sm" checked={plugin.used !== undefined} label={plugin.displayName}
                  disabled={busy || plugin.providesType || pending !== undefined || (!plugin.used && !plugin.version)}
                  onChange={(on) => void change(plugin, on)} />
              </div>
            )) : <p className="project-plugins-empty"><strong>{t("projectPlugins.noneInstalled")}</strong>{t("projectPlugins.noneInstalledHint")}</p>}
          </section>
          {view.global.length ? <section className="project-plugins-section" aria-label={t("projectPlugins.everyProject")}>
            <div className="project-plugins-count">{t("projectPlugins.everyProject")}</div>
            <p className="project-plugins-intro">{t("projectPlugins.everyProjectHint")}</p>
            {view.global.map((plugin) => (
              <div className="project-plugin" key={plugin.id}>
                <PluginIcon plugin={plugin} />
                <span className="project-plugin-text">
                  <strong>{plugin.displayName}</strong>
                  {plugin.description ? <small>{plugin.description}</small> : null}
                </span>
                <Switch size="sm" checked label={plugin.displayName} disabled onChange={() => {}} />
              </div>
            ))}
          </section> : null}
        </> : null}
      </div>
      {consent ? <Dialog open title={t("projectPlugins.consentTitle", { name: consent.displayName })} onClose={() => setConsent(undefined)}
        footer={<>
          <Button variant="ghost" onClick={() => setConsent(undefined)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            const plugin = consent;
            setConsent(undefined);
            void change(plugin, true, true);
          }}>{t("projectPlugins.allow")}</Button>
        </>}>
        <p>{t("projectPlugins.consentHint")}</p>
        <ul className="project-plugins-capabilities">
          {consent.capabilities.map((capability) => <li key={capability}><code>{capability}</code></li>)}
        </ul>
      </Dialog> : null}
    </Sheet>
  );
}

function pluginDescription(plugin: ProjectPluginItem): string {
  if (!plugin.status || plugin.status === "active") return plugin.description;
  return t(`projectPlugins.status.${plugin.status}`);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
