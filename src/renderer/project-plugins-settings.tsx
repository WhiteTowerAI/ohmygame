import { useEffect, useState } from "react";
import type { ProjectPluginItem, ProjectPluginsView } from "../shared/plugins.js";
import { consentToPlugin, getProjectPlugins, setProjectPlugin } from "./api.js";
import { t } from "./i18n.js";
import { ArrowLeft, History } from "./icons.js";
import { PluginConsentDialog } from "./plugin-consent-dialog.js";
import { PluginIcon } from "./plugin-icons.js";
import { PluginChanges } from "./project-plugin-contributions.js";
import { Alert, Badge, Button, Select, Skeleton, Switch } from "./ui/index.js";

// A project's plugins: every one that suits it, each on or off here. Those on
// in every project start on; the project's `ohmygame.json` keeps only what
// differs from that. The Plugins tab of the project's settings; its Change
// history lists what the plugins changed, to undo.
export function ProjectPluginsSettings({ projectId, busy, onChanged, onUndone, onOpenPlugins }: {
  projectId: string;
  /** An agent is working in the project; its plugins wait until it is done. */
  busy: boolean;
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
  // The version asked for comes along, so allowing it turns on that version.
  const [consent, setConsent] = useState<{ plugin: ProjectPluginItem; version: string | undefined }>();

  const load = () => getProjectPlugins(projectId).then((next) => { setView(next); setError(undefined); });
  useEffect(() => {
    setView(undefined);
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [projectId]);

  async function change(plugin: ProjectPluginItem, on: boolean, consented = plugin.consented, version = on ? keptVersion(plugin) : undefined): Promise<void> {
    if (on && !consented) {
      setConsent({ plugin, version });
      return;
    }
    setPending(plugin.id);
    setError(undefined);
    try {
      if (on && !plugin.consented) await consentToPlugin(plugin.id, plugin.capabilities);
      // Turning on again at the version in use is how a project allows a plugin it asks for.
      await setProjectPlugin(projectId, plugin.id, on, version);
      onChanged?.();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }

  const on = view?.plugins.filter((plugin) => plugin.used !== undefined).length ?? 0;
  if (history) return <div className="project-plugins">
    <div><Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => setHistory(false)}>{t("common.back")}</Button></div>
    <PluginChanges projectId={projectId} busy={busy} onUndone={onUndone} />
  </div>;
  return (
    <>
      <div className="project-plugins">
        <p className="project-plugins-intro">{t("projectPlugins.intro")}</p>
        {error ? <Alert tone="danger" title={error} /> : null}
        {busy ? <Alert title={t("projectPlugins.busy")} /> : null}
        {!view && !error ? <Skeleton height={120} /> : null}
        <div className="project-plugins-links">
          <Button size="sm" variant="ghost" icon={<History size={14} />} onClick={() => setHistory(true)}>{t("pluginChanges.history")}</Button>
          {onOpenPlugins ? <Button size="sm" variant="ghost" onClick={onOpenPlugins}>{t("projectPlugins.manageAll")}</Button> : null}
        </div>
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
                </strong>
                {pluginDescription(plugin) ? <small>{pluginDescription(plugin)}</small> : null}
              </span>
              {plugin.used && (plugin.status === "needs-approval" || plugin.status === "needs-consent") ? (
                <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, true)}>{t("projectPlugins.allowHere")}</Button>
              ) : null}
              {/* A project stays on its version when a newer one is installed; it moves, or goes back, here. */}
              {plugin.used && plugin.versions.length > 1 && plugin.versions.includes(plugin.used) ? (
                <Select<string> size="sm" label={t("projectPlugins.versionOf", { name: plugin.displayName })} value={plugin.used}
                  disabled={busy || pending !== undefined}
                  options={plugin.versions.map((version) => ({ value: version, label: version === plugin.versions[0] ? t("projectPlugins.newestVersion", { version }) : version }))}
                  onChange={(version) => { if (version !== plugin.used) void change(plugin, true, plugin.consented, version); }} />
              ) : null}
              {/* A version this project uses was uninstalled: it moves to one that is installed. */}
              {plugin.used && plugin.status === "version-not-installed" && plugin.version !== plugin.used ? (
                <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, true, plugin.consented, plugin.version)}>
                  {t("projectPlugins.useVersion", { version: plugin.version })}
                </Button>
              ) : null}
              {/* The plugin itself was uninstalled: it is added again from Plugins, or taken out of the project. */}
              {plugin.used && plugin.status === "not-installed" ? <>
                {onOpenPlugins ? <Button size="sm" variant="ghost" onClick={onOpenPlugins}>{t("projectPlugins.reinstall")}</Button> : null}
                {!plugin.providesType ? <Button size="sm" disabled={busy || pending !== undefined} onClick={() => void change(plugin, false)}>{t("projectPlugins.removeHere")}</Button> : null}
              </> : null}
              {plugin.status !== "not-installed" ? <Switch size="sm" checked={plugin.used !== undefined} label={plugin.displayName}
                disabled={busy || plugin.providesType || pending !== undefined || (!plugin.used && !plugin.version)}
                onChange={(next) => void change(plugin, next)} /> : null}
            </div>
          )) : <p className="project-plugins-empty"><strong>{t("projectPlugins.noneInstalled")}</strong>{t("projectPlugins.noneInstalledHint")}</p>}
        </section> : null}
      </div>
      {consent ? <PluginConsentDialog name={consent.plugin.displayName} capabilities={consent.plugin.capabilities}
        onCancel={() => setConsent(undefined)}
        onAllow={() => {
          const { plugin, version } = consent;
          setConsent(undefined);
          void change(plugin, true, true, version);
        }} /> : null}
    </>
  );
}

/** An older version the project uses stays; otherwise it gets the newest. */
export function keptVersion(plugin: Pick<ProjectPluginItem, "used" | "version">): string | undefined {
  return plugin.used && plugin.used !== plugin.version ? plugin.used : undefined;
}

function pluginDescription(plugin: ProjectPluginItem): string {
  if (!plugin.status || plugin.status === "active") return plugin.description;
  return t(`projectPlugins.status.${plugin.status}`);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
