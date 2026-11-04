import { useEffect, useState } from "react";
import type { ProjectPluginItem, ProjectPluginsView } from "../shared/plugins.js";
import { consentToPlugin, getProjectPlugins, setProjectPlugin } from "./api.js";
import { t } from "./i18n.js";
import { PluginConsentDialog } from "./plugin-consent-dialog.js";
import { PluginIcon } from "./plugin-icons.js";
import { Alert, Badge, Button, Sheet, Skeleton, Switch } from "./ui/index.js";

// A project's plugins: every one that suits it, each on or off here. Those on
// in every project start on; the project's `ohmygame.json` keeps only what
// differs from that.
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
      await setProjectPlugin(projectId, plugin.id, on, on ? keptVersion(plugin) : undefined);
      onChanged?.();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(undefined);
    }
  }

  const on = view?.plugins.filter((plugin) => plugin.used !== undefined).length ?? 0;
  return (
    <Sheet open={open} onClose={onClose} title={t("projectPlugins.title")}
      footer={onOpenPlugins ? <Button onClick={() => { onClose(); onOpenPlugins(); }}>{t("projectPlugins.manageAll")}</Button> : undefined}>
      <div className="project-plugins">
        <p className="project-plugins-intro">{t("projectPlugins.intro")}</p>
        {error ? <Alert tone="danger" title={error} /> : null}
        {busy ? <Alert title={t("projectPlugins.busy")} /> : null}
        {!view && !error ? <Skeleton height={120} /> : null}
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
              <Switch size="sm" checked={plugin.used !== undefined} label={plugin.displayName}
                disabled={busy || plugin.providesType || pending !== undefined || (!plugin.used && !plugin.version)}
                onChange={(next) => void change(plugin, next)} />
            </div>
          )) : <p className="project-plugins-empty"><strong>{t("projectPlugins.noneInstalled")}</strong>{t("projectPlugins.noneInstalledHint")}</p>}
        </section> : null}
      </div>
      {consent ? <PluginConsentDialog name={consent.displayName} capabilities={consent.capabilities}
        onCancel={() => setConsent(undefined)}
        onAllow={() => {
          const plugin = consent;
          setConsent(undefined);
          void change(plugin, true, true);
        }} /> : null}
    </Sheet>
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
