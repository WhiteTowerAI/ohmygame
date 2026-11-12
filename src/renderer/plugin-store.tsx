import { useEffect, useState, type ReactNode } from "react";
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { isNewerPluginVersion, PLUGIN_CONTRIBUTIONS, PLUGIN_NPM_REGISTRIES, type MarketBlock, type MarketPlugin, type PluginContribution, type PluginMarketListing, type PluginSourceUpdate, type PluginUninstallPreview, type StorePlugin, type StorePluginConfiguration } from "../shared/plugins.js";
import { appWidePluginSuits, PLUGIN_PROJECT_KINDS, pluginAppliesTo } from "../shared/project-runtime.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { exportStorePlugin, readPluginScreenshotImage, readPluginUninstall, readPluginUsage, readStorePluginConfiguration, restartStorePlugin, saveStorePluginConfiguration, setStorePluginEveryProject, uninstallStorePlugin } from "./api.js";
import { appliesToLabels, categoryLabel, isOfficialPlugin, PluginKeywords, PluginScreenshots } from "./plugin-catalog.js";
import { PluginMarks } from "./plugin-marks.js";
import { formatBytes } from "./format-bytes.js";
import { t } from "./i18n.js";
import { PluginAddsList, pluginAddRows, PluginHead } from "./plugin-summary.js";
import { ExternalLink, FolderOpen, Play, RefreshCw, Upload, WandSparkles } from "./icons.js";
import { PluginGlyph } from "./plugin-icons.js";
import { SkillSection } from "./plugin-skills.js";
import { PluginCapabilityList } from "./plugin-consent-dialog.js";
import { PluginLogDialog } from "./plugin-log.js";
import { PluginProviderList, usePluginProviders } from "./models-settings.js";
import { usePluginTry, type TryPlugin } from "./plugin-try.js";
import { projectTypeLabel } from "./project-types.js";
import { Alert, Button, Checkbox, Dialog, Field, Input, Skeleton, Switch, Tabs } from "./ui/index.js";

// Plugins on the Plugins page. They are installed for the app; here each
// one is turned on or off for every project it suits, and a project's
// Plugins sheet can still switch it there. A plugin's page also gets the
// person's consent, takes its settings, stops it everywhere and uninstalls.
// Several versions can be installed side by side, since a project can pin
// its own.

/** An installed plugin: its newest version, and every version installed. */
export interface StorePluginGroup {
  plugin: StorePlugin;
  versions: StorePlugin[];
}

/** Groups the store's rows, which come newest version first, by plugin. */
export function groupStorePlugins(rows: readonly StorePlugin[]): StorePluginGroup[] {
  const groups = new Map<string, StorePluginGroup>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group) group.versions.push(row);
    else groups.set(row.id, { plugin: row, versions: [row] });
  }
  return [...groups.values()];
}

/** Not held off by safe mode, the only thing that stops a plugin everywhere. */
export const storePluginEnabled = (plugin: StorePlugin) => plugin.grants?.enabled !== false;
/**
 * OhMyGame's own: bundled with the app, or from its npm scope. A folder in
 * development may use the publisher too, so it isn't.
 */
const isOfficialStorePlugin = (plugin: StorePlugin) =>
  isOfficialPlugin(plugin.id) && (plugin.bundled || plugin.preinstalled || plugin.origin?.type === "npm");

export function storePluginSearchText(plugin: StorePlugin): string {
  return [plugin.displayName, plugin.description, plugin.id, ...(plugin.keywords ?? []), ...plugin.adds.modelProviders, ...plugin.adds.agents].join(" ").toLowerCase();
}

/** What a plugin adds, for the browse page's filter. */
export function storePluginContributions({ adds }: StorePlugin): PluginContribution[] {
  return PLUGIN_CONTRIBUTIONS.filter((kind) =>
    kind === "projectType" ? adds.projectTypes.length > 0 : kind === "skills" ? adds.skills > 0 : kind === "mcp" ? adds.mcpServers.length > 0 : false);
}

/** The app's project types a plugin's `appliesTo` names. */
function suitedProjectTypes(plugin: StorePlugin): ProjectType[] {
  return plugin.appliesTo ? PROJECT_TYPE_IDS.filter((type) => pluginAppliesTo(plugin.appliesTo, type)) : [];
}

