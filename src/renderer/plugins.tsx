import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { MinePlugins } from "./plugin-builder.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ChevronLeft, CirclePlus, Package, RotateCcw, Server, SlidersHorizontal, Sparkles } from "./icons.js";
import { useEffect, useState, type ReactNode } from "react";
import { PluginMarketSourcesDialog } from "./plugin-market-sources.js";
import { type MarketPlugin, type PluginContribution, PLUGIN_CONTRIBUTIONS, type PluginMarketListing, type PluginSourceUpdate, type StorePlugin } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { listStorePlugins, readPluginMarket, readPluginStatus, readPluginUpdates, waitForRuntime } from "./api.js";
import { groupStorePlugins, marketContributions, marketUpdate, sourceUpdate, type StorePluginGroup, StorePluginCard, storePluginContributions, StorePluginDetail, storePluginSearchText, StoreSkillCard, useEveryProjectSwitch } from "./plugin-store.js";
import { CATALOG_CATEGORIES, catalogSection, categoryLabel, CategoryChips, type CatalogFilter, inCatalogCategory, marketFront, marketOnly, type MarketOnly, MarketPluginCard, MarketPluginDialog, MarketRail, type MarketSection, type MarketSort, MarketSortSelect, marketSearchText, sortMarket } from "./plugin-catalog.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { settingsHash, type PluginsTab } from "./routes.js";
import { t } from "./i18n.js";
import type { TryPlugin } from "./plugin-try.js";
import { PluginAddDialog } from "./plugin-add-dialog.js";
import { Alert, Button, DropdownMenu, Empty, SearchInput, Select, Spinner, Tabs, type MenuEntry } from "./ui/index.js";
import "./plugins.css";

/**
 * One the person makes: made with AI, or developed from a folder. Installed
 * lists them with the rest; Mine is where they're made. A package added from a
 * folder or file is someone's release, so it's only under Installed.
 */
