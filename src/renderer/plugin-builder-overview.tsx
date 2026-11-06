import { useState } from "react";
import type { PluginDraft } from "../shared/plugin-setup.js";
import type { StorePlugin } from "../shared/plugins.js";
import { Check, CircleX, LoaderCircle, Plug } from "./icons.js";
import { t } from "./i18n.js";
import { PluginGlyph } from "./plugin-icons.js";
import { StorePluginSettings, storePluginEnabled, type useEveryProjectSwitch } from "./plugin-store.js";
import { PluginAddsList, pluginAddRows, PluginHead, type PluginAddRow } from "./plugin-summary.js";
import { Badge, Button, Disclosure, Switch } from "./ui/index.js";

type DraftCheck = "failed" | "untested" | "passed";

function currentResult(draft: PluginDraft, server: string) {
  const check = draft.checks?.[server];
  return check?.revision === draft.revision ? check?.result : undefined;
}

/** Where the draft stands: a service only counts once it connected in this revision. */
export function draftCheck(draft: PluginDraft): DraftCheck {
  if (draft.errors.length) return "failed";
  const results = (draft.plugin?.mcpServers ?? []).map(server => currentResult(draft, server.id));
  if (results.some(result => result && result.status !== "connected")) return "failed";
  return results.every(Boolean) ? "passed" : "untested";
}

export function draftCheckLabel(check: DraftCheck): string {
  return t(check === "failed" ? "pluginBuilder.needsChanges" : check === "untested" ? "pluginBuilder.servicesNotTested" : "pluginBuilder.checksPassed");
}

/**
 * The draft as its plugin page will read: what it adds and asks for, its
 * settings once installed, and the checks, which open only when one needs you.
 */
export function PluginOverview({ draft, setupId, stored, disabled, operation, everyProject, onEditIcon, onOpenFile, onTest }: {
  draft: PluginDraft;
  setupId: string;
  /** The installed version, when there is one. */
  stored?: StorePlugin;
  disabled: boolean;
  operation?: string;
  everyProject: ReturnType<typeof useEveryProjectSwitch>;
  onEditIcon?: () => void;
  onOpenFile: (file: string) => void;
  onTest: (server: string) => void;
}) {
  const plugin = draft.plugin;
  const checks = <DraftChecks draft={draft} disabled={disabled} operation={operation} onTest={onTest} />;
  if (!plugin) return <div className="plugins-page plugin-builder-overview">{checks}</div>;
  const rows: PluginAddRow[] = [
    ...plugin.skills.map(skill => ({ id: `skill:${skill.id}`, kind: t("plugins.skills"), title: <button className="plugin-builder-link" type="button" title={skill.description} onClick={() => onOpenFile(skill.id)}>{skill.name}</button> })),
    ...pluginAddRows({ ...plugin.adds, skills: 0 }),
  ];
  const tile = <span className="plugin-tile plugin-tile-large"><PluginGlyph plugin={plugin} size={40} setupId={setupId} /></span>;
  return <div className="plugins-page plugin-builder-overview">
    <PluginHead title={plugin.displayName} description={plugin.description} badges={plugin.version ? <Badge tone="outline">v{plugin.version}</Badge> : null}
      tile={onEditIcon ? <button className="plugin-builder-icon-button" type="button" aria-label={t("pluginIconPicker.change")} title={t("pluginIconPicker.change")} disabled={disabled} onClick={onEditIcon}>{tile}</button> : tile} />
    <p className="plugin-long">{t(plugin.appWide ? "pluginBuilder.scopeAppWide" : "pluginBuilder.scopePerProject")}</p>
    {rows.length ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
      <h2>{t("pluginStore.adds")}</h2>
      <PluginAddsList rows={rows} />
    </section> : null}
    {plugin.asks.length ? <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
      <h2>{t("pluginStore.asksFor")}</h2>
      <ul className="plugin-store-capabilities">{plugin.asks.map(ask => <li key={ask} className="plugins-tag plugins-mono">{ask}</li>)}</ul>
    </section> : null}
    {stored?.settings.length ? <fieldset className="plugin-builder-config" disabled={disabled}><StorePluginSettings key={stored.revision} plugin={stored} /></fieldset>
      : plugin.settings ? <section className="plugins-section" aria-label={t("common.settings")}>
        <h2>{t("common.settings")}</h2>
        <p className="plugins-note">{t("pluginBuilder.settingsAfterInstall")}</p>
      </section> : null}
    {stored && storePluginEnabled(stored) ? <section className="plugins-section" aria-label={t("plugins.management")}>
      <h2>{t("plugins.management")}</h2>
      <dl className="plugin-props">
        <dt>{t("plugins.everyProject")}</dt>
        <dd className="plugin-state">
          <Switch size="sm" checked={stored.everyProject} disabled={disabled || Boolean(everyProject.busy)}
            label={t("plugins.everyProjectSwitch", { name: stored.displayName })} onChange={on => everyProject.toggle(stored, on)} />
          <span>{stored.everyProject ? t("plugins.scopeEveryProject") : t("plugins.scopeSomeProjects")}</span>
        </dd>
      </dl>
    </section> : null}
    {checks}
  </div>;
}

function DraftChecks({ draft, disabled, operation, onTest }: {
  draft: PluginDraft; disabled: boolean; operation?: string; onTest: (server: string) => void;
}) {
  const check = draftCheck(draft);
  // Until you choose, it follows the result: a new problem opens it.
  const [open, setOpen] = useState<boolean>();
  return <Disclosure variant="section" className="plugin-builder-checks" open={open ?? check !== "passed"} onOpenChange={setOpen}
    summary={<>{t("pluginBuilder.checks")}<small className={`plugin-builder-check-result is-${check}`}>{draftCheckLabel(check)}</small></>}>
    <div className={`plugin-builder-check ${draft.errors.length ? "has-error" : "is-passed"}`}>
      {draft.errors.length ? <CircleX size={16} /> : <Check size={16} />}<strong>{t("pluginBuilder.packageStructure")}</strong>
      <small>{draft.errors.length ? t("pluginBuilder.needsChanges") : t("pluginBuilder.passed")}</small>
    </div>
    {draft.errors.map(error => <p className="plugin-builder-error" role="alert" key={error}>{error}</p>)}
    {draft.plugin?.mcpServers.map(server => {
      const result = currentResult(draft, server.id);
      return <div key={server.id}>
        <div className="plugin-builder-check">
          <Plug size={16} /><strong>{server.title}</strong>
          <small>{result?.status === "connected" ? t("pluginBuilder.connectedTools", { count: result.toolCount }) : result?.status === "needs-auth" ? t("pluginControls.authorizationRequired") : result?.status === "failed" ? t("providers.status.failed") : draft.checks?.[server.id] ? t("pluginBuilder.outdated") : t("pluginBuilder.notTested")}</small>
          <Button size="sm" aria-label={t("pluginBuilder.testServer", { name: server.title })} disabled={disabled || Boolean(draft.errors.length)}
            icon={operation === `test:${server.id}` ? <LoaderCircle className="spin" size={12} /> : undefined} onClick={() => onTest(server.id)}>{t("pluginControls.test")}</Button>
        </div>
        {result?.message && result.status !== "connected" ? <Disclosure summary={t("common.details")}><pre>{result.message}</pre></Disclosure> : null}
      </div>;
    })}
  </Disclosure>;
}
