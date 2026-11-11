import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { PluginBuilderSessions } from "./plugin-builder.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ChevronLeft, CirclePlus, Package, RotateCcw, Server, Sparkles } from "./icons.js";
import { useEffect, useState, type ReactNode } from "react";
import { type MarketPlugin, type PluginContribution, PLUGIN_CONTRIBUTIONS, type PluginMarketListing, type PluginSourceUpdate, type StorePlugin } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { listStorePlugins, readPluginMarket, readPluginStatus, readPluginUpdates, waitForRuntime } from "./api.js";
import { groupStorePlugins, marketContributions, marketUpdate, sourceUpdate, type StorePluginGroup, StorePluginCard, storePluginContributions, StorePluginDetail, storePluginSearchText, StoreSkillCard, useEveryProjectSwitch } from "./plugin-store.js";
import { CATALOG_CATEGORIES, catalogSection, categoryLabel, CategoryChips, type CatalogFilter, FeaturedPluginCard, inCatalogCategory, MarketPluginCard, MarketPluginDetail, type MarketSort, MarketSortSelect, sortMarket } from "./plugin-catalog.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { settingsHash, type PluginsTab } from "./routes.js";
import { t } from "./i18n.js";
import type { TryPlugin } from "./plugin-try.js";
import { PluginAddDialog } from "./plugin-add-dialog.js";
import { Alert, Button, DropdownMenu, Empty, SearchInput, Select, Spinner, Tabs, type MenuEntry } from "./ui/index.js";
import "./plugins.css";

