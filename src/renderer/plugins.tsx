import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { MinePlugins } from "./plugin-builder.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ChevronLeft, CirclePlus, LoaderCircle, Package, RefreshCw, Server, SlidersHorizontal, Sparkles } from "./icons.js";
import { Activity, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PluginMarketSourcesDialog } from "./plugin-market-sources.js";
import { type MarketPlugin, type PluginAddPreview, type PluginAddSource, type PluginContribution, PLUGIN_CONTRIBUTIONS, type PluginMarketListing, type PluginSourceUpdate, type StorePlugin } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { addPlugin, ApiError, inspectAddedPlugin, listStorePlugins, readPluginMarket, readPluginStatus, readPluginUpdates, waitForRuntime } from "./api.js";
import { groupStorePlugins, marketContributions, marketUpdate, sourceUpdate, type StorePluginGroup, StorePluginRow, StorePluginDetail, storePluginEnabled, storePluginSearchText, useEveryProjectSwitch } from "./plugin-store.js";
import { CATALOG_CATEGORIES, categoryLabel, type CatalogFilter, inCatalogCategory, marketFront, marketOnly, type MarketOnly, MarketPluginCard, MarketPluginDialog, MarketRail, type MarketSection, type MarketSort, MarketSortSelect, marketSearchText, inProviderKind, ProviderKindChips, type ProviderKindFilter, sortMarket } from "./plugin-catalog.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { settingsHash, type PluginsTab } from "./routes.js";
import { t } from "./i18n.js";
import type { TryPlugin } from "./plugin-try.js";
import { marketPluginSource, PluginAddDialog } from "./plugin-add-dialog.js";
import { Alert, Button, DropdownMenu, Empty, FilterChips, SearchInput, Select, Spinner, Tabs, type MenuEntry } from "./ui/index.js";
import "./plugins.css";

/**
 * One the person makes: made with AI, or developed from a folder. Installed
 * lists them with the rest; Mine is where they're made. A package added from a
 * folder or file is someone's release, so it's only under Installed.
 */
