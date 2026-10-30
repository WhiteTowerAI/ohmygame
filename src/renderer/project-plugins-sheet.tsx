import { useEffect, useState } from "react";
import type { ProjectPluginItem, ProjectPluginsView } from "../shared/plugins.js";
import { consentToPlugin, getProjectPlugins, setProjectPluginVersion } from "./api.js";
import { t } from "./i18n.js";
import { SettingsGroup, SettingsRow } from "./settings-parts.js";
import { Alert, Badge, Button, Dialog, Sheet, Skeleton, Switch } from "./ui/index.js";

// A project's plugins. Plugins from the Plugins page are on for every project
// they work with, so they show here locked; those a project turns on itself
// are recorded in its `ohmygame.json` and switch here.
export function ProjectPluginsSheet({ projectId, open, busy, onClose }: {
  projectId: string;
  open: boolean;
  /** An agent is working in the project; its plugins wait until it is done. */
  busy: boolean;
  onClose: () => void;
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
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t("projectPlugins.title")}>
      <div className="project-plugins">
        {error ? <Alert tone="danger" title={error} /> : null}
        {busy ? <Alert title={t("projectPlugins.busy")} /> : null}
        {!view && !error ? <Skeleton height={120} /> : null}
        {view ? <>
          <SettingsGroup title={t("projectPlugins.thisProject")} description={t("projectPlugins.thisProjectHint")}>
            {view.plugins.length ? view.plugins.map((plugin) => (
              <SettingsRow key={plugin.id} title={plugin.displayName} description={pluginDescription(plugin)}>
                {plugin.providesType ? <Badge tone="outline">{t("projectPlugins.providesType")}</Badge> : null}
                {plugin.used && (plugin.status === "needs-approval" || plugin.status === "needs-consent") ? (
                  <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, true)}>{t("projectPlugins.allowHere")}</Button>
                ) : null}
                <Switch size="sm" checked={plugin.used !== undefined} label={plugin.displayName}
                  disabled={busy || plugin.providesType || pending !== undefined || (!plugin.used && !plugin.version)}
                  onChange={(on) => void change(plugin, on)} />
              </SettingsRow>
            )) : <SettingsRow title={t("projectPlugins.noneInstalled")} description={t("projectPlugins.noneInstalledHint")} />}
          </SettingsGroup>
          <SettingsGroup title={t("projectPlugins.everyProject")} description={t("projectPlugins.everyProjectHint")}>
            {view.global.map((plugin) => (
              <SettingsRow key={plugin.id} title={plugin.displayName} description={plugin.description}>
                <Badge tone="outline">{t("projectPlugins.global")}</Badge>
                <Switch size="sm" checked label={plugin.displayName} disabled onChange={() => {}} />
              </SettingsRow>
            ))}
          </SettingsGroup>
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