/** The person's own: one they made, or one added from this computer. Installed plugins get updates; these get edited. */
const isMine = (plugin: StorePlugin) => plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`) || (!plugin.bundled && !plugin.preinstalled && !plugin.origin);

export function PluginsSettings({ pluginId, adds: initialAdds, tab: routeTab, onPluginChange, onTabChange, onTryPlugin }: {
  pluginId?: string;
  /** Opens the marketplace filtered to plugins that add this, as 更多类型… in the new-project dialog does. */
  adds?: PluginContribution;
  /** The tab the route names; a plugin's page and back keep the one last shown. */
  tab?: PluginsTab;
  onPluginChange: (pluginId?: string) => void;
  onTabChange?: (tab: PluginsTab) => void;
  onTryPlugin: TryPlugin;
}) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [store, setStore] = useState<StorePlugin[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [addOpen, setAddOpen] = useState(false);
  const [market, setMarket] = useState<PluginMarketListing>();
  const [adding, setAdding] = useState<MarketPlugin>();
  const [updates, setUpdates] = useState<PluginSourceUpdate[]>();
  const [updating, setUpdating] = useState<PluginSourceUpdate>();
  const [safeMode, setSafeMode] = useState(false);
  const runtimeService = typeof window === "undefined" ? undefined : window.ohMyGameDesktop?.runtimeService;
  const restart = (mode: boolean) => void runtimeService?.restart({ safeMode: mode }).catch((cause: unknown) => setError(errorMessage(cause)));
  // Discover comes first, as in a store: what's installed is mostly switched on and off from projects.
  const [tab, showTab] = useState<PluginsTab>(routeTab ?? "discover");
  const [query, setQuery] = useState("");
  const [adds, setAdds] = useState<PluginContribution | "all">(initialAdds ?? "all");
  const [kind, setKind] = useState<PluginContribution | "all">("all");
  const [marketCategory, setMarketCategory] = useState<CatalogFilter>("all");
  const [installedCategory, setInstalledCategory] = useState<CatalogFilter>("all");
  const [sort, setSort] = useState<MarketSort>("recommended");
  useEffect(() => { if (routeTab) showTab(routeTab); }, [routeTab]);
  useEffect(() => {
    if (!initialAdds) return;
    showTab("discover");
    setAdds(initialAdds);
  }, [initialAdds]);
  function setTab(next: PluginsTab): void {
    showTab(next);
    onTabChange?.(next);
  }
  const [error, setError] = useState<string>();

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      setStore(await listStorePlugins());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  /** After a change: what's on the page stays if the list can't be read again. */
  async function reload(): Promise<void> {
    try {
      setStore(await listStorePlugins());
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const everyProject = useEveryProjectSwitch(reload);

  useEffect(() => { void load(); }, [serviceGeneration]);
  // The page works without the market, so it neither waits for it nor reports it failing.
  // The daemon answers from what it has and refreshes behind that, so asking again is cheap.
  // A failed read keeps what was read before, or says the market can't be reached.
  const readMarket = () => void waitForRuntime().then(readPluginMarket).then(setMarket, () => setMarket(current => current ?? { status: "unavailable", plugins: [], blocked: [] }));
  useEffect(() => {
    readMarket();
    const timer = setInterval(readMarket, MARKET_READ_MS);
    return () => clearInterval(timer);
  }, [serviceGeneration]);

  // Where installed plugins came from is checked when the page opens, and again after one is added.
  const readUpdates = () => void waitForRuntime().then(readPluginUpdates).then(setUpdates, () => {});
  useEffect(readUpdates, [serviceGeneration]);
  useEffect(() => { void waitForRuntime().then(readPluginStatus).then((status) => setSafeMode(status.safeMode), () => {}); }, [serviceGeneration]);
  const added = (id: string) => void reload().then(() => { readUpdates(); onPluginChange(id); });

  function createWithAi(): void {
    void openPluginBuilder().catch(cause => setError(errorMessage(cause)));
  }

  const normalizedQuery = query.trim().toLowerCase();
  const groups = groupStorePlugins(store);
  const matching = groups.filter(group => storePluginSearchText(group.plugin).includes(normalizedQuery))
    .sort((left, right) => left.plugin.displayName.localeCompare(right.plugin.displayName));
  const card = (group: StorePluginGroup) => <StorePluginCard key={group.plugin.id} group={group} market={market} updates={updates} disabled={Boolean(everyProject.busy)}
    onToggle={on => everyProject.toggle(group.plugin, on)} onOpen={() => onPluginChange(group.plugin.id)} />;
  const others = groups.filter(({ plugin }) => !isMine(plugin));
  const updatable = others.some(({ plugin }) => marketUpdate(plugin, market) || sourceUpdate(plugin, market, updates));
  const addMenuItems: MenuEntry[] = [
    { label: t("plugins.createWithAiMenu"), icon: <Sparkles size={14} />, onSelect: createWithAi },
    { label: t("plugins.addMcp"), icon: <Server size={14} />, onSelect: () => { window.location.hash = settingsHash("connections"); } },
    "separator",
    { label: t("pluginAdd.menu"), icon: <Package size={14} />, onSelect: () => setAddOpen(true) },
    // For a plugin that breaks the app: everything starts again with no plugin running.
    ...(runtimeService && !safeMode ? ["separator" as const, { label: t("pluginSafeMode.restartSafe"), icon: <RotateCcw size={14} />, onSelect: () => restart(true) }] : []),
  ];
  // Only what some plugin adds, so no choice leads to an empty page.
  const kindFilter = (value: PluginContribution | "all", onChange: (value: PluginContribution | "all") => void, offered: PluginContribution[]) =>
    <Select<PluginContribution | "all"> size="sm" label={t("plugins.addsFilter")} value={value} onChange={onChange} options={[
      { value: "all", label: t("plugins.allContributions") },
      ...PLUGIN_CONTRIBUTIONS.filter(item => item === value || offered.includes(item)).map(item => ({ value: item, label: t(`plugins.contributions.${item}`) })),
    ]} />;
  const toolbar = (chips: ReactNode, ...controls: ReactNode[]) => <div className="plugins-filters">
    {chips}
    <div className="plugins-filters-end">{controls}</div>
  </div>;

  // Installed: what others made, by what it is for. Skills are a kind of content, so they are a filter here.
  const installable = matching.filter(({ plugin }) => !isMine(plugin) && (kind === "all" || storePluginContributions(plugin).includes(kind)));
  const installed = installable.filter(({ plugin }) => inCatalogCategory(plugin.categories, installedCategory));
  const matchingSkills = kind === "skills" ? others.flatMap(({ plugin }) => plugin.skills.map(skill => ({ plugin, skill })))
    .filter(({ plugin, skill }) => `${skill.name} ${skill.description} ${plugin.displayName}`.toLowerCase().includes(normalizedQuery)) : [];
  const skills = matchingSkills.filter(({ plugin }) => inCatalogCategory(plugin.categories, installedCategory));
  // Updates come first only on the whole list; a filtered one shows them in place.
  const toUpdate = normalizedQuery || kind !== "all" || installedCategory !== "all" ? []
    : others.filter(({ plugin }) => marketUpdate(plugin, market) || sourceUpdate(plugin, market, updates));
  const installedTab = <>
    {toUpdate.length ? <section className="plugins-section plugins-updates" aria-label={t("pluginCatalog.updates")}>
      <h2>{t("pluginCatalog.updates")}<span className="plugins-count">{toUpdate.length}</span></h2>
      <div className="plugins-grid">{toUpdate.map(card)}</div>
    </section> : null}
    {others.length ? toolbar(
      <CategoryChips items={(kind === "skills" ? matchingSkills : installable).map(({ plugin }) => plugin.categories)} value={installedCategory} onChange={setInstalledCategory} />,
      kindFilter(kind, setKind, [...new Set(others.flatMap(({ plugin }) => storePluginContributions(plugin)))]),
    ) : null}
    {kind === "skills" ? skills.length
      ? <div className="plugins-grid">{skills.map(({ plugin, skill }) => <StoreSkillCard key={`${plugin.id}:${skill.id}`} plugin={plugin} skill={skill} onOpen={() => onPluginChange(plugin.id)} />)}</div>
      : <Empty title={t("plugins.noMatchingSkills")} />
      : !installed.length ? <Empty title={normalizedQuery || kind !== "all" || installedCategory !== "all" ? t("plugins.noMatch") : t("plugins.noneInstalled")}
        action={<Button icon={<Package size={14} />} onClick={() => setTab("discover")}>{t("plugins.discoverTab")}</Button>} />
      : normalizedQuery || installedCategory !== "all" ? <div className="plugins-grid">{installed.map(card)}</div>
      : CATALOG_CATEGORIES.map(category => ({ category, plugins: installed.filter(({ plugin }) => catalogSection(plugin.categories) === category) }))
        .filter(group => group.plugins.length)
        .map(group => <PluginGroup key={group.category} title={categoryLabel(group.category)} cards={group.plugins.map(card)} />)}
  </>;

  // Discover: the market, to get plugins from. A card opens the plugin's page, installed or not.
  const installedIds = new Set(groups.map(group => group.plugin.id));
  const marketPlugins = market?.plugins ?? [];
  const searched = marketPlugins.filter(plugin => `${plugin.displayName} ${plugin.description} ${plugin.id} ${plugin.package}`.toLowerCase().includes(normalizedQuery)
    && (adds === "all" || marketContributions(plugin).includes(adds)));
  const listed = sortMarket(searched.filter(plugin => inCatalogCategory(plugin.categories, marketCategory)), sort);
  const marketCard = (plugin: MarketPlugin) => <MarketPluginCard key={plugin.id} plugin={plugin} installed={installedIds.has(plugin.id)}
    onOpen={() => onPluginChange(plugin.id)} onGet={() => setAdding(plugin)} />;
  // With nothing picked, the market reads like a store's front page: what's featured, then a few of each category.
  const browsing = !normalizedQuery && adds === "all" && marketCategory === "all";
  const featured = browsing ? listed.filter(plugin => plugin.featured).slice(0, FEATURED_LIMIT) : [];
  // A category gets its own section once it has two; the rest share one at the end.
  const byCategory = CATALOG_CATEGORIES.map(category => ({ category, plugins: listed.filter(plugin => catalogSection(plugin.categories) === category) }));
  const sections = byCategory.filter(group => group.category !== "other" && group.plugins.length > 1);
  const unsectioned = byCategory.filter(group => !sections.includes(group)).flatMap(group => group.plugins);
  const discoverTab = <>
    {market?.status === "unavailable" ? <Alert tone="info" title={t("plugins.marketUnavailable")} /> : null}
    {market?.status === "stale" ? <Alert tone="info" title={t("plugins.marketStale")} /> : null}
    {marketPlugins.length ? toolbar(
      <CategoryChips items={searched.map(plugin => plugin.categories)} value={marketCategory} onChange={setMarketCategory} />,
      kindFilter(adds, setAdds, [...new Set(marketPlugins.flatMap(marketContributions))]),
      browsing ? null : <MarketSortSelect key="sort" value={sort} onChange={setSort} />,
    ) : null}
    {featured.length ? <section className="plugins-section" aria-label={t("plugins.marketFeatured")}>
      <h2>{t("plugins.marketFeatured")}</h2>
      <div className="plugins-features">{featured.map(plugin => <FeaturedPluginCard key={plugin.id} plugin={plugin} onOpen={() => onPluginChange(plugin.id)} />)}</div>
    </section> : null}
    {!listed.length ? null : browsing && listed.length > SECTIONS_FROM ? <>
      {sections.map(group => <section key={group.category} className="plugins-section" aria-label={categoryLabel(group.category)}>
        <div className="plugins-section-head">
          <h2>{categoryLabel(group.category)}</h2>
          {group.plugins.length > SECTION_LIMIT ? <Button variant="ghost" size="sm" onClick={() => setMarketCategory(group.category)}>
            {t("plugins.viewAll", { count: group.plugins.length })}
          </Button> : null}
        </div>
        <div className="plugins-grid">{group.plugins.slice(0, SECTION_LIMIT).map(marketCard)}</div>
      </section>)}
      {unsectioned.length ? <section className="plugins-section" aria-label={t("pluginCatalog.morePlugins")}>
        <h2>{t("pluginCatalog.morePlugins")}</h2>
        <div className="plugins-grid">{unsectioned.map(marketCard)}</div>
      </section> : null}
    </>
      : browsing ? <section className="plugins-section" aria-label={t("pluginCatalog.allPlugins")}>
        <h2>{t("pluginCatalog.allPlugins")}</h2>
        <div className="plugins-grid">{listed.map(marketCard)}</div>
      </section>
      : <section className="plugins-section" aria-label={t("pluginCatalog.results", { count: listed.length })}>
        <p className="plugins-note">{t("pluginCatalog.results", { count: listed.length })}</p>
        <div className="plugins-grid">{listed.map(marketCard)}</div>
      </section>}
    {listed.length ? null : <Empty title={normalizedQuery || adds !== "all" || marketCategory !== "all" ? t("plugins.noMatch") : t("plugins.nothingToDiscover")} description={t("plugins.browseEmpty")} action={<div className="plugins-empty-actions">
      <Button icon={<Package size={14} />} onClick={() => setAddOpen(true)}>{t("pluginAdd.menu")}</Button>
      <Button icon={<Sparkles size={14} />} onClick={createWithAi}>{t("plugins.createWithAi")}</Button>
    </div>} />}
  </>;

  // Mine: what the person can edit: a new one with AI, the AI workspaces, and their own plugins.
  const mine = matching.filter(({ plugin }) => isMine(plugin));
  const mineTab = <>
    <section className="plugins-section" aria-label={t("plugins.minePlugins")}>
      <h2>{t("plugins.minePlugins")}</h2>
      <div className="plugins-grid">
        <button type="button" className="plugin-card plugin-card-create" onClick={createWithAi}>
          <span className="plugin-tile"><Sparkles size={18} /></span>
          <span className="plugin-card-text">
            <strong>{t("plugins.createPluginWithAi")}</strong>
            <small>{t("plugins.createWithAiHint")}</small>
          </span>
        </button>
        {mine.map(card)}
      </div>
    </section>
    <PluginBuilderSessions />
  </>;

  const detail = pluginId ? groups.find(group => group.plugin.id === pluginId) : undefined;
  const listedDetail = pluginId && !detail ? marketPlugins.find(plugin => plugin.id === pluginId) : undefined;

  return <section className="plugins-page">
    {safeMode ? <div className="plugins-safe-mode"><Alert tone="danger" title={t("pluginSafeMode.title")} action={runtimeService
      ? <Button size="sm" onClick={() => restart(false)}>{t("pluginSafeMode.restartNormally")}</Button> : undefined}>
      {t("pluginSafeMode.hint")}
    </Alert></div> : null}
    {pluginId ? <>
      <div className="plugins-back">
        <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={showCatalog}>{t("plugins.title")}</Button>
      </div>
      {detail
        ? <StorePluginDetail key={pluginId} group={detail} market={market} updates={updates} onUpdate={setAdding}
          onUpdateSource={setUpdating} onAddAgain={() => setAddOpen(true)} onChanged={reload} onRemoved={showCatalog} onTry={onTryPlugin} />
        : listedDetail ? <MarketPluginDetail key={pluginId} plugin={listedDetail} onGet={() => setAdding(listedDetail)} />
        : phase === "loading" || !market ? <PluginState>{t("plugins.loadingPlugin")}</PluginState>
          : <PluginError message={error ?? t("pluginStore.notInstalled")} onRetry={() => { readMarket(); void load(); }} />}
    </> : <>
      <SidebarPageHeader title={t("plugins.title")} actions={<div className="plugins-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder={t("plugins.search")} label={t("plugins.searchLabel")} />
        <DropdownMenu placement="bottom-end" items={addMenuItems} trigger={(props) => (
          <Button {...props} variant="primary" icon={<CirclePlus size={14} />}>{t("plugins.add")}</Button>
        )} />
      </div>} />
      <Tabs<PluginsTab> variant="pills" label={t("plugins.title")} value={tab} onChange={setTab} tabs={[
        { value: "discover", label: t("plugins.discoverTab") },
        { value: "installed", label: t("plugins.installedTab"), attention: updatable ? t("plugins.updatesAvailable") : undefined },
        { value: "mine", label: t("plugins.mineTab") },
      ]} />
      <div className="plugins-panel" role="tabpanel" aria-label={t(`plugins.${tab}Tab`)}>
        {phase === "ready" && (error ?? everyProject.error) ? <Alert tone="danger" title={error ?? everyProject.error} /> : null}
        {phase === "loading" ? <PluginState>{t("plugins.loading")}</PluginState> : null}
        {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
        {phase === "ready" ? tab === "discover" ? discoverTab : tab === "mine" ? mineTab : installedTab : null}
      </div>
    </>}
    {addOpen ? <PluginAddDialog onClose={() => setAddOpen(false)} onAdded={(id) => { setAddOpen(false); added(id); }} /> : null}
    {adding ? <PluginAddDialog key={adding.id} listed={adding} onClose={() => setAdding(undefined)} onAdded={(id) => { setAdding(undefined); added(id); }} /> : null}
    {updating ? <PluginAddDialog key={updating.id} source={updating.source} onClose={() => setUpdating(undefined)} onAdded={(id) => { setUpdating(undefined); added(id); }} /> : null}
  </section>;

  function showCatalog(): void {
    // Back to the tab the plugin was opened from.
    if (onTabChange) onTabChange(tab);
    else onPluginChange();
  }
}

const INSTALLED_PLUGIN_LIMIT = 6;
/** Cards in a category's section of the market's front page, and featured ones above them. */
const SECTION_LIMIT = 4;
/** Below this many, sections of one or two cards say less than a single list does. */
const SECTIONS_FROM = 12;
const FEATURED_LIMIT = 4;
/** How often an open page picks up what the daemon's market has read. */
const MARKET_READ_MS = 2 * 60_000;

/** A category of installed plugins: its first six cards, and the rest behind View all. */
function PluginGroup({ title, cards }: { title: string; cards: ReactNode[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const limited = !expanded && cards.length > INSTALLED_PLUGIN_LIMIT;
  return <section className="plugins-section" aria-label={title}>
    <h2>{title}</h2>
    <div className="plugins-grid">{limited ? cards.slice(0, INSTALLED_PLUGIN_LIMIT) : cards}</div>
    {cards.length > INSTALLED_PLUGIN_LIMIT ? <div><Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
      {expanded ? t("plugins.showLess") : t("plugins.viewAll", { count: cards.length })}
    </Button></div> : null}
  </section>;
}

function PluginState({ children }: { children: ReactNode }): ReactNode {
  return <div className="plugins-state"><Spinner size={14} label={typeof children === "string" ? children : undefined} />{children}</div>;
}

function PluginError({ message, onRetry }: { message?: string; onRetry: () => void }): ReactNode {
  return <Alert tone="danger" title={message ?? t("common.somethingWrong")} action={<Button size="sm" onClick={onRetry}>{t("common.retry")}</Button>} />;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
