import { useEffect, useState, type ReactNode } from "react";
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { isNewerPluginVersion, PLUGIN_CONTRIBUTIONS, type MarketBlock, type MarketPlugin, type PluginContribution, type PluginMarketListing, type StorePlugin, type StorePluginConfiguration } from "../shared/plugins.js";
import { appWidePluginSuits, PLUGIN_PROJECT_KINDS, pluginAppliesTo, projectFileTypeFor } from "../shared/project-runtime.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { consentToPlugin, readStorePluginConfiguration, saveStorePluginConfiguration, setStorePluginEnabled, uninstallStorePlugin } from "./api.js";
import { language, t } from "./i18n.js";
import { BadgeCheck, ExternalLink, FolderOpen, Package, Play, RefreshCw, WandSparkles } from "./icons.js";
import { PluginGlyph } from "./plugin-icons.js";
import { SkillSection } from "./plugin-skills.js";
import { usePluginTry, type TryPlugin } from "./plugin-try.js";
import { projectTypeLabel } from "./project-types.js";
import { Alert, Badge, Button, Dialog, Switch, Tabs } from "./ui/index.js";

// Plugins on the Plugins page. They are installed for the app and
// turned on in each project, from its Plugins sheet or when it is created;
// here they switch off everywhere, get the person's consent, take their
// settings and uninstall. Several versions can be installed side by side,
// since each project pins its own.

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

export const storePluginEnabled = (plugin: StorePlugin) => plugin.grants?.enabled !== false;

/** What it asks for that the person hasn't allowed yet. */
export function storePluginMissing(plugin: StorePlugin): string[] {
  const allowed = new Set(plugin.grants?.allowed ?? []);
  return plugin.capabilities.filter((capability) => !allowed.has(capability));
}

export function storePluginSearchText(plugin: StorePlugin): string {
  return `${plugin.displayName} ${plugin.description} ${plugin.id}`.toLowerCase();
}

/** What a plugin adds, for the browse page's filter. */
export function storePluginContributions({ adds }: StorePlugin): PluginContribution[] {
  return PLUGIN_CONTRIBUTIONS.filter((kind) =>
    kind === "projectType" ? adds.projectTypes.length > 0 : kind === "skills" ? adds.skills > 0 : kind === "mcp" ? adds.mcpServers.length > 0 : false);
}

/** The app's project types a plugin that applies by itself names. */
function appWideProjectTypes(plugin: StorePlugin): ProjectType[] {
  return plugin.appliesTo ? PROJECT_TYPE_IDS.filter((type) => pluginAppliesTo(plugin.appliesTo, type)) : [];
}

/** The app's project type a new project to try it in gets: the plugin's own if it has one, else the first that suits it. */
function newProjectType(plugin: StorePlugin): ProjectType | undefined {
  if (plugin.appWide) return plugin.appliesTo ? appWideProjectTypes(plugin)[0] : "web-game";
  const kinds: Record<string, string> = PLUGIN_PROJECT_KINDS;
  return PROJECT_TYPE_IDS.find((type) => kinds[type]?.startsWith(`${plugin.id}:`))
    ?? PROJECT_TYPE_IDS.find((type) => pluginAppliesTo(plugin.appliesTo, projectFileTypeFor(type)));
}

function StoreTile({ plugin, large = false }: { plugin: StorePlugin; large?: boolean }): ReactNode {
  return <span className={`plugin-tile${large ? " plugin-tile-large" : ""}`}><PluginGlyph plugin={plugin} size={large ? 40 : 24} /></span>;
}