/** The app's project type a new project to try it in gets: the plugin's own if it has one, else the first that suits it. */
function newProjectType(plugin: StorePlugin): ProjectType | undefined {
  const kinds: Record<string, string> = PLUGIN_PROJECT_KINDS;
  return PROJECT_TYPE_IDS.find((type) => kinds[type]?.startsWith(`${plugin.id}:`))
    ?? (plugin.appliesTo ? suitedProjectTypes(plugin)[0] : "web-game");
}

/**
 * A plugin's one switch: on in every project it suits, which allows what it
 * asks for, as its review said when it was added. A project can still turn it
 * on or off for itself.
 */
export function useEveryProjectSwitch(onChanged: () => Promise<void>): {
  toggle: (plugin: StorePlugin, on: boolean) => void;
  busy?: string;
  error?: string;
} {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  async function set(plugin: StorePlugin, on: boolean): Promise<void> {
    setBusy(plugin.id);
    setError(undefined);
    try {
      await setStorePluginEveryProject(plugin.id, on);
      await onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }
  return {
    toggle: (plugin, on) => {
      if (!busy) void set(plugin, on);
    },
    ...(busy ? { busy } : {}),
    ...(error ? { error } : {}),
  };
}

function StoreTile({ plugin, large = false }: { plugin: StorePlugin; large?: boolean }): ReactNode {
  return <span className={`plugin-tile${large ? " plugin-tile-large" : ""}`}><PluginGlyph plugin={plugin} name={plugin.displayName} size={large ? 40 : 24} /></span>;
}

/** A newer version on the market. Only for a plugin added from npm or npmmirror: from anywhere else it couldn't join. */
export function marketUpdate(plugin: StorePlugin, market: PluginMarketListing | undefined): MarketPlugin | undefined {
  if (plugin.origin?.type !== "npm" || !(PLUGIN_NPM_REGISTRIES as readonly string[]).includes(plugin.origin.registry)) return undefined;
  const listed = market?.plugins.find((item) => item.id === plugin.id);
  return listed && isNewerPluginVersion(listed.version, plugin.version) ? listed : undefined;
}

/** A newer package where it came from, when the market doesn't offer one: it updates through the same review. */
export function sourceUpdate(plugin: StorePlugin, market: PluginMarketListing | undefined, updates: readonly PluginSourceUpdate[] | undefined): PluginSourceUpdate | undefined {
  return marketUpdate(plugin, market) ? undefined : updates?.find((update) => update.id === plugin.id);
}

/** The installed versions the maintainers blocked. */
export function marketBlocks(versions: StorePlugin[], market: PluginMarketListing | undefined): MarketBlock[] {
  return versions.flatMap(({ origin }) => {
    if (origin?.type !== "npm") return [];
    const block = market?.blocked.find((item) => item.package === origin.package && item.version === origin.version);
    return block ? [block] : [];
  });
}

/** What a market plugin adds, for the browse page's filter. */
export function marketContributions({ adds }: MarketPlugin): PluginContribution[] {
  const counts: Partial<Record<PluginContribution, number | undefined>> = { projectType: adds.projectTypes, skills: adds.skills, mcp: adds.mcpServers };
  return PLUGIN_CONTRIBUTIONS.filter((kind) => (counts[kind] ?? 0) > 0);
}

function StoreTags({ plugin }: { plugin: StorePlugin }): ReactNode {
  const { adds } = plugin;
  return <>
    {suitedProjectTypes(plugin).map((type) => <span key={type} className="plugins-tag">{projectTypeLabel(type)}</span>)}
    {adds.projectTypes.map((type) => <span key={`type:${type}`} className="plugins-tag">{type}</span>)}
    {adds.skills ? <span className="plugins-tag">{t("plugins.skillCount", { count: adds.skills })}</span> : null}
    {adds.tools ? <span className="plugins-tag">{t("pluginStore.toolCount", { count: adds.tools })}</span> : null}
    {adds.panels.length ? <span className="plugins-tag">{t("pluginStore.panelCount", { count: adds.panels.length })}</span> : null}
    {adds.mcpServers.length ? <span className="plugins-tag">{t("plugins.contributions.mcp")}</span> : null}
  </>;
}

export function StorePluginCard({ group, market, updates, disabled, onToggle, onOpen }: {
  group: StorePluginGroup;
  market?: PluginMarketListing | undefined;
  /** Newer packages where installed plugins came from. */
  updates?: readonly PluginSourceUpdate[] | undefined;
  disabled: boolean;
  /** Turns it on or off in every project. */
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}): ReactNode {
  const { plugin } = group;
  const enabled = storePluginEnabled(plugin);
  return <article className={`plugin-card${enabled ? "" : " is-off"}`}>
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <StoreTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          <PluginMarks official={isOfficialStorePlugin(plugin)} marks={[
            plugin.beta && "beta",
            plugin.origin?.type === "development" && (plugin.developmentError ? "development-error" : "development"),
            !enabled && "off",
            enabled && plugin.quarantined && "stopped",
            marketBlocks(group.versions, market).length ? "blocked" : (marketUpdate(plugin, market) || sourceUpdate(plugin, market, updates)) && "update",
          ]} />
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{plugin.everyProject ? t("plugins.scopeEveryProject") : t("plugins.scopeSomeProjects")}</span>
          <StoreTags plugin={plugin} />
        </span>
      </span>
    </button>
    {/* Its switch for every project; a project's Plugins sheet switches it there. One stopped from its page has none. */}
    {enabled ? <Switch size="sm" checked={plugin.everyProject} disabled={disabled}
      label={t("plugins.everyProjectSwitch", { name: plugin.displayName })} onChange={onToggle} /> : null}
  </article>;
}

/** One of a plugin's Skills, on the page that lists every plugin's; opens the plugin. */
export function StoreSkillCard({ plugin, skill, onOpen }: { plugin: StorePlugin; skill: StorePlugin["skills"][number]; onOpen: () => void }): ReactNode {
  return <article className={`plugin-card${storePluginEnabled(plugin) ? "" : " is-off"}`}>
    <button type="button" className="plugin-card-link" onClick={onOpen}>
      <StoreTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong className="plugins-mono">{skill.name}</strong>
        <small>{skill.description}</small>
        <small>{t("plugins.fromPlugin", { name: plugin.displayName })}</small>
      </span>
    </button>
  </article>;
}

type StoreDetailTab = "about" | "skills" | "settings";

export function StorePluginDetail({ group, market, updates, onUpdate, onUpdateSource, onAddAgain, onChanged, onRemoved, onTry, onSearch }: {
  group: StorePluginGroup;
  market?: PluginMarketListing | undefined;
  updates?: readonly PluginSourceUpdate[] | undefined;
  /** Reviews a newer version from the market. */
  onUpdate?: (listed: MarketPlugin) => void;
  /** Reviews a newer package from where it came from. */
  onUpdateSource?: (update: PluginSourceUpdate) => void;
  /** Opens Add plugin, for one added from this computer, which has nowhere to update from. */
  onAddAgain?: () => void;
  /** The store changed; reload it. */
  onChanged: () => Promise<void>;
  /** Its last version was uninstalled. */
  onRemoved: () => void;
  /** Searches the plugins for one of its keywords. */
  onSearch?: (keyword: string) => void;
  /** Starts a conversation with one of its examples; without this, they only show. */
  onTry?: TryPlugin;
}): ReactNode {
  const { plugin, versions } = group;
  const personal = plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<StorePlugin>();
  const [exporting, setExporting] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [selectedTab, setTab] = useState<StoreDetailTab>("about");
  const enabled = storePluginEnabled(plugin);
  const update = marketUpdate(plugin, market);
  const fromSource = sourceUpdate(plugin, market, updates);
  const blocks = marketBlocks(versions, market);
  // Versions some project uses; an older one none uses can go.
  const [usage, setUsage] = useState<Record<string, string[]>>();
  const versionKey = versions.map((version) => version.version).join(",");
  useEffect(() => {
    if (versions.length < 2) return;
    let active = true;
    void readPluginUsage(plugin.id).then((value) => { if (active) setUsage(value); }, () => {});
    return () => { active = false; };
  }, [plugin.id, versionKey]);
  const unused = usage ? versions.slice(1).filter((version) => !version.bundled && !usage[version.version]?.length) : [];
  const local = !plugin.origin && !plugin.bundled && !plugin.preinstalled && !personal;
  const everyProject = useEveryProjectSwitch(onChanged);
  const tryIt = usePluginTry({
    displayName: plugin.displayName,
    suits: (project) => appWidePluginSuits(plugin.appliesTo, project) || project.pluginType?.plugin === plugin.id,
    emptyLabel: t("plugins.noCompatibleProjects"),
    target: {
      // It is turned on in the project, if it isn't yet, and the prompt mentions it.
      turnOn: plugin.id,
      mention: { name: plugin.id.slice(plugin.id.indexOf("/") + 1), marketplaceId: plugin.id.slice(0, plugin.id.indexOf("/")), displayName: plugin.displayName },
      newProjectType: newProjectType(plugin),
    },
    onTry: onTry ?? (async () => {}),
  });
  // Trying it turns it on in the project, which allows it.
  const canTry = Boolean(onTry) && enabled;
  const firstExample = plugin.examples[0];
  const browse = (action: () => Promise<void> | undefined) => {
    setError(undefined);
    void Promise.resolve(action()).catch((cause: unknown) => setError(message(cause)));
  };
  // Its model providers show as in Settings → Providers, and their keys leave the form.
  const providers = usePluginProviders(plugin.adds.modelProviders.length ? plugin.id : undefined);
  const providerKeys = new Set(providers.providers?.flatMap((provider) => provider.plugin?.keySetting ?? []));
  const settings = plugin.settings.filter((field) => !providerKeys.has(field.name));
  const settingsReady = !plugin.adds.modelProviders.length || providers.providers !== undefined || providers.error !== undefined;
  const tabs: { value: StoreDetailTab; label: string; count?: number }[] = [
    { value: "about", label: t("plugins.about") },
    ...(plugin.skills.length ? [{ value: "skills" as const, label: t("plugins.skills"), count: plugin.skills.length }] : []),
    ...(plugin.settings.length || providers.providers?.length ? [{ value: "settings" as const, label: t("common.settings") }] : []),
  ];
  // Uninstalling the newest version can take away the tab that was open.
  const tab = tabs.some((item) => item.value === selectedTab) ? selectedTab : "about";

  async function act(key: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError(undefined);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }

  const restart = () => void act("restart", () => restartStorePlugin(plugin.id));
  const remove = (version: StorePlugin, keepData: boolean) => {
    setRemoving(undefined);
    void act(`remove:${version.version}`, async () => {
      await uninstallStorePlugin(plugin.id, version.version, { keepData });
      if (versions.length === 1) onRemoved();
    });
  };
  const removeUnused = () => void act("remove-unused", async () => {
    for (const version of unused) await uninstallStorePlugin(plugin.id, version.version);
    setUsage(undefined);
  });
  const adds = pluginAddRows(plugin.adds);

  return <div className="plugin-page">
    <PluginHead tile={<StoreTile plugin={plugin} large />} title={plugin.displayName} description={plugin.description} badges={
      <PluginMarks official={isOfficialStorePlugin(plugin)} marks={[
        plugin.beta && "beta",
        (plugin.bundled || plugin.preinstalled) && "included",
        plugin.origin?.type === "development" && "development",
      ]} />
    }>
      {canTry && firstExample ? <div className="plugin-head-actions" ref={tryIt.anchor}>
        <Button variant="primary" icon={<Play size={14} />} aria-haspopup="dialog" aria-expanded={Boolean(tryIt.prompt)}
          onClick={() => tryIt.open(firstExample)}>{t("plugins.tryNow")}</Button>
        {tryIt.popover}
      </div> : null}
    </PluginHead>
    {error ?? everyProject.error ? <Alert tone="danger" title={error ?? everyProject.error} /> : null}
    {plugin.developmentError ? <Alert tone="danger" title={t("pluginStore.developmentError")}>{plugin.developmentError}</Alert> : null}
    {blocks.map((block) => <Alert key={block.version} tone="danger" title={t("pluginStore.blocked", { version: block.version, reason: block.reason })} />)}
    {enabled && plugin.quarantined ? <Alert tone="danger" title={t("pluginLog.quarantined")} action={<>
      <Button size="sm" variant="ghost" onClick={() => setLogOpen(true)}>{t("pluginLog.viewLog")}</Button>
      <Button size="sm" disabled={!!busy} onClick={restart}>{t("pluginLog.turnOnAgain")}</Button>
    </>}>{t("pluginLog.quarantinedHint")}</Alert> : null}

    <InstalledScreenshots plugin={plugin} />
    <div className="plugin-layout">
      <div className="plugin-main">
        {tabs.length > 1 ? <Tabs<StoreDetailTab> variant="pills" label={plugin.displayName} value={tab} onChange={setTab} tabs={tabs} /> : null}
        {/* Every tab stays mounted, so unsaved settings survive switching tabs. */}
        <div className="plugin-tab" role="tabpanel" aria-label={t("plugins.about")} hidden={tab !== "about"}>
          {plugin.longDescription ? <p className="plugin-long">{plugin.longDescription}</p> : null}
          {plugin.appOnly ? null : <p className="plugin-long">{t("pluginStore.scopeHint")}</p>}
          {plugin.examples.length ? <section className="plugins-section" aria-label={t("plugins.tryIt")}>
            <h2>{t("plugins.tryIt")}</h2>
            <div className="plugin-prompt-list">{plugin.examples.map((example) => <button type="button" key={example} className="plugin-prompt" disabled={!canTry}
              onClick={() => tryIt.open(example)}>{example}</button>)}</div>
            {onTry && !canTry ? <p className="plugins-note" role="status">{t("plugins.enableToTry")}</p> : null}
          </section> : null}
          {adds.length ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
            <h2>{t("pluginStore.adds")}</h2>
            <PluginAddsList rows={adds} />
          </section> : null}
          {plugin.capabilities.length ? <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
            <h2>{t("pluginStore.asksFor")}</h2>
            <PluginCapabilityList capabilities={plugin.capabilities} />
          </section> : null}
        </div>
        {plugin.skills.length ? <div className="plugin-tab" role="tabpanel" aria-label={t("plugins.skills")} hidden={tab !== "skills"}>
          <SkillSection pluginId={plugin.id} items={plugin.skills}
            onBrowse={(skillId) => browse(() => window.ohMyGameDesktop?.revealPluginSkill(plugin.id, skillId))} />
        </div> : null}
        {tabs.some((item) => item.value === "settings") ? <div className="plugin-tab plugin-settings" role="tabpanel" aria-label={t("common.settings")} hidden={tab !== "settings"}>
          {providers.providers?.length ? <PluginProviderList providers={providers.providers} /> : null}
          {settingsReady && settings.length ? <StorePluginSettings key={plugin.id + plugin.version} plugin={plugin} fields={settings} /> : null}
        </div> : null}
      </div>
      <aside className="plugin-side" aria-label={t("plugins.management")}>
        <h2>{t("plugins.management")}</h2>
        <dl className="plugin-props">
          {enabled ? <>
            <dt>{t("plugins.everyProject")}</dt>
            <dd className="plugin-state">
              <Switch size="sm" checked={plugin.everyProject} disabled={!!busy || !!everyProject.busy}
                label={t("plugins.everyProjectSwitch", { name: plugin.displayName })} onChange={(on) => everyProject.toggle(plugin, on)} />
              <span>{plugin.everyProject ? t("plugins.scopeEveryProject") : t("plugins.scopeSomeProjects")}</span>
            </dd>
          </> : null}
          <dt>{t("plugins.source")}</dt>
          <dd>{plugin.bundled || plugin.preinstalled ? t("plugins.includedWithOhMyGame") : plugin.id}</dd>
          {plugin.categories?.length ? <><dt>{t("pluginCatalog.categoriesLabel")}</dt><dd>{plugin.categories.map(categoryLabel).join(" · ")}</dd></> : null}
          {plugin.keywords?.length ? <><dt>{t("pluginCatalog.keywords")}</dt><dd><PluginKeywords keywords={plugin.keywords} onSearch={onSearch} /></dd></> : null}
          {plugin.appliesTo?.length ? <><dt>{t("pluginCatalog.worksWith")}</dt><dd>{appliesToLabels(plugin.appliesTo).join(" · ")}</dd></> : null}
          {plugin.origin?.type === "github" ? <><dt>{t("plugins.repository")}</dt><dd><a href={`https://github.com/${plugin.origin.repository}`} target="_blank" rel="noreferrer">GitHub · {plugin.origin.repository}<ExternalLink size={11} /></a></dd></> : null}
          {plugin.origin?.type === "development" ? <><dt>{t("pluginStore.developmentFolder")}</dt><dd className="plugins-mono" title={t("pluginStore.developmentHint")}>{plugin.origin.folder}</dd></> : null}
          {plugin.origin?.type === "npm" ? <><dt>{t("pluginStore.npmPackage")}</dt><dd>{plugin.origin.registry === "npmjs" ? <a href={`https://www.npmjs.com/package/${plugin.origin.package}/v/${plugin.origin.version}`} target="_blank" rel="noreferrer">{plugin.origin.package}<ExternalLink size={11} /></a> : plugin.origin.package}</dd></> : null}
          {plugin.homepage ? <><dt>{t("pluginStore.homepage")}</dt><dd><a href={plugin.homepage} target="_blank" rel="noreferrer">{new URL(plugin.homepage).host}<ExternalLink size={11} /></a></dd></> : null}
          <dt>{versions.length > 1 ? t("pluginStore.versions") : t("plugins.version")}</dt>
          <dd>
            <ul className="plugin-store-versions">
              {versions.map((version) => <li key={version.version}>
                <span className="plugins-mono">v{version.version}</span>
                {unused.includes(version) ? <span className="plugins-note">{t("pluginStore.unusedVersion")}</span> : null}
                {!version.bundled ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setRemoving(version)}>
                  {t("pluginStore.uninstall")}
                </Button> : null}
              </li>)}
            </ul>
          </dd>
        </dl>
        {update && onUpdate ? <div className="plugin-side-actions">
          <Button icon={<RefreshCw size={14} />} disabled={!!busy} onClick={() => onUpdate(update)}>{t("pluginStore.updateTo", { version: update.version })}</Button>
        </div> : null}
        {fromSource && onUpdateSource ? <div className="plugin-side-actions">
          <Button icon={<RefreshCw size={14} />} disabled={!!busy} onClick={() => onUpdateSource(fromSource)}>
            {fromSource.version ? t("pluginStore.updateTo", { version: fromSource.version }) : t("pluginStore.updateToCommit", { commit: fromSource.commit?.slice(0, 7) ?? "" })}
          </Button>
        </div> : null}
        {unused.length ? <div className="plugin-side-actions">
          <Button disabled={!!busy} onClick={removeUnused}>{t("pluginStore.removeUnused", { count: unused.length })}</Button>
        </div> : null}
        {local ? <div className="plugin-side-actions">
          <p className="plugins-note">{t("pluginStore.localUpdateHint")}</p>
          {onAddAgain ? <Button disabled={!!busy} onClick={onAddAgain}>{t("pluginStore.addAgain")}</Button> : null}
        </div> : null}
        <div className="plugin-side-actions">
          <Button disabled={!!busy} onClick={() => setLogOpen(true)}>{t("pluginLog.viewLog")}</Button>
        </div>
        {!plugin.bundled && (personal || window.ohMyGameDesktop) ? <div className="plugin-side-actions">
          {personal ? <Button icon={<WandSparkles size={14} />} disabled={!!busy} onClick={() => void openPluginBuilder(plugin.id).catch((cause) => setError(message(cause)))}>{t("plugins.editWithAi")}</Button> : null}
          {personal ? <Button icon={<Upload size={14} />} disabled={!!busy} onClick={() => setExporting(true)}>{t("pluginStore.export")}</Button> : null}
          {window.ohMyGameDesktop ? <Button icon={<FolderOpen size={14} />} disabled={!!busy} onClick={() => browse(() => window.ohMyGameDesktop?.browsePluginDirectory(plugin.id))}>{t("plugins.openFolder")}</Button> : null}
        </div> : null}
      </aside>
    </div>
    {exporting ? <PluginExportDialog plugin={plugin} onClose={() => setExporting(false)} /> : null}
    {logOpen ? <PluginLogDialog plugin={plugin.id} displayName={plugin.displayName} onClose={() => setLogOpen(false)} onChanged={() => void onChanged()} /> : null}
    {removing ? <UninstallDialog plugin={plugin} version={removing} onCancel={() => setRemoving(undefined)}
      onUninstall={(keepData) => remove(removing, keepData)} /> : null}
  </div>;
}