const isMine = (plugin: StorePlugin) => plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`) || plugin.origin?.type === "development";

type InstalledStatus = "all" | "everyProject" | "updates";
type InstalledSection = CatalogFilter | InstalledStatus;

export function PluginsSettings({ pluginId, adds: initialAdds, tab: routeTab, onPluginChange, onTabChange, onTryPlugin }: {
  pluginId?: string;
  /** Opens the marketplace filtered to plugins that add this, as 更多类型… in the new-project dialog does. */
  adds?: PluginContribution;
  /** The tab the route names; a plugin's page and back keep the one last shown. */
  tab?: PluginsTab;
  onPluginChange: (pluginId?: string, tab?: "installed") => void;
  onTabChange?: (tab: PluginsTab) => void;
  onTryPlugin: TryPlugin;
}) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [store, setStore] = useState<StorePlugin[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [market, setMarket] = useState<PluginMarketListing>();
  // A market plugin shown over Discover, so browsing never leaves the list.
  const [preview, setPreview] = useState<string>();
  const [updates, setUpdates] = useState<PluginSourceUpdate[]>();
  const [operation, setOperation] = useState<InstallOperation>();
  const dialog = operation?.kind === "dialog" ? operation.options : operation?.kind === "card" ? operation.review : undefined;
  const installing = operation !== undefined;
  const [updatedAll, setUpdatedAll] = useState<{ updated: number; review: number; failed: string[] }>();
  const [safeMode, setSafeMode] = useState(false);
  const runtimeService = typeof window === "undefined" ? undefined : window.ohMyGameDesktop?.runtimeService;
  const restart = (mode: boolean) => void runtimeService?.restart({ safeMode: mode }).catch((cause: unknown) => setError(errorMessage(cause)));
  // Discover comes first, as in a store: what's installed is mostly switched on and off from projects.
  const [tab, showTab] = useState<PluginsTab>(routeTab ?? "discover");
  const [query, setQuery] = useState("");
  const [adds, setAdds] = useState<PluginContribution | "all">(initialAdds ?? "all");
  const [marketSection, setMarketSection] = useState<MarketSection>("home");
  // Under Model providers: what the providers make.
  const [providerKind, setProviderKind] = useState<ProviderKindFilter>("all");
  const [only, setOnly] = useState<MarketOnly[]>([]);
  const [installedSection, setInstalledSection] = useState<InstalledSection>("all");
  const pageRef = useRef<HTMLElement>(null);
  const inventoryRef = useRef<HTMLElement>(null);
  const detailBack = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<"detail" | "row" | "search" | undefined>(undefined);
  const activeRoute = useRef<string | undefined>(pluginId);
  const [compact, setCompact] = useState(false);
  const [lastInstalledId, setLastInstalledId] = useState<string>();
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = page.clientWidth;
      if (width > 0) setCompact(width < 660);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
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
  const updateDisabled = installing || Boolean(everyProject.busy);

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
  async function refreshInstalled(): Promise<void> {
    await reload();
    readUpdates();
  }

  function openAddDialog(options: AddDialogOptions = {}): void {
    if (!installing) setOperation({ kind: "dialog", options });
  }

  function installedFromDialog(id: string): void {
    if (operation?.kind === "card") {
      setOperation({ kind: "card", id: operation.id });
      void refreshInstalled().finally(() => setOperation(undefined));
    } else {
      setOperation(undefined);
      if (dialog?.listed) setPreview(undefined);
      void refreshInstalled().then(() => onPluginChange(id, tab === "installed" ? tab : undefined));
    }
  }

  function createWithAi(): void {
    void openPluginBuilder().catch(cause => setError(errorMessage(cause)));
  }

  const normalizedQuery = query.trim().toLowerCase();
  const groups = groupStorePlugins(store).sort((left, right) => left.plugin.displayName.localeCompare(right.plugin.displayName));
  const matching = groups.filter(({ plugin }) => !normalizedQuery || storePluginSearchText(plugin).includes(normalizedQuery));
  const addMenuItems: MenuEntry[] = [
    { label: t("plugins.createWithAi"), icon: <Sparkles size={14} />, onSelect: createWithAi },
    { label: t("plugins.addMcp"), icon: <Server size={14} />, onSelect: () => { window.location.hash = settingsHash("connections"); } },
    "separator",
    { label: t("pluginAdd.menu"), icon: <Package size={14} />, disabled: installing, onSelect: () => openAddDialog() },
  ];
  // Nav counts describe the installed library and stay available while searching.
  const everyProjectIds = new Set(groups.filter(({ plugin }) => plugin.everyProject && storePluginEnabled(plugin))
    .map(({ plugin }) => plugin.id));
  const toUpdate = groups.flatMap(({ plugin }) => {
    const target = updateTarget(plugin);
    return target ? [{ plugin, target }] : [];
  });
  const updateIds = new Set(toUpdate.map(({ plugin }) => plugin.id));
  const installed = matching.filter(({ plugin }) => {
    if (installedSection === "everyProject") return everyProjectIds.has(plugin.id);
    if (installedSection === "updates") return updateIds.has(plugin.id);
    return inCatalogCategory(plugin.categories, installedSection);
  });
  const installedStatuses = [
    { value: "all", label: t("pluginCatalog.all"), count: groups.length },
    { value: "everyProject", label: t("plugins.scopeEveryProject"), count: everyProjectIds.size },
    { value: "updates", label: t("pluginCatalog.updates"), count: toUpdate.length },
  ] satisfies { value: InstalledStatus; label: string; count: number }[];
  const activeStatus = installedStatuses.find(({ value }) => value === installedSection);
  const activeCategory = installedSection !== "all" && installedSection !== "everyProject" && installedSection !== "updates"
    ? categoryLabel(installedSection) : undefined;
  const installedCategories = CATALOG_CATEGORIES.filter((category) => category === installedSection
    || groups.some(({ plugin }) => inCatalogCategory(plugin.categories, category)));
  const installedEmpty = !groups.length ? t("plugins.noneInstalled")
    : normalizedQuery ? t("plugins.noMatch")
    : installedSection === "everyProject" ? t("plugins.noneEveryProject")
    : installedSection === "updates" ? t("plugins.noUpdates") : t("plugins.noMatch");

  function updateTarget(plugin: StorePlugin): UpdateTarget | undefined {
    const listed = marketUpdate(plugin, market);
    if (listed) return { source: marketPluginSource(listed), listed };
    const fromSource = sourceUpdate(plugin, market, updates);
    return fromSource && { source: fromSource.source };
  }

  async function updatePlugin(plugin: StorePlugin): Promise<void> {
    if (updateDisabled) return;
    const target = updateTarget(plugin);
    if (!target) return;
    setUpdatedAll(undefined);
    // Reserve the dialog while the inspection runs, even if the user opens another plugin.
    setOperation({ kind: "card", id: plugin.id });
    try {
      const preview = await installIfNoNewPermissions(target.source);
      if (preview) {
        setOperation({ kind: "card", id: plugin.id, review: { preview, listed: target.listed } });
        return;
      }
      await refreshInstalled();
    } catch (cause) {
      setUpdatedAll({ updated: 0, review: 0, failed: [`${plugin.displayName}: ${updateErrorMessage(cause)}`] });
    }
    setOperation(undefined);
  }

  /** Install each update that requires no new permissions. The rest stay available for individual review. */
  async function updateAll(): Promise<void> {
    if (updateDisabled || normalizedQuery || !toUpdate.length) return;
    setOperation({ kind: "batch" });
    setUpdatedAll(undefined);
    const result = { updated: 0, review: 0, failed: [] as string[] };
    try {
      for (const { plugin, target } of toUpdate) {
        setOperation({ kind: "batch", id: plugin.id });
        try {
          if (await installIfNoNewPermissions(target.source)) result.review += 1;
          else result.updated += 1;
        } catch (cause) {
          result.failed.push(`${plugin.displayName}: ${updateErrorMessage(cause)}`);
        }
      }
      setOperation({ kind: "batch" });
      await refreshInstalled();
      setUpdatedAll(result);
    } finally {
      setOperation(undefined);
    }
  }
  // Discover: the market, to get plugins from, browsed from a side list as in an app store.
  // A card opens the plugin in a dialog over the list.
  const installedIds = new Set(groups.map(group => group.plugin.id));
  const marketPlugins = market?.plugins ?? [];
  const offeredContributions = new Set(marketPlugins.flatMap(marketContributions));
  const searched = marketPlugins.filter(plugin => marketSearchText(plugin).includes(normalizedQuery)
    && (adds === "all" || marketContributions(plugin).includes(adds)) && marketOnly(plugin, only));
  const marketCategory: CatalogFilter = marketSection === "home" ? "all" : marketSection;
  const inCategory = searched.filter(plugin => inCatalogCategory(plugin.categories, marketCategory));
  const makes: ProviderKindFilter = marketSection === "provider" ? providerKind : "all";
  const listed = sortMarket(inCategory.filter(plugin => inProviderKind(plugin, makes)), sort);
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
      action={<Button variant="ghost" size="sm" disabled={installing} onClick={() => setMarketSettings(true)}>{t("pluginMarketSettings.open")}</Button>} /> : null}
    {marketSettings ? <PluginMarketSourcesDialog sources={market?.sources} onClose={() => setMarketSettings(false)} onSaved={readMarket} /> : null}
    {marketPlugins.length ? <div className="plugins-browse">
      <MarketRail plugins={searched} section={marketSection} onSection={setMarketSection} only={only} onOnly={setOnly} settingsDisabled={installing} onSettings={() => setMarketSettings(true)} />
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
              <Select<PluginContribution | "all"> size="sm" label={t("plugins.addsFilter")} value={adds} onChange={setAdds} options={[
                { value: "all", label: t("plugins.allContributions") },
                ...PLUGIN_CONTRIBUTIONS.filter(kind => kind === adds || offeredContributions.has(kind)).map(kind => ({ value: kind, label: t(`plugins.contributions.${kind}`) })),
              ]} />
              <MarketSortSelect value={sort} onChange={setSort} />
            </div>
          </div>
          {marketSection === "provider" ? <ProviderKindChips plugins={inCategory} value={makes} onChange={setProviderKind} /> : null}
          {listed.length ? <PagedGrid key={`${normalizedQuery}\n${adds}\n${marketSection}\n${makes}\n${only.join()}\n${sort}`} cards={listed.map(marketCard)} />
            : <Empty title={t("plugins.noMatch")} />}
        </section>}
      </div>
    </div> : <Empty title={t("plugins.nothingToDiscover")} description={t("plugins.browseEmpty")} action={<div className="plugins-empty-actions">
      <Button disabled={installing} icon={<Package size={14} />} onClick={() => openAddDialog()}>{t("pluginAdd.menu")}</Button>
      <Button icon={<Sparkles size={14} />} onClick={createWithAi}>{t("plugins.createWithAi")}</Button>
      {/* With no rail to hold it, where the market is listed from is here too. */}
      {market && market.status !== "off" ? <Button variant="ghost" icon={<SlidersHorizontal size={14} />} disabled={installing} onClick={() => setMarketSettings(true)}>{t("pluginMarketSettings.open")}</Button> : null}
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
    <MinePlugins plugins={groups.filter(({ plugin }) => isMine(plugin))} query={normalizedQuery} onOpenPlugin={onPluginChange} />
  </>;

  const detail = pluginId ? groups.find(group => group.plugin.id === pluginId) : undefined;
  // A link to a plugin that isn't installed opens it over Discover, as a card does.
  const linked = pluginId && !detail ? marketPlugins.find(plugin => plugin.id === pluginId) : undefined;
  const page = linked ? undefined : pluginId;
  const shown = preview ? marketPlugins.find(plugin => plugin.id === preview) : linked;
  const closePreview = () => { if (preview) setPreview(undefined); else showCatalog(); };

  const inInstalled = tab === "installed" && (!pluginId || Boolean(detail));
  const installedSelection = inInstalled ? detail ?? groups.find(({ plugin }) => plugin.id === lastInstalledId) ?? groups[0] : undefined;
  const selectedId = installedSelection?.plugin.id;
  const showInstalledDetail = Boolean(selectedId && (!compact || pluginId));
  useEffect(() => {
    if (!inInstalled || !pluginId) return;
    setLastInstalledId(pluginId);
  }, [inInstalled, pluginId]);
  // Preserve each opened editor’s draft and selected tab, while pausing hidden effects.
  useEffect(() => {
    if (!showInstalledDetail || !selectedId) return;
    setOpened((current) => current.has(selectedId) ? current : new Set([...current, selectedId]));
  }, [showInstalledDetail, selectedId]);
  useLayoutEffect(() => {
    activeRoute.current = pluginId;
    const target = pendingFocus.current;
    if (target === "detail" && pluginId && detailBack.current) {
      detailBack.current.focus();
      pendingFocus.current = undefined;
    } else if (target && target !== "detail" && !pluginId && inventoryRef.current) {
      const list = inventoryRef.current;
      const row = target === "row" ? list.querySelector<HTMLButtonElement>('[aria-current="true"]') : null;
      (row ?? list.querySelector<HTMLInputElement>('input[type="search"]'))?.focus({ preventScroll: true });
      pendingFocus.current = undefined;
    }
  }, [pluginId, compact, query]);

  const editor = (group: StorePluginGroup, embedded: boolean) => <StorePluginDetail key={group.plugin.id} group={group}
    safeMode={safeMode} market={market} updates={updates} installDisabled={updateDisabled} everyProject={everyProject}
    onUpdate={(listed) => openAddDialog({ listed })} onUpdateSource={({ source }) => openAddDialog({ source })}
    onAddAgain={() => openAddDialog()} onChanged={reload}
    onRemoved={() => {
      // Removing one plugin can finish after the user has selected another.
      if (activeRoute.current === group.plugin.id) {
        if (embedded && compact) pendingFocus.current = "search";
        showCatalog();
      }
    }} onTry={onTryPlugin}
    onSearch={(keyword) => {
      setQuery(keyword);
      setInstalledSection("all");
      if (!embedded || compact) {
        if (embedded) pendingFocus.current = "search";
        showCatalog();
      } else {
        inventoryRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
      }
    }} />;

  const installedTab = <>
    {updatedAll ? <Alert tone={updatedAll.failed.length ? "danger" : updatedAll.review ? "info" : "success"}
      title={[
        updatedAll.updated ? t("plugins.updatedAll", { count: updatedAll.updated }) : "",
        updatedAll.review ? t("plugins.updatesToReview", { count: updatedAll.review }) : "",
        updatedAll.failed.length ? t("plugins.updatesFailed", { count: updatedAll.failed.length }) : "",
      ].filter(Boolean).join(" ")}
      action={<Button variant="ghost" size="sm" onClick={() => setUpdatedAll(undefined)}>{t("common.close")}</Button>}>
      {updatedAll.failed.length ? updatedAll.failed.join("; ") : null}
    </Alert> : null}
    <div className="installed-plugins" data-compact={compact || undefined}>
      <aside ref={inventoryRef} className="installed-plugin-inventory" aria-label={t("plugins.installedTab")} hidden={compact && showInstalledDetail}>
        <div className="installed-plugin-filters">
          <div className="installed-plugin-search">
            <SearchInput size="sm" value={query} onChange={setQuery} placeholder={t("plugins.search")} label={t("plugins.searchLabel")} />
            {installedCategories.length ? <DropdownMenu placement="bottom-end" items={installedCategories.map((category) => ({
              label: categoryLabel(category), checked: category === installedSection,
              onSelect: () => setInstalledSection(category === installedSection ? "all" : category),
            }))} trigger={(props) => <Button {...props} size="sm" variant={activeCategory ? "secondary" : "ghost"}
              aria-label={t("pluginCatalog.categoriesLabel")} aria-description={activeCategory} title={activeCategory ?? t("pluginCatalog.categoriesLabel")}
              icon={<SlidersHorizontal size={14} />}>
              {activeCategory ? <span className="installed-plugin-category">{activeCategory}</span> : null}
            </Button>} /> : null}
          </div>
          <FilterChips<InstalledStatus> label={t("plugins.installedFilter")} options={installedStatuses}
            value={activeStatus ? [activeStatus.value] : []} onChange={(next) => setInstalledSection(next.at(-1) ?? "all")} />
          {installedSection === "updates" && toUpdate.length > 0 && !normalizedQuery ? <Button size="sm" disabled={updateDisabled}
            icon={operation?.kind === "batch" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            onClick={() => void updateAll()}>{t("plugins.updateAll")}</Button> : null}
        </div>
        {installed.length ? <ul className="installed-plugin-list">{installed.map((group) => <StorePluginRow key={group.plugin.id}
          group={group} market={market} updates={updates} selected={group.plugin.id === selectedId}
          showEveryProject={installedSection === "all" && everyProjectIds.has(group.plugin.id)}
          updating={operation?.kind !== "dialog" && operation?.id === group.plugin.id} updateDisabled={updateDisabled}
          onUpdate={() => void updatePlugin(group.plugin)} onOpen={() => {
            if (compact) pendingFocus.current = "detail";
            onPluginChange(group.plugin.id, "installed");
          }} />)}</ul>
          : <Empty title={installedEmpty} action={!groups.length
            ? <Button icon={<Package size={14} />} onClick={() => setTab("discover")}>{t("plugins.discoverTab")}</Button> : undefined} />}
      </aside>
      <section className="installed-plugin-editor" aria-label={t("plugins.detailPane")} hidden={!showInstalledDetail}>
        {compact && showInstalledDetail ? <Button ref={detailBack} size="sm" variant="ghost" icon={<ChevronLeft size={14} />} onClick={() => {
          pendingFocus.current = "row";
          showCatalog();
        }}>{t("plugins.installedTab")}</Button> : null}
        {groups.filter(({ plugin }) => opened.has(plugin.id) || (showInstalledDetail && plugin.id === selectedId)).map((group) => <Activity
          key={group.plugin.id} mode={showInstalledDetail && group.plugin.id === selectedId ? "visible" : "hidden"}>
          <div className="installed-plugin-document">{editor(group, true)}</div>
        </Activity>)}
      </section>
    </div>
  </>;

  const pageError = error ?? everyProject.error;
  return <section ref={pageRef} className="plugins-page">
    {safeMode ? <div className="plugins-safe-mode"><Alert tone="danger" title={t("pluginSafeMode.title")} action={runtimeService
      ? <Button size="sm" onClick={() => restart(false)}>{t("pluginSafeMode.restartNormally")}</Button> : undefined}>
      {t("pluginSafeMode.hint")}
    </Alert></div> : null}
    {phase === "ready" && pageError ? <Alert tone="danger" title={pageError} /> : null}
    {page && !inInstalled ? <>
      <div className="plugins-back">
        <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={showCatalog}>{t("plugins.title")}</Button>
      </div>
      {detail
        ? editor(detail, false)
        : phase === "loading" || !market ? <PluginState>{t("plugins.loadingPlugin")}</PluginState>
          : <PluginError message={error ?? t("pluginStore.notInstalled")} onRetry={() => { readMarket(); void load(); }} />}
    </> : <>
      <SidebarPageHeader title={t("plugins.title")} actions={<div className="plugins-toolbar">
        {tab !== "installed" ? <SearchInput value={query} onChange={setQuery} placeholder={t("plugins.search")} label={t("plugins.searchLabel")} /> : null}
        <DropdownMenu placement="bottom-end" items={addMenuItems} trigger={(props) => (
          <Button {...props} variant="primary" icon={<CirclePlus size={14} />}>{t("plugins.add")}</Button>
        )} />
      </div>} />
      <Tabs<PluginsTab> variant="pills" label={t("plugins.title")} value={tab} onChange={setTab} tabs={[
        { value: "discover", label: t("plugins.discoverTab") },
        { value: "installed", label: t("plugins.installedTab"), attention: toUpdate.length ? t("plugins.updatesAvailable") : undefined },
        { value: "mine", label: t("plugins.mineTab") },
      ]} />
      <div className="plugins-panel" role="tabpanel" aria-label={t(`plugins.${tab}Tab`)}>
        {phase === "loading" ? <PluginState>{t("plugins.loading")}</PluginState> : null}
        {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
        {phase === "ready" && tab === "discover" ? discoverTab : null}
        {phase === "ready" && tab === "mine" ? mineTab : null}
        {phase === "ready" && (inInstalled || opened.size > 0) ? <Activity mode={inInstalled ? "visible" : "hidden"}>
          <div className="installed-plugin-workspace">{installedTab}</div>
        </Activity> : null}
      </div>
    </>}
    {shown && !dialog ? <MarketPluginDialog key={shown.id} plugin={shown} installed={installedIds.has(shown.id)} onClose={closePreview}
      getDisabled={installing} onGet={() => openAddDialog({ listed: shown })}
      onManage={() => { setPreview(undefined); onPluginChange(shown.id); }}
      // A keyword searches the whole market, not just the section it was opened from.
      onSearch={(keyword) => { setQuery(keyword); setMarketSection("all"); closePreview(); }} /> : null}
    {dialog ? <PluginAddDialog {...dialog} onClose={() => setOperation(undefined)} onAdded={installedFromDialog} /> : null}
  </section>;

  function showCatalog(): void {
    // Back to the tab the plugin was opened from.
    if (onTabChange) onTabChange(tab);
    else onPluginChange();
  }
}

/** Below this many, rows of one or two cards say less than a single list does. */
const SECTIONS_FROM = 12;
/** Market cards a list shows at a time, so a long one stays quick to draw and to fetch icons for. */
const LIST_PAGE = 24;
/** How often an open page picks up what the daemon's market has read. */
const MARKET_READ_MS = 2 * 60_000;

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

type AddDialogOptions = { listed?: MarketPlugin; source?: PluginAddSource; preview?: PluginAddPreview };
type InstallOperation =
  | { kind: "dialog"; options: AddDialogOptions }
  | { kind: "card"; id: string; review?: AddDialogOptions }
  | { kind: "batch"; id?: string };
type UpdateTarget = { source: PluginAddSource; listed?: MarketPlugin };

async function installIfNoNewPermissions(source: PluginAddSource): Promise<PluginAddPreview | undefined> {
  const preview = await inspectAddedPlugin(source);
  if (!preview.source || preview.newAsks?.length !== 0) return preview;
  await addPlugin(preview.source, preview.digest);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}

function updateErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "needs-app-update") return t("pluginAdd.needsAppUpdate");
    if (cause.code === "needs-plugin-update") return t("pluginAdd.needsPluginUpdate");
  }
  return errorMessage(cause);
}
