import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { parsePluginJson, PLUGIN_JSON_MAX_BYTES } from "../shared/plugin-json.js";
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { isNewerPluginVersion, isOfficialRepository, OHMYGAME_GITHUB_OWNER, PLUGIN_CONTRIBUTIONS, releaseJoins, type MarketBlock, type MarketPlugin, type PluginContribution, type PluginMarketListing, type PluginSourceUpdate, type PluginUninstallPreview, type StorePlugin, type StorePluginConfiguration } from "../shared/plugins.js";
import { appWidePluginSuits, PLUGIN_PROJECT_KINDS, pluginAppliesTo } from "../shared/project-runtime.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { exportStorePlugin, readPluginScreenshotImage, readPluginUninstall, readPluginUsage, readStorePluginConfiguration, restartStorePlugin, saveStorePluginConfiguration, setStorePluginEveryProject, uninstallStorePlugin } from "./api.js";
import { appliesToLabels, categoryLabel, isOfficialPlugin, PluginKeywords, pluginPublisherName, PluginScreenshots, repositoryLabel } from "./plugin-catalog.js";
import { OfficialMark, PluginMarks } from "./plugin-marks.js";
import { formatBytes } from "./format-bytes.js";
import { t } from "./i18n.js";
import { PluginAddsList, pluginAddRows, PluginHead } from "./plugin-summary.js";
import { CircleHelp, ExternalLink, FileText, FolderOpen, FolderWithFiles, Spinner, Play, RefreshCw, Trash2, Upload, WandSparkles } from "./icons.js";
import { PluginGlyph } from "./plugin-icons.js";
import { SkillSection } from "./plugin-skills.js";
import { PluginCapabilityList } from "./plugin-consent-dialog.js";
import { PluginLogDialog } from "./plugin-log.js";
import { PluginToolAccess } from "./plugin-tool-access.js";
import { PluginMcpServers } from "./plugin-mcp-servers.js";
import { PluginSettingsActions } from "./plugin-settings-actions.js";
import { PluginProviderList, usePluginProviders } from "./models-settings.js";
import { usePluginTry, type TryPlugin } from "./plugin-try.js";
import { Alert, Button, Checkbox, Dialog, Field, Input, Skeleton, Switch, Tabs, useContextMenu, type MenuEntry } from "./ui/index.js";

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