/** A newer version on the market. Only for a plugin added from npm: from anywhere else it couldn't join. */
export function marketUpdate(plugin: StorePlugin, market: PluginMarketListing | undefined): MarketPlugin | undefined {
  if (plugin.origin?.type !== "npm") return undefined;
  const listed = market?.plugins.find((item) => item.id === plugin.id);
  return listed && isNewerPluginVersion(listed.version, plugin.version) ? listed : undefined;
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

/** A plugin on the market, not installed yet; opening it reviews the package. */
export function MarketPluginCard({ plugin, onOpen }: { plugin: MarketPlugin; onOpen: () => void }): ReactNode {
  const compact = new Intl.NumberFormat(language, { notation: "compact" });
  return <article className="plugin-card">
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <span className="plugin-tile"><Package size={24} aria-hidden="true" /></span>
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          {plugin.sourceVerified ? <BadgeCheck size={14} className="plugins-verified" aria-label={t("plugins.sourceVerified")} /> : null}
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{plugin.package}</span>
          {plugin.adds.skills ? <span className="plugins-tag">{t("plugins.skillCount", { count: plugin.adds.skills })}</span> : null}
          {plugin.adds.mcpServers ? <span className="plugins-tag">{t("plugins.contributions.mcp")}</span> : null}
          {plugin.stars !== undefined ? <span className="plugins-tag">★ {compact.format(plugin.stars)}</span> : null}
          {plugin.weeklyDownloads ? <span className="plugins-tag">{t("plugins.weeklyDownloads", { count: compact.format(plugin.weeklyDownloads) })}</span> : null}
        </span>
      </span>
    </button>
    <span className="plugins-installed-label">{t("plugins.install")}</span>
  </article>;
}

function StoreTags({ plugin }: { plugin: StorePlugin }): ReactNode {
  const { adds } = plugin;
  return <>
    {plugin.appWide ? appWideProjectTypes(plugin).map((type) => <span key={type} className="plugins-tag">{projectTypeLabel(type)}</span>) : null}
    {adds.projectTypes.map((type) => <span key={`type:${type}`} className="plugins-tag">{type}</span>)}
    {adds.skills ? <span className="plugins-tag">{t("plugins.skillCount", { count: adds.skills })}</span> : null}
    {adds.tools ? <span className="plugins-tag">{t("pluginStore.toolCount", { count: adds.tools })}</span> : null}
    {adds.panels.length ? <span className="plugins-tag">{t("pluginStore.panelCount", { count: adds.panels.length })}</span> : null}
    {adds.mcpServers.length ? <span className="plugins-tag">{t("plugins.contributions.mcp")}</span> : null}
  </>;
}

export function StorePluginCard({ group, market, disabled, onToggle, onOpen }: {
  group: StorePluginGroup;
  market?: PluginMarketListing | undefined;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
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
          {plugin.beta ? <Badge tone="outline">{t("plugins.beta")}</Badge> : null}
          {enabled && storePluginMissing(plugin).length ? <Badge tone="outline">{t("pluginStore.needsConsent")}</Badge> : null}
          {marketBlocks(group.versions, market).length ? <Badge tone="danger">{t("pluginStore.blockedBadge")}</Badge> : marketUpdate(plugin, market) ? <Badge tone="outline">{t("pluginStore.updateAvailable")}</Badge> : null}
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{plugin.appWide ? (plugin.appliesTo ? t("plugins.scopeTyped") : t("plugins.scopeAll")) : t("pluginStore.perProject")}</span>
          <StoreTags plugin={plugin} />
        </span>
      </span>
    </button>
    <Switch size="sm" checked={enabled} disabled={disabled}
      label={`${enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`} onChange={onToggle} />
  </article>;
}

/** A listing on the browse page: where it comes from and what it adds. */
export function StorePluginBrowseCard({ group, onOpen }: { group: StorePluginGroup; onOpen: () => void }): ReactNode {
  const { plugin } = group;
  return <article className="plugin-card">
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <StoreTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          {plugin.bundled ? <BadgeCheck size={14} className="plugins-verified" aria-label={t("plugins.official")} /> : null}
          {plugin.beta ? <Badge tone="outline">{t("plugins.beta")}</Badge> : null}
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{plugin.bundled ? t("plugins.officialSource") : plugin.id}</span>
          <StoreTags plugin={plugin} />
        </span>
      </span>
    </button>
    <span className="plugins-installed-label">{t("plugins.installed")}</span>
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

export function StorePluginDetail({ group, market, onUpdate, onChanged, onRemoved, onTry }: {
  group: StorePluginGroup;
  market?: PluginMarketListing | undefined;
  /** Reviews a newer version from the market. */
  onUpdate?: (listed: MarketPlugin) => void;
  /** The store changed; reload it. */
  onChanged: () => Promise<void>;
  /** Its last version was uninstalled. */
  onRemoved: () => void;
  /** Starts a conversation with one of its examples; without this, they only show. */
  onTry?: TryPlugin;
}): ReactNode {
  const { plugin, versions } = group;
  const personal = plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<StorePlugin>();
  const [selectedTab, setTab] = useState<StoreDetailTab>("about");
  const enabled = storePluginEnabled(plugin);
  const missing = storePluginMissing(plugin);
  const update = marketUpdate(plugin, market);
  const blocks = marketBlocks(versions, market);
  const tryIt = usePluginTry({
    displayName: plugin.displayName,
    suits: (project) => plugin.appWide
      ? appWidePluginSuits(plugin.appliesTo, project)
      : pluginAppliesTo(plugin.appliesTo, project.pluginType?.id ?? projectFileTypeFor(project.type)),
    emptyLabel: t("plugins.noCompatibleProjects"),
    target: {
      // One that applies by itself is already on there; the prompt mentions it.
      ...(plugin.appWide ? { mention: { name: plugin.id.slice(plugin.id.indexOf("/") + 1), marketplaceId: plugin.id.slice(0, plugin.id.indexOf("/")), displayName: plugin.displayName } } : { turnOn: plugin.id }),
      newProjectType: newProjectType(plugin),
    },
    onTry: onTry ?? (async () => {}),
  });
  const canTry = Boolean(onTry) && enabled && !missing.length;
  const firstExample = plugin.examples[0];
  const browse = (action: () => Promise<void> | undefined) => {
    setError(undefined);
    void Promise.resolve(action()).catch((cause: unknown) => setError(message(cause)));
  };
  const tabs: { value: StoreDetailTab; label: string; count?: number }[] = [
    { value: "about", label: t("plugins.about") },
    ...(plugin.skills.length ? [{ value: "skills" as const, label: t("plugins.skills"), count: plugin.skills.length }] : []),
    ...(plugin.settings.length ? [{ value: "settings" as const, label: t("common.settings") }] : []),
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

  const toggle = (on: boolean) => void act("enabled", () => setStorePluginEnabled(plugin.id, on));
  const allow = () => void act("consent", () => consentToPlugin(plugin.id, plugin.capabilities));
  const remove = (version: StorePlugin) => {
    setRemoving(undefined);
    void act(`remove:${version.version}`, async () => {
      await uninstallStorePlugin(plugin.id, version.version);
      if (versions.length === 1) onRemoved();
    });
  };
  const adds = [
    ...plugin.adds.projectTypes.map((title) => ({ kind: t("pluginStore.addsType"), title })),
    ...plugin.adds.panels.map((title) => ({ kind: t("pluginStore.addsPanel"), title })),
    ...plugin.adds.commands.map((title) => ({ kind: t("pluginStore.addsCommand"), title })),
    ...plugin.adds.mcpServers.map((title) => ({ kind: t("pluginStore.addsMcpServer"), title })),
    ...plugin.adds.skills ? [{ kind: t("plugins.skills"), title: t("plugins.skillCount", { count: plugin.adds.skills }) }] : [],
    ...plugin.adds.tools ? [{ kind: t("pluginStore.tools"), title: t("pluginStore.toolCount", { count: plugin.adds.tools }) }] : [],
  ];

  return <div className="plugin-page">
    <header className="plugin-head">
      <StoreTile plugin={plugin} large />
      <div className="plugin-head-copy">
        <h1>
          <span>{plugin.displayName}</span>
          {plugin.beta ? <Badge tone="outline">{t("plugins.beta")}</Badge> : null}
          {plugin.bundled || plugin.preinstalled ? <Badge tone="outline">{t("plugins.included")}</Badge> : null}
        </h1>
        <p>{plugin.description}</p>
      </div>
      {canTry && firstExample ? <div className="plugin-head-actions" ref={tryIt.anchor}>
        <Button variant="primary" icon={<Play size={14} />} aria-haspopup="dialog" aria-expanded={Boolean(tryIt.prompt)}
          onClick={() => tryIt.open(firstExample)}>{t("plugins.tryNow")}</Button>
        {tryIt.popover}
      </div> : null}
    </header>
    {error ? <Alert tone="danger" title={error} /> : null}
    {blocks.map((block) => <Alert key={block.version} tone="danger" title={t("pluginStore.blocked", { version: block.version, reason: block.reason })} />)}
    {enabled && missing.length ? <Alert title={t("pluginStore.consentTitle")} action={
      <Button size="sm" variant="primary" disabled={!!busy} onClick={allow}>{t("pluginStore.allow")}</Button>
    }>
      {t("pluginStore.consentHint")} {missing.map((capability, index) => <span key={capability}>{index ? ", " : ""}<code>{capability}</code></span>)}
    </Alert> : null}

    <div className="plugin-layout">
      <div className="plugin-main">
        {tabs.length > 1 ? <Tabs<StoreDetailTab> variant="pills" label={plugin.displayName} value={tab} onChange={setTab} tabs={tabs} /> : null}
        {/* Every tab stays mounted, so unsaved settings survive switching tabs. */}
        <div className="plugin-tab" role="tabpanel" aria-label={t("plugins.about")} hidden={tab !== "about"}>
          {plugin.longDescription ? <p className="plugin-long">{plugin.longDescription}</p> : null}
          {plugin.appWide ? null : <p className="plugin-long">{t("pluginStore.perProjectHint")}</p>}
          {plugin.examples.length ? <section className="plugins-section" aria-label={t("plugins.tryIt")}>
            <h2>{t("plugins.tryIt")}</h2>
            <div className="plugin-prompt-list">{plugin.examples.map((example) => <button type="button" key={example} className="plugin-prompt" disabled={!canTry}
              onClick={() => tryIt.open(example)}>{example}</button>)}</div>
            {onTry && !canTry ? <p className="plugins-note" role="status">{enabled ? t("pluginStore.allowToTry") : t("plugins.enableToTry")}</p> : null}
          </section> : null}
          {adds.length ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
            <h2>{t("pluginStore.adds")}</h2>
            <ul className="plugin-store-adds">
              {adds.map((item) => <li key={`${item.kind}:${item.title}`}><span>{item.kind}</span>{item.title}</li>)}
            </ul>
          </section> : null}
          {plugin.capabilities.length ? <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
            <h2>{t("pluginStore.asksFor")}</h2>
            <ul className="plugin-store-capabilities">{plugin.capabilities.map((capability) => <li key={capability} className="plugins-tag plugins-mono">{capability}</li>)}</ul>
          </section> : null}
        </div>
        {plugin.skills.length ? <div className="plugin-tab" role="tabpanel" aria-label={t("plugins.skills")} hidden={tab !== "skills"}>
          <SkillSection pluginId={plugin.id} items={plugin.skills}
            onBrowse={(skillId) => browse(() => window.ohMyGameDesktop?.revealPluginSkill(plugin.id, skillId))} />
        </div> : null}
        {plugin.settings.length ? <div className="plugin-tab plugin-settings" role="tabpanel" aria-label={t("common.settings")} hidden={tab !== "settings"}>
          <StorePluginSettings key={plugin.id + plugin.version} plugin={plugin} />
        </div> : null}
      </div>
      <aside className="plugin-side" aria-label={t("plugins.management")}>
        <h2>{t("plugins.management")}</h2>
        <dl className="plugin-props">
          <dt>{t("plugins.status")}</dt>
          <dd className="plugin-state">
            <Switch size="sm" checked={enabled} disabled={!!busy}
              label={`${enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`} onChange={toggle} />
            {enabled ? t("common.enabled") : t("common.disabled")}
          </dd>
          <dt>{t("plugins.source")}</dt>
          <dd>{plugin.bundled || plugin.preinstalled ? t("plugins.includedWithOhMyGame") : plugin.id}</dd>
          {plugin.origin?.type === "github" ? <><dt>{t("plugins.repository")}</dt><dd><a href={`https://github.com/${plugin.origin.repository}`} target="_blank" rel="noreferrer">GitHub · {plugin.origin.repository}<ExternalLink size={11} /></a></dd></> : null}
          {plugin.origin?.type === "npm" ? <><dt>{t("pluginStore.npmPackage")}</dt><dd>{plugin.origin.registry === "npmjs" ? <a href={`https://www.npmjs.com/package/${plugin.origin.package}/v/${plugin.origin.version}`} target="_blank" rel="noreferrer">{plugin.origin.package}<ExternalLink size={11} /></a> : plugin.origin.package}</dd></> : null}
          {plugin.homepage ? <><dt>{t("pluginStore.homepage")}</dt><dd><a href={plugin.homepage} target="_blank" rel="noreferrer">{new URL(plugin.homepage).host}<ExternalLink size={11} /></a></dd></> : null}
          <dt>{versions.length > 1 ? t("pluginStore.versions") : t("plugins.version")}</dt>
          <dd>
            <ul className="plugin-store-versions">
              {versions.map((version) => <li key={version.version}>
                <span className="plugins-mono">v{version.version}</span>
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
        {!plugin.bundled && (personal || window.ohMyGameDesktop) ? <div className="plugin-side-actions">
          {personal ? <Button icon={<WandSparkles size={14} />} disabled={!!busy} onClick={() => void openPluginBuilder(plugin.id, "edit").catch((cause) => setError(message(cause)))}>{t("plugins.editWithAi")}</Button> : null}
          {window.ohMyGameDesktop ? <Button icon={<FolderOpen size={14} />} disabled={!!busy} onClick={() => browse(() => window.ohMyGameDesktop?.browsePluginDirectory(plugin.id))}>{t("plugins.openFolder")}</Button> : null}
        </div> : null}
      </aside>
    </div>
    {removing ? <Dialog open title={t("pluginStore.uninstallTitle", { name: plugin.displayName, version: removing.version })} onClose={() => setRemoving(undefined)}
      footer={<>
        <Button variant="ghost" onClick={() => setRemoving(undefined)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => remove(removing)}>{t("pluginStore.uninstall")}</Button>
      </>}>
      <p>{plugin.appWide ? t("pluginStore.uninstallAppWideHint") : t("pluginStore.uninstallHint")}</p>
    </Dialog> : null}
  </div>;
}

/** The plugin's settings form. Secrets are never read back, only replaced or cleared. */
export function StorePluginSettings({ plugin }: { plugin: StorePlugin }): ReactNode {
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
    const submitted = values;
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
      {plugin.settings.map((field) => {
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
      <button className="plugin-detail-primary" type="submit" disabled={busy || !Object.keys(values).length}>
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