const isMine = (plugin: StorePlugin) => plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`) || plugin.origin?.type === "development";

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
  // A market plugin shown over Discover, so browsing never leaves the list.
  const [preview, setPreview] = useState<string>();
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
  const [marketSection, setMarketSection] = useState<MarketSection>("home");
  const [only, setOnly] = useState<MarketOnly[]>([]);
  const [installedCategory, setInstalledCategory] = useState<CatalogFilter>("all");
  const [sort, setSort] = useState<MarketSort>("recommended");
  useEffect(() => { if (routeTab) showTab(routeTab); }, [routeTab]);
  useEffect(() => {
    if (!initialAdds) return;
    showTab("discover");
    setAdds(initialAdds);
    setMarketSection("all");
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
  const [marketSettings, setMarketSettings] = useState(false);
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
  const byName = (left: StorePluginGroup, right: StorePluginGroup) => left.plugin.displayName.localeCompare(right.plugin.displayName);
  const matching = groups.filter(group => storePluginSearchText(group.plugin).includes(normalizedQuery)).sort(byName);
  const card = (group: StorePluginGroup) => <StorePluginCard key={group.plugin.id} group={group} market={market} updates={updates} disabled={Boolean(everyProject.busy)}
    onToggle={on => everyProject.toggle(group.plugin, on)} onOpen={() => onPluginChange(group.plugin.id)} />;
  // Installed is every plugin, the person's own among them: it is where plugins are switched on and off.
  const updatable = groups.some(({ plugin }) => marketUpdate(plugin, market) || sourceUpdate(plugin, market, updates));
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

  // Installed: every plugin, by what it is for. Skills are a kind of content, so they are a filter here.
  const installable = matching.filter(({ plugin }) => kind === "all" || storePluginContributions(plugin).includes(kind));
  const installed = installable.filter(({ plugin }) => inCatalogCategory(plugin.categories, installedCategory));
  const matchingSkills = kind === "skills" ? groups.flatMap(({ plugin }) => plugin.skills.map(skill => ({ plugin, skill })))
    .filter(({ plugin, skill }) => `${skill.name} ${skill.description} ${plugin.displayName}`.toLowerCase().includes(normalizedQuery)) : [];
  const skills = matchingSkills.filter(({ plugin }) => inCatalogCategory(plugin.categories, installedCategory));
  // Updates come first only on the whole list; a filtered one shows them in place.
  const toUpdate = normalizedQuery || kind !== "all" || installedCategory !== "all" ? []
    : groups.filter(({ plugin }) => marketUpdate(plugin, market) || sourceUpdate(plugin, market, updates));
  const installedTab = <>
    {toUpdate.length ? <section className="plugins-section plugins-updates" aria-label={t("pluginCatalog.updates")}>
      <h2>{t("pluginCatalog.updates")}<span className="plugins-count">{toUpdate.length}</span></h2>
      <div className="plugins-grid">{toUpdate.map(card)}</div>
    </section> : null}
    {groups.length ? toolbar(
      <CategoryChips items={(kind === "skills" ? matchingSkills : installable).map(({ plugin }) => plugin.categories)} value={installedCategory} onChange={setInstalledCategory} />,
      kindFilter(kind, setKind, [...new Set(groups.flatMap(({ plugin }) => storePluginContributions(plugin)))]),
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

  // Discover: the market, to get plugins from, browsed from a side list as in an app store.
  // A card opens the plugin in a dialog over the list.
  const installedIds = new Set(groups.map(group => group.plugin.id));
  const marketPlugins = market?.plugins ?? [];
  const searched = marketPlugins.filter(plugin => marketSearchText(plugin).includes(normalizedQuery)
    && (adds === "all" || marketContributions(plugin).includes(adds)) && marketOnly(plugin, only));
  const marketCategory: CatalogFilter = marketSection === "home" ? "all" : marketSection;
  const listed = sortMarket(searched.filter(plugin => inCatalogCategory(plugin.categories, marketCategory)), sort);
  const marketCard = (plugin: MarketPlugin) => <MarketPluginCard key={plugin.id} plugin={plugin} installed={installedIds.has(plugin.id)}
    onOpen={() => setPreview(plugin.id)} />;
  // The overview reads like a store's front page, the same few rows however many plugins there are.
  // Searching or filtering shows one list instead, a page at a time.
  const narrowed = Boolean(normalizedQuery) || adds !== "all" || only.length > 0;
  const front = marketSection === "home" && !narrowed && marketPlugins.length > SECTIONS_FROM ? marketFront(marketPlugins) : undefined;
  const showAll = (order: MarketSort) => { setMarketSection("all"); setSort(order); };
  const row = (title: string, plugins: MarketPlugin[], order?: MarketSort) => plugins.length
    ? <section key={title} className="plugins-section" aria-label={title}>
      <div className="plugins-section-head">
        <h2>{title}</h2>
        {order ? <Button variant="ghost" size="sm" onClick={() => showAll(order)}>{t("plugins.viewAll", { count: listed.length })}</Button> : null}
      </div>
      <div className="plugins-grid">{plugins.map(marketCard)}</div>
    </section> : null;
  const listTitle = marketSection === "home" || marketSection === "all" ? t("pluginCatalog.allPlugins") : categoryLabel(marketSection);
  const discoverTab = <>
    {/* The main index may be one the person set, so where it's set is right here. */}
    {market?.status === "unavailable" || market?.status === "stale" ? <Alert tone="info" title={t(market.status === "stale" ? "plugins.marketStale" : "plugins.marketUnavailable")}
      action={<Button variant="ghost" size="sm" onClick={() => setMarketSettings(true)}>{t("pluginMarketSettings.open")}</Button>} /> : null}
    {marketSettings ? <PluginMarketSourcesDialog sources={market?.sources} onClose={() => setMarketSettings(false)} onSaved={readMarket} /> : null}
    {marketPlugins.length ? <div className="plugins-browse">
      <MarketRail plugins={searched} section={marketSection} onSection={setMarketSection} only={only} onOnly={setOnly} onSettings={() => setMarketSettings(true)} />
      <div className="plugins-browse-main">
        {front ? <>
          {row(t("plugins.marketFeatured"), front.featured)}
          {row(t("pluginCatalog.sort.recommended"), front.recommended, "recommended")}
          {row(t("pluginCatalog.newPlugins"), front.new, "new")}
          {row(t("pluginCatalog.sort.updated"), front.updated, "updated")}
          <div className="plugins-all">
            <Button onClick={() => showAll("recommended")}>{t("pluginCatalog.viewAllPlugins", { count: listed.length })}</Button>
          </div>
        </> : <section className="plugins-section" aria-label={listTitle}>
          <div className="plugins-section-head">
            <h2>{listTitle}<span className="plugins-count">{listed.length}</span></h2>
            <div className="plugins-filters-end">
              {kindFilter(adds, setAdds, [...new Set(marketPlugins.flatMap(marketContributions))])}
              <MarketSortSelect value={sort} onChange={setSort} />
            </div>
          </div>
          {listed.length ? <PagedGrid key={`${normalizedQuery}\n${adds}\n${marketSection}\n${only.join()}\n${sort}`} cards={listed.map(marketCard)} />
            : <Empty title={t("plugins.noMatch")} />}
        </section>}
      </div>
    </div> : <Empty title={t("plugins.nothingToDiscover")} description={t("plugins.browseEmpty")} action={<div className="plugins-empty-actions">
      <Button icon={<Package size={14} />} onClick={() => setAddOpen(true)}>{t("pluginAdd.menu")}</Button>
      <Button icon={<Sparkles size={14} />} onClick={createWithAi}>{t("plugins.createWithAi")}</Button>
      {/* With no rail to hold it, where the market is listed from is here too. */}
      {market && market.status !== "off" ? <Button variant="ghost" icon={<SlidersHorizontal size={14} />} onClick={() => setMarketSettings(true)}>{t("pluginMarketSettings.open")}</Button> : null}
    </div>} />}
  </>;

  // Mine: a new plugin with AI, then a card for each plugin the person makes, as projects are.
  const mineTab = <>
    <div className="plugins-create">
      <span className="plugin-tile"><Sparkles size={18} /></span>
      <span className="plugins-create-text">
        <strong>{t("plugins.createPluginWithAi")}</strong>
        <small>{t("plugins.createWithAiHint")}</small>
      </span>
      <Button variant="primary" icon={<Sparkles size={14} />} onClick={createWithAi}>{t("plugins.createStart")}</Button>
    </div>
    <MinePlugins plugins={groups.filter(({ plugin }) => isMine(plugin)).sort(byName)} query={normalizedQuery} onOpenPlugin={onPluginChange} />
  </>;

  const detail = pluginId ? groups.find(group => group.plugin.id === pluginId) : undefined;
  // A link to a plugin that isn't installed opens it over Discover, as a card does.
  const linked = pluginId && !detail ? marketPlugins.find(plugin => plugin.id === pluginId) : undefined;
  const page = linked ? undefined : pluginId;
  const shown = preview ? marketPlugins.find(plugin => plugin.id === preview) : linked;
  const closePreview = () => { if (preview) setPreview(undefined); else showCatalog(); };

  return <section className="plugins-page">
    {safeMode ? <div className="plugins-safe-mode"><Alert tone="danger" title={t("pluginSafeMode.title")} action={runtimeService
      ? <Button size="sm" onClick={() => restart(false)}>{t("pluginSafeMode.restartNormally")}</Button> : undefined}>
      {t("pluginSafeMode.hint")}
    </Alert></div> : null}
    {page ? <>
      <div className="plugins-back">
        <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={showCatalog}>{t("plugins.title")}</Button>
      </div>
      {detail
        ? <StorePluginDetail key={page} group={detail} market={market} updates={updates} onUpdate={setAdding}
          onUpdateSource={setUpdating} onAddAgain={() => setAddOpen(true)} onChanged={reload} onRemoved={showCatalog} onTry={onTryPlugin}
          // A keyword searches every installed plugin, whatever the list was narrowed to.
          onSearch={(keyword) => { setQuery(keyword); setKind("all"); setInstalledCategory("all"); showCatalog(); }} />
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
    {shown && !adding ? <MarketPluginDialog key={shown.id} plugin={shown} installed={installedIds.has(shown.id)} onClose={closePreview}
      onGet={() => setAdding(shown)}
      onManage={() => { setPreview(undefined); onPluginChange(shown.id); }}
      // A keyword searches the whole market, not just the section it was opened from.
      onSearch={(keyword) => { setQuery(keyword); setMarketSection("all"); closePreview(); }} /> : null}
    {addOpen ? <PluginAddDialog onClose={() => setAddOpen(false)} onAdded={(id) => { setAddOpen(false); added(id); }} /> : null}
    {adding ? <PluginAddDialog key={adding.id} listed={adding} onClose={() => setAdding(undefined)} onAdded={(id) => { setAdding(undefined); setPreview(undefined); added(id); }} /> : null}
    {updating ? <PluginAddDialog key={updating.id} source={updating.source} onClose={() => setUpdating(undefined)} onAdded={(id) => { setUpdating(undefined); added(id); }} /> : null}
  </section>;

  function showCatalog(): void {
    // Back to the tab the plugin was opened from.
    if (onTabChange) onTabChange(tab);
    else onPluginChange();
  }
}

const INSTALLED_PLUGIN_LIMIT = 6;
/** Below this many, rows of one or two cards say less than a single list does. */
const SECTIONS_FROM = 12;
/** Market cards a list shows at a time, so a long one stays quick to draw and to fetch icons for. */
const LIST_PAGE = 24;
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

/** A long list of cards, a page at a time. */
function PagedGrid({ cards }: { cards: ReactNode[] }): ReactNode {
  const [count, setCount] = useState(LIST_PAGE);
  return <>
    <div className="plugins-grid">{cards.slice(0, count)}</div>
    {cards.length > count ? <div className="plugins-all">
      <Button onClick={() => setCount((current) => current + LIST_PAGE)}>{t("pluginCatalog.showMore", { count: cards.length - count })}</Button>
    </div> : null}
  </>;
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