/** A connection can outlive its window only when the person opts in to the desktop preference. */
export function SessionBackgroundPrompt() {
  const bridge = window.ohMyGameDesktop?.backgroundRunning;
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const read = () => { void bridge?.get().then(value => { if (active) setEnabled(value); }, (cause: unknown) => { if (active) setError(message(cause)); }); };
    read();
    window.addEventListener("focus", read);
    return () => { active = false; window.removeEventListener("focus", read); };
  }, [bridge]);
  if (!bridge || enabled || dismissed || (enabled === undefined && !error)) return null;
  async function enable() {
    setBusy(true); setError(undefined);
    try { setEnabled(await bridge!.set(true)); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <section className="plugin-background-prompt" aria-label={t("pluginStore.backgroundTitle")}>
    <h3>{t("pluginStore.backgroundTitle")}</h3>
    <p>{t("pluginStore.backgroundHint")}</p>
    <div className="plugin-background-actions">
      <Button size="sm" disabled={busy} onClick={() => { void enable(); }}>{t("pluginStore.backgroundEnable")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDismissed(true)}>{t("pluginStore.backgroundLater")}</Button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
/**
 * OhMyGame's own: bundled with the app, from its npm scope, or released on
 * WhiteTowerAI's GitHub. A folder in development may use the publisher too,
 * so it isn't.
 */
const isOfficialStorePlugin = (plugin: StorePlugin) =>
  isOfficialPlugin(plugin.id) && (plugin.bundled || plugin.preinstalled || plugin.origin?.type === "npm"
    || (plugin.origin?.type === "github" && isOfficialRepository(plugin.origin.repository)));

export function storePluginSearchText(plugin: StorePlugin): string {
  return [plugin.displayName, plugin.description, plugin.id, ...(plugin.keywords ?? []),
    ...plugin.adds.modelProviders, ...plugin.adds.agents, ...plugin.skills.map(({ name }) => name)].join(" ").toLowerCase();
}

/** The app's project types a plugin's `appliesTo` names. */
function suitedProjectTypes(plugin: StorePlugin): ProjectType[] {
  return plugin.appliesTo ? PROJECT_TYPE_IDS.filter((type) => pluginAppliesTo(plugin.appliesTo, type)) : [];
}

/**
 * Trying an installed plugin: a project it suits, or a new one, where it is
 * turned on and a conversation starts with a prompt that mentions it.
 */
export function useStorePluginTry(plugin: StorePlugin, onTry: TryPlugin | undefined) {
  return usePluginTry({
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

/**
 * A newer version on the market. Only for a plugin released from the same
 * repository (or OhMyGame's own from npm): from anywhere else it couldn't
 * join. One added from a GitHub branch updates from that branch.
 */
export function marketUpdate(plugin: StorePlugin, market: PluginMarketListing | undefined): MarketPlugin | undefined {
  const origin = plugin.origin;
  if (origin?.type !== "npm" && (origin?.type !== "github" || origin.release === undefined)) return undefined;
  const listed = market?.plugins.find((item) => item.id === plugin.id);
  const repository = listed?.repository?.replace(/^https:\/\/github\.com\//, "");
  return listed && repository && releaseJoins(origin, repository) && isNewerPluginVersion(listed.version, plugin.version) ? listed : undefined;
}

/** A newer package where it came from, when the market doesn't offer one: it updates through the same review. */
export function sourceUpdate(plugin: StorePlugin, market: PluginMarketListing | undefined, updates: readonly PluginSourceUpdate[] | undefined): PluginSourceUpdate | undefined {
  if (marketUpdate(plugin, market)) return undefined;
  const update = updates?.find((item) => item.id === plugin.id);
  // Checked before it was updated: until the next check, one already installed isn't offered.
  if (update?.version) return isNewerPluginVersion(update.version, plugin.version) ? update : undefined;
  return update?.commit && plugin.origin?.type === "github" && update.commit === plugin.origin.commit ? undefined : update;
}

/** The installed versions the maintainers blocked. */
export function marketBlocks(versions: StorePlugin[], market: PluginMarketListing | undefined): MarketBlock[] {
  return versions.flatMap(({ id, origin, version }) => {
    if (origin?.type !== "npm" && origin?.type !== "github") return [];
    const block = market?.blocked.find((item) => item.version === version && (item.id ? item.id === id : releaseJoins(origin, item.repository)));
    return block ? [block] : [];
  });
}

/** What a market plugin adds, for the browse page's filter. */
export function marketContributions({ adds }: MarketPlugin): PluginContribution[] {
  const counts: Partial<Record<PluginContribution, number | undefined>> = { projectType: adds.projectTypes, skills: adds.skills, mcp: adds.mcpServers };
  return PLUGIN_CONTRIBUTIONS.filter((kind) => (counts[kind] ?? 0) > 0);
}

export function StorePluginRow({ group, market, updates, selected, showEveryProject = false, updating = false, updateDisabled = false, menu, onUpdate, onOpen }: {
  group: StorePluginGroup;
  /** Its right-click menu. */
  menu?: readonly MenuEntry[];
  market?: PluginMarketListing | undefined;
  updates?: readonly PluginSourceUpdate[] | undefined;
  selected: boolean;
  showEveryProject?: boolean;
  updating?: boolean;
  updateDisabled?: boolean;
  onUpdate: () => void;
  onOpen: () => void;
}): ReactNode {
  const { plugin } = group;
  const nameId = useId();
  const metadataId = useId();
  // The seal already says OhMyGame's, and the person's own need no name.
  const publisher = isOfficialStorePlugin(plugin) || plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`) ? undefined : pluginPublisherName(plugin.id);
  const enabled = storePluginEnabled(plugin);
  const listed = marketUpdate(plugin, market);
  const fromSource = listed ? undefined : sourceUpdate(plugin, market, updates);
  const hasUpdate = Boolean(listed || fromSource);
  const updateTitle = listed
    ? t("pluginStore.updateTo", { version: listed.version })
    : fromSource?.version
      ? t("pluginStore.updateTo", { version: fromSource.version })
      : fromSource?.commit
        ? t("pluginStore.updateToCommit", { commit: fromSource.commit.slice(0, 7) })
        : undefined;
  const context = useContextMenu(menu ?? [], { disabled: !menu });
  // The menu sits beside the row, so a click in it doesn't reach the row's handlers.
  return <><li className="installed-plugin-row" onContextMenu={context.onContextMenu}>
    <button className="installed-plugin-open" type="button" aria-current={selected ? "true" : undefined}
      aria-labelledby={nameId} aria-describedby={metadataId} onClick={onOpen}>
      <StoreTile plugin={plugin} />
      <span className="installed-plugin-label">
        <span id={nameId} className="installed-plugin-title">
          <span className="installed-plugin-identity">
            <span className="installed-plugin-name" title={plugin.displayName}>{plugin.displayName}</span>
            {isOfficialStorePlugin(plugin) ? <OfficialMark /> : null}
          </span>
          <PluginMarks marks={[
            marketBlocks(group.versions, market).length > 0 && "blocked",
            enabled && plugin.quarantined && "stopped",
            Boolean(plugin.developmentError) && "development-error",
            !enabled && "off",
          ]} />
        </span>
        <span id={metadataId} className="installed-plugin-meta">
          <span className="installed-plugin-version" title={plugin.version}>{plugin.version}</span>
          {publisher ? <>{" "}<span className="installed-plugin-publisher" title={publisher}>{publisher}</span></> : null}
          {showEveryProject ? <>{" "}<span className="installed-plugin-scope" title={t("plugins.scopeEveryProject")}>
            <span aria-hidden="true">{t("plugins.scopeEveryProjectShort")}</span>
            <span className="visually-hidden">{t("plugins.scopeEveryProject")}</span>
          </span></> : null}
        </span>
      </span>
    </button>
    {hasUpdate ? <Button size="sm" variant="ghost" disabled={updating || updateDisabled} aria-busy={updating || undefined}
      aria-label={t("pluginStore.updateName", { name: plugin.displayName })} title={updateTitle}
      icon={updating ? <Spinner size="sm" /> : <RefreshCw size="sm" />}
      onClick={onUpdate}>{t("pluginStore.update")}</Button> : null}
  </li>{context.menu}</>;
}

/**
 * The installed list's right-click menu: a plugin's update and what its page
 * manages, with the log and uninstall dialogs they open.
 */
export function useInstalledPluginMenu({ market, updates, everyProject, busy = false, onUpdate, onChanged, onRemoved }: {
  market?: PluginMarketListing | undefined;
  updates?: readonly PluginSourceUpdate[] | undefined;
  everyProject: ReturnType<typeof useEveryProjectSwitch>;
  /** Updating, adding or removing a plugin is under way. */
  busy?: boolean;
  onUpdate: (plugin: StorePlugin) => void;
  /** The store changed; reload it. */
  onChanged: () => Promise<void>;
  /** Its last version was uninstalled. */
  onRemoved: (pluginId: string) => void;
}): { menuFor: (group: StorePluginGroup) => MenuEntry[]; dialogs: ReactNode; error?: string } {
  const [log, setLog] = useState<StorePlugin>();
  const [removing, setRemoving] = useState<{ plugin: StorePlugin; version: StorePlugin; last: boolean }>();
  const [error, setError] = useState<string>();
  const run = (work: () => Promise<unknown> | undefined) => {
    setError(undefined);
    void Promise.resolve(work()).catch((cause: unknown) => setError(message(cause)));
  };
  const menuFor = ({ plugin, versions }: StorePluginGroup): MenuEntry[] => {
    const personal = plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`);
    // One version to remove takes the dialog here; several are chosen on its page.
    const removable = versions.filter((version) => !version.bundled);
    const hasUpdate = Boolean(marketUpdate(plugin, market) || sourceUpdate(plugin, market, updates));
    const desktop = typeof window === "undefined" ? undefined : window.ohMyGameDesktop;
    return [
      ...(hasUpdate ? [{ label: t("pluginStore.update"), icon: <RefreshCw size="sm" />, disabled: busy, onSelect: () => onUpdate(plugin) }] : []),
      ...(storePluginEnabled(plugin) ? [{ label: t("plugins.scopeEveryProject"), icon: <FolderWithFiles size="sm" />, checked: plugin.everyProject, disabled: busy || Boolean(everyProject.busy), onSelect: () => everyProject.toggle(plugin, !plugin.everyProject) }] : []),
      { label: t("pluginLog.viewLog"), icon: <FileText size="sm" />, onSelect: () => setLog(plugin) },
      ...(personal ? [{ label: t("plugins.editWithAi"), icon: <WandSparkles size="sm" />, onSelect: () => run(() => openPluginBuilder(plugin.id)) }] : []),
      ...(desktop && !plugin.bundled ? [{ label: t("plugins.openFolder"), icon: <FolderOpen size="sm" />, onSelect: () => run(() => desktop.browsePluginDirectory(plugin.id)) }] : []),
      ...(removable.length === 1 ? ["separator" as const, { label: t("pluginStore.uninstall"), icon: <Trash2 size="sm" />, danger: true, disabled: busy, onSelect: () => setRemoving({ plugin, version: removable[0]!, last: versions.length === 1 }) }] : []),
    ];
  };
  const dialogs = <>
    {log ? <PluginLogDialog plugin={log.id} displayName={log.displayName} onClose={() => setLog(undefined)} onChanged={() => void onChanged()} /> : null}
    {removing ? <UninstallDialog plugin={removing.plugin} version={removing.version} onCancel={() => setRemoving(undefined)} onUninstall={(keepData) => {
      const { plugin, version, last } = removing;
      setRemoving(undefined);
      run(async () => {
        await uninstallStorePlugin(plugin.id, version.version, { keepData });
        await onChanged();
        if (last) onRemoved(plugin.id);
      });
    }} /> : null}
  </>;
  return { menuFor, dialogs, ...(error ? { error } : {}) };
}

type StoreDetailTab = "about" | "skills" | "settings";

export function StorePluginDetail({ group, market, updates, onUpdate, onUpdateSource, onAddAgain, onChanged, onRemoved, onTry, onSearch, everyProject, safeMode = false, installDisabled = false }: {
  group: StorePluginGroup;
  safeMode?: boolean;
  market?: PluginMarketListing | undefined;
  updates?: readonly PluginSourceUpdate[] | undefined;
  installDisabled?: boolean;
  everyProject: ReturnType<typeof useEveryProjectSwitch>;
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
  const tryIt = useStorePluginTry(plugin, onTry);
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
  const settings = plugin.settings.filter((field) => !providerKeys.has(field.name) && (!plugin.settingsView || plugin.settingsView.fields.includes(field.name)));
  const hasToolAccess = plugin.adds.hooks?.includes("tool.beforeCall");
  const settingsReady = !plugin.adds.modelProviders.length || providers.providers !== undefined || providers.error !== undefined;
  const tabs: { value: StoreDetailTab; label: string; count?: number }[] = [
    { value: "about", label: t("plugins.about") },
    ...(plugin.skills.length ? [{ value: "skills" as const, label: t("plugins.skills"), count: plugin.skills.length }] : []),
    ...(hasToolAccess || plugin.settings.length || plugin.settingsView?.status || plugin.mcpServers?.length || providers.providers?.length ? [{ value: "settings" as const, label: t("common.settings") }] : []),
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

  const [configurationRevision, setConfigurationRevision] = useState(0);
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
  const updateAction = update && onUpdate ? { label: t("pluginStore.updateTo", { version: update.version }), run: () => onUpdate(update) }
    : fromSource && onUpdateSource ? {
      label: fromSource.version ? t("pluginStore.updateTo", { version: fromSource.version }) : t("pluginStore.updateToCommit", { commit: fromSource.commit?.slice(0, 7) ?? "" }),
      run: () => onUpdateSource(fromSource),
    } : undefined;

  return <div className="plugin-page">
    <PluginHead tile={<StoreTile plugin={plugin} large />} title={plugin.displayName} description={plugin.description} badges={
      <PluginMarks official={isOfficialStorePlugin(plugin)} marks={[
        plugin.beta && "beta",
        (plugin.bundled || plugin.preinstalled) && "included",
        plugin.origin?.type === "development" && "development",
      ]} />
    }>
      {/* Its main action at the top, as Get is on a plugin not yet installed: an update when there is one, else trying it. */}
      {updateAction || (canTry && firstExample) ? <div className="plugin-head-actions" ref={tryIt.anchor}>
        {updateAction ? <Button variant="primary" icon={<RefreshCw size="sm" />} disabled={!!busy || installDisabled} onClick={updateAction.run}>{updateAction.label}</Button> : null}
        {canTry && firstExample ? <Button variant={updateAction ? "secondary" : "primary"} icon={<Play size="sm" />} aria-haspopup="dialog" aria-expanded={Boolean(tryIt.prompt)}
          onClick={() => tryIt.open(firstExample)}>{t("plugins.tryNow")}</Button> : null}
        {tryIt.popover}
      </div> : null}
    </PluginHead>
    {error ? <Alert tone="danger" title={error} /> : null}
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
          {plugin.capabilities.includes("sessions") ? <p className="plugin-long">{t("pluginStore.sessionScopeHint")}</p> : plugin.appOnly ? null : <p className="plugin-long">{t("pluginStore.scopeHint")}</p>}
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
          {hasToolAccess ? <PluginToolAccess key={plugin.id} id={plugin.id} active={tab === "settings"} /> : null}
          {providers.providers?.length ? <PluginProviderList providers={providers.providers} /> : null}
          {plugin.settingsView?.status ? <PluginSettingsActions key={`${plugin.id}:${plugin.revision}`} plugin={plugin} active={tab === "settings"} onConfigurationChanged={() => setConfigurationRevision((value) => value + 1)} enabled={!safeMode && enabled && !!plugin.runnable} /> : null}
          {settingsReady && settings.length ? <StorePluginSettings key={plugin.id + plugin.version} plugin={plugin} fields={settings} revision={configurationRevision} /> : null}
          <PluginMcpServers key={`${plugin.id}:${configurationRevision}`} plugin={plugin} enabled={!safeMode && enabled && !!plugin.runnable} />
        </div> : null}
      </div>
      <aside className="plugin-side" aria-label={t("plugins.management")}>
        <h2>{t("plugins.management")}</h2>
        {enabled ? <dl className="plugin-props">
          <dt>{t("plugins.everyProject")}</dt>
          <dd className="plugin-state">
            <Switch size="sm" checked={plugin.everyProject} disabled={!!busy || installDisabled}
              label={t("plugins.everyProjectSwitch", { name: plugin.displayName })} onChange={(on) => everyProject.toggle(plugin, on)} />
            <span>{plugin.everyProject ? t("plugins.scopeEveryProject") : t("plugins.scopeSomeProjects")}</span>
          </dd>
        </dl> : null}
        {!safeMode && enabled && plugin.everyProject && plugin.grants?.allowed.includes("sessions") && plugin.capabilities.includes("sessions") ? <SessionBackgroundPrompt /> : null}
        <dl className="plugin-props">
          <dt>{t("plugins.source")}</dt>
          <dd>{plugin.bundled || plugin.preinstalled ? t("plugins.includedWithOhMyGame") : plugin.id}</dd>
          {plugin.categories?.length ? <><dt>{t("pluginCatalog.categoriesLabel")}</dt><dd>{plugin.categories.map(categoryLabel).join(" · ")}</dd></> : null}
          {plugin.keywords?.length ? <><dt>{t("pluginCatalog.keywords")}</dt><dd><PluginKeywords keywords={plugin.keywords} onSearch={onSearch} /></dd></> : null}
          {plugin.appliesTo?.length ? <><dt>{t("pluginCatalog.worksWith")}</dt><dd>{appliesToLabels(plugin.appliesTo).join(" · ")}</dd></> : null}
          {plugin.origin?.type === "github" ? <><dt>{t("plugins.repository")}</dt><dd><a href={`https://github.com/${plugin.origin.repository}`} target="_blank" rel="noreferrer" title={`github.com/${plugin.origin.repository}`}>{repositoryLabel(plugin.origin.repository)}<ExternalLink size="xs" /></a></dd></> : null}
          {plugin.origin?.type === "development" ? <><dt>{t("pluginStore.developmentFolder")}</dt><dd className="plugins-mono" title={t("pluginStore.developmentHint")}>{plugin.origin.folder}</dd></> : null}
          {plugin.origin?.type === "npm" ? <><dt>{t("pluginStore.npmPackage")}</dt><dd>{plugin.origin.registry === "npmjs" ? <a href={`https://www.npmjs.com/package/${plugin.origin.package}/v/${plugin.origin.version}`} target="_blank" rel="noreferrer">{plugin.origin.package}<ExternalLink size="xs" /></a> : plugin.origin.package}</dd></> : null}
          {plugin.homepage ? <><dt>{t("pluginStore.homepage")}</dt><dd><a href={plugin.homepage} target="_blank" rel="noreferrer">{new URL(plugin.homepage).host}<ExternalLink size="xs" /></a></dd></> : null}
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
        {unused.length ? <div className="plugin-side-actions">
          <Button disabled={!!busy} onClick={removeUnused}>{t("pluginStore.removeUnused", { count: unused.length })}</Button>
        </div> : null}
        {/* Nothing is released on npm any more; OhMyGame's own update from its GitHub releases instead. */}
        {plugin.origin?.type === "npm" && !releaseJoins(plugin.origin, `${OHMYGAME_GITHUB_OWNER}/ohmygame-plugins`) ? <div className="plugin-side-actions">
          <p className="plugins-note">{t("pluginStore.npmNoUpdates")}</p>
        </div> : null}
        {local ? <div className="plugin-side-actions">
          <p className="plugins-note">{t("pluginStore.localUpdateHint")}</p>
          {onAddAgain ? <Button disabled={!!busy || installDisabled} onClick={onAddAgain}>{t("pluginStore.addAgain")}</Button> : null}
        </div> : null}
        <div className="plugin-side-actions">
          <Button disabled={!!busy} onClick={() => setLogOpen(true)}>{t("pluginLog.viewLog")}</Button>
        </div>
        {!plugin.bundled && (personal || window.ohMyGameDesktop) ? <div className="plugin-side-actions">
          {personal ? <Button icon={<WandSparkles size="sm" />} disabled={!!busy} onClick={() => void openPluginBuilder(plugin.id).catch((cause) => setError(message(cause)))}>{t("plugins.editWithAi")}</Button> : null}
          {personal ? <Button icon={<Upload size="sm" />} disabled={!!busy} onClick={() => setExporting(true)}>{t("pluginStore.export")}</Button> : null}
          {window.ohMyGameDesktop ? <Button icon={<FolderOpen size="sm" />} disabled={!!busy} onClick={() => browse(() => window.ohMyGameDesktop?.browsePluginDirectory(plugin.id))}>{t("plugins.openFolder")}</Button> : null}
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
export function StorePluginSettings({ plugin, fields = plugin.settings, revision = 0 }: { plugin: StorePlugin; fields?: StorePlugin["settings"]; revision?: number }): ReactNode {
  const fieldPrefix = useId();
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
  }, [plugin.id, revision]);
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
        const fieldId = `${fieldPrefix}-${field.name}`;
        const describedBy = field.description ? `${fieldId}-hint` : undefined;
        const view = config[field.name];
        const stored = view && view.type !== "secret" ? view.value : null;
        const configured = view?.type === "secret" && view.configured;
        const value = field.name in values ? values[field.name] : stored;
        const set = (next: string | boolean | null) => setValues((current) => ({ ...current, [field.name]: next }));
        // An emptied secret field leaves the saved one alone; Clear removes it.
        const unset = () => setValues(({ [field.name]: _, ...rest }) => rest);
        return <div className="plugin-configuration-field" key={field.name}>
          <label htmlFor={fieldId}>{field.title}{field.required ? " *" : ""}</label>
          {field.type === "boolean" ? (
            <input id={fieldId} aria-describedby={describedBy} type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
          ) : field.type === "select" ? (
            <select id={fieldId} aria-describedby={describedBy} value={typeof value === "string" ? value : ""} onChange={(event) => set(event.target.value || null)}>
              <option value="">{t("pluginControls.chooseOption")}</option>
              {field.options?.map((option) => <option key={option}>{option}</option>)}
            </select>
          ) : field.type === "json" ? (
            <PluginJsonSetting id={fieldId} describedBy={describedBy} label={field.title} value={typeof value === "string" ? value : ""} onChange={set} />
          ) : (
            <input
              id={fieldId}
              aria-describedby={describedBy}
              type={field.type === "secret" ? "password" : "text"}
              autoComplete="off"
              value={typeof value === "string" ? value : ""}
              placeholder={field.type === "secret" && configured ? t("pluginControls.configuredReplace") : field.type === "path" ? t("pluginControls.absolutePath") : undefined}
              // An emptied field goes back to its default.
              onChange={(event) => event.target.value ? set(event.target.value) : field.type === "secret" ? unset() : set(null)}
            />
          )}
          {field.description ? <PluginSettingDescription id={describedBy!} description={field.description} /> : null}
          {field.type === "secret" && configured ? <Button onClick={() => set(null)}>
            {values[field.name] === null ? t("pluginControls.willClear") : t("pluginControls.clearSaved")}
          </Button> : null}
        </div>;
      })}
      <Button variant="primary" type="submit" disabled={busy || !fields.some((field) => field.name in values)}>
        {busy ? t("common.saving") : t("pluginControls.saveConfiguration")}
      </Button>
    </form> : !error ? <p>{t("pluginControls.loadingConfiguration")}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

/** Import content explicitly selected by the person; no filesystem path reaches the plugin. */
function PluginJsonSetting({ id, describedBy, label, value, onChange }: {
  id: string; describedBy?: string; label: string; value: string; onChange: (value: string | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(0);
  const [error, setError] = useState<string>();
  useEffect(() => () => { revision.current++; }, []);
  useEffect(() => {
    let problem = "";
    if (value) {
      try { parsePluginJson(value); }
      catch { problem = t("pluginControls.invalidJson"); }
    }
    textarea.current?.setCustomValidity(problem);
  }, [value]);
  return <div className="plugin-json-setting">
    <textarea ref={textarea} id={id} aria-describedby={describedBy} rows={6} spellCheck={false} value={value} onChange={event => {
      revision.current++; setError(undefined); onChange(event.target.value || null);
    }} />
    <input ref={file} type="file" hidden accept=".json,application/json" aria-label={t("pluginControls.importJsonFor", { field: label })} onChange={event => {
      const selected = event.target.files?.[0];
      event.target.value = "";
      if (!selected) return;
      const current = ++revision.current;
      setError(undefined);
      void (async () => {
        try {
          if (selected.size > PLUGIN_JSON_MAX_BYTES) throw new Error("oversize");
          const text = await selected.text();
          parsePluginJson(text);
          if (revision.current === current) onChange(text);
        } catch {
          if (revision.current === current) setError(t("pluginControls.invalidJson"));
        }
      })();
    }} />
    <Button aria-label={t("pluginControls.importJsonFor", { field: label })} onClick={() => file.current?.click()}>{t("pluginControls.importJson")}</Button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

/** Keep the first paragraph visible; longer plain-text instructions are optional help. */
function PluginSettingDescription({ id, description }: { id: string; description: string }) {
  const [hint, ...paragraphs] = description.split(/\n\s*\n/);
  return <>
    <small id={id}>{hint}</small>
    {paragraphs.length ? <details className="plugin-setting-help">
      <summary><CircleHelp size="sm" aria-hidden="true" />{t("pluginControls.fieldHelp")}</summary>
      <div>{paragraphs.join("\n\n").split(/(https:\/\/[^\s<>"']+)/).map((part, index) =>
        part.startsWith("https://") && URL.canParse(part)
          ? <a key={index} href={part} target="_blank" rel="noreferrer" title={part}>{new URL(part).hostname}<ExternalLink size="xs" aria-hidden="true" /></a>
          : part,
      )}</div>
    </details> : null}
  </>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `owner/repo` that a narrow column wraps after the slash rather than mid-word, as the market dialog shows it. */
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