/** An installed plugin's screenshots, read from its package through the daemon. */
function InstalledScreenshots({ plugin }: { plugin: StorePlugin }): ReactNode {
  const [urls, setUrls] = useState<(string | undefined)[]>([]);
  const count = plugin.screenshots?.length ?? 0;
  useEffect(() => {
    if (!count) return setUrls([]);
    const controller = new AbortController();
    const made: string[] = [];
    void Promise.all(Array.from({ length: count }, (_, index) =>
      readPluginScreenshotImage(plugin.id, index, controller.signal).then((blob) => {
        const url = URL.createObjectURL(blob);
        made.push(url);
        return url;
      }, () => undefined)))
      .then((next) => { if (!controller.signal.aborted) setUrls(next); });
    return () => {
      controller.abort();
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [plugin.id, plugin.revision, count]);
  const shots = (plugin.screenshots ?? []).flatMap((shot, index) => {
    const src = urls[index];
    return src ? [{ src, ...(shot.caption ? { caption: shot.caption } : {}) }] : [];
  });
  return <PluginScreenshots shots={shots} />;
}

/** Names in their first order, each once with how many times it came. */
function countNames(names: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts];
}

/** Says what uninstalling a version removes, and what it leaves, before it does. */
function UninstallDialog({ plugin, version, onCancel, onUninstall }: {
  plugin: StorePlugin;
  version: StorePlugin;
  onCancel: () => void;
  onUninstall: (keepData: boolean) => void;
}): ReactNode {
  const [preview, setPreview] = useState<PluginUninstallPreview>();
  const [error, setError] = useState<string>();
  const [keepData, setKeepData] = useState(false);
  useEffect(() => {
    let active = true;
    void readPluginUninstall(plugin.id, version.version).then(
      (value) => { if (active) setPreview(value); },
      (cause: unknown) => { if (active) setError(message(cause)); },
    );
    return () => { active = false; };
  }, [plugin.id, version.version]);
  const hasData = Boolean(preview && preview.last && (preview.settings || preview.dataBytes));
  return <Dialog open title={t("pluginStore.uninstallTitle", { name: plugin.displayName, version: version.version })} onClose={onCancel}
    footer={<>
      <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={!preview && !error} onClick={() => onUninstall(hasData && keepData)}>{t("pluginStore.uninstall")}</Button>
    </>}>
    {error ? <Alert tone="danger" title={error} /> : null}
    {!preview && !error ? <Skeleton height={64} /> : null}
    {preview ? <div className="plugin-uninstall">
      <section>
        <h3>{t("pluginStore.uninstallRemoves")}</h3>
        <ul className="plugin-uninstall-removes">
          <li>{t("pluginStore.uninstallFiles", { version: version.version })}</li>
          {preview.last ? <li>{t("pluginStore.uninstallPermissions")}</li> : null}
          {preview.last && preview.settings && !keepData ? <li>{t("pluginStore.uninstallSettings", { count: preview.settings })}</li> : null}
          {preview.last && preview.dataBytes && !keepData ? <li>{t("pluginStore.uninstallData", { size: formatBytes(preview.dataBytes) })}</li> : null}
        </ul>
        {hasData ? <Checkbox checked={keepData} onChange={setKeepData} label={t("pluginStore.uninstallKeepData")}
          description={t("pluginStore.uninstallKeepDataHint")} /> : null}
      </section>
      {preview.projects.length ? <section>
        <h3>{t("pluginStore.uninstallProjectsTitle", { count: preview.projects.length })}</h3>
        <p>{t("pluginStore.uninstallProjects", { count: preview.projects.length })}</p>
        <ul className="plugin-uninstall-box">{countNames(preview.projects).map(([name, count]) => <li key={name}>
          <span title={name}>{name}</span>{count > 1 ? <small>×{count}</small> : null}
        </li>)}</ul>
      </section> : null}
      {preview.projectFiles.length ? <section>
        <h3>{t("pluginStore.uninstallProjectFilesTitle")}</h3>
        <p>{t("pluginStore.uninstallProjectFiles")}</p>
        <ul className="plugin-uninstall-box">{preview.projectFiles.map((file) => <li key={file} className="plugins-mono"><span title={file}>{file}</span></li>)}</ul>
      </section> : null}
    </div> : null}
  </Dialog>;
}

/** The plugin's settings form. Secrets are never read back, only replaced or cleared. */
export function StorePluginSettings({ plugin, fields = plugin.settings }: { plugin: StorePlugin; fields?: StorePlugin["settings"] }): ReactNode {
  const [config, setConfig] = useState<StorePluginConfiguration>();
  const [values, setValues] = useState<Record<string, string | boolean | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!plugin.settings.length) return;
    let active = true;
    void readStorePluginConfiguration(plugin.id).then(
      (value) => { if (active) setConfig(value); },
      (cause: unknown) => { if (active) setError(message(cause)); },
    );
    return () => { active = false; };
  }, [plugin.id]);
  if (!plugin.settings.length) return null;

  async function save(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    // Only what the form shows: a field that left it, as a provider's key, keeps its saved value.
    const submitted = Object.fromEntries(Object.entries(values).filter(([name]) => fields.some((field) => field.name === name)));
    try {
      setConfig(await saveStorePluginConfiguration(plugin.id, submitted));
      // Fields changed again while saving keep their new values.
      setValues((current) => Object.fromEntries(Object.entries(current).filter(([name, value]) => !(name in submitted) || submitted[name] !== value)));
      setNotice(t("common.saved"));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="plugin-components plugin-configuration" aria-label={t("common.settings")}>
    <h2>{t("common.settings")}</h2>
    {config ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {fields.map((field) => {
        const view = config[field.name];
        const stored = view && view.type !== "secret" ? view.value : null;
        const configured = view?.type === "secret" && view.configured;
        const value = field.name in values ? values[field.name] : stored;
        const set = (next: string | boolean | null) => setValues((current) => ({ ...current, [field.name]: next }));
        // An emptied secret field leaves the saved one alone; Clear removes it.
        const unset = () => setValues(({ [field.name]: _, ...rest }) => rest);
        return <label key={field.name}>
          <span>{field.title}{field.required ? " *" : ""}</span>
          {field.type === "boolean" ? (
            <input type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
          ) : field.type === "select" ? (
            <select value={typeof value === "string" ? value : ""} onChange={(event) => set(event.target.value || null)}>
              <option value="">{t("pluginControls.chooseOption")}</option>
              {field.options?.map((option) => <option key={option}>{option}</option>)}
            </select>
          ) : (
            <input
              type={field.type === "secret" ? "password" : "text"}
              autoComplete="off"
              value={typeof value === "string" ? value : ""}
              placeholder={field.type === "secret" && configured ? t("pluginControls.configuredReplace") : field.type === "path" ? t("pluginControls.absolutePath") : undefined}
              // An emptied field goes back to its default.
              onChange={(event) => event.target.value ? set(event.target.value) : field.type === "secret" ? unset() : set(null)}
            />
          )}
          {field.description ? <small>{field.description}</small> : null}
          {field.type === "secret" && configured ? <button className="plugin-detail-secondary" type="button" onClick={() => set(null)}>
            {values[field.name] === null ? t("pluginControls.willClear") : t("pluginControls.clearSaved")}
          </button> : null}
        </label>;
      })}
      <button className="plugin-detail-primary" type="submit" disabled={busy || !fields.some((field) => field.name in values)}>
        {busy ? t("common.saving") : t("pluginControls.saveConfiguration")}
      </button>
    </form> : !error ? <p>{t("pluginControls.loadingConfiguration")}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Copies a plugin made in the Plugin Builder out as a package its author can publish. */
export function PluginExportDialog({ plugin, onClose }: { plugin: StorePlugin; onClose: () => void }): ReactNode {
  const [publisher, setPublisher] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [exported, setExported] = useState<string>();
  const desktop = window.ohMyGameDesktop;
  const name = plugin.id.slice(plugin.id.indexOf("/") + 1);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setExported((await exportStorePlugin(plugin.id, publisher.trim(), folder.trim())).folder);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open title={t("pluginStore.exportTitle", { name: plugin.displayName })} description={exported ? undefined : t("pluginStore.exportDescription")} onClose={() => { if (!busy) onClose(); }}
    footer={exported ? <Button variant="primary" onClick={onClose}>{t("common.done")}</Button> : <>
      <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" type="submit" form="plugin-export-form" disabled={busy || !publisher.trim() || !folder.trim()}>{t("pluginStore.exportAction")}</Button>
    </>}>
    {exported ? <p>{t("pluginStore.exported", { folder: exported })}</p> : <form id="plugin-export-form" className="plugins-install-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label={t("pluginStore.exportPublisher")} hint={t("pluginStore.exportPublisherHint", { id: `${publisher.trim() || "publisher"}/${name}` })}>{(props) => <Input {...props} autoFocus required disabled={busy} value={publisher} placeholder="publisher" spellCheck={false} onChange={(event) => setPublisher(event.target.value)} />}</Field>
      <Field label={t("pluginStore.exportFolder")} hint={t("pluginStore.exportFolderHint", { name })}>{(props) => <Input {...props} required disabled={busy} value={folder} placeholder="/Users/me/plugins" spellCheck={false} onChange={(event) => setFolder(event.target.value)} />}</Field>
      {desktop ? <Button disabled={busy} onClick={() => void desktop.selectPluginDirectory().then((selected) => { if (selected) setFolder(selected); })}>{t("pluginAdd.chooseFolder")}</Button> : null}
      {error ? <Alert tone="danger" title={error} /> : null}
    </form>}
  </Dialog>;
}
