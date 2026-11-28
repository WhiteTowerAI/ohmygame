import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { PluginDraftRow, pluginDrafts, usePluginWorkspaces } from "./plugin-builder.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ChevronLeft, MoreHorizontal, Package, RefreshCw, Server, SlidersHorizontal, Sparkles, Spinner as SpinnerIcon, TriangleAlert, X } from "./icons.js";
import { Activity, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PluginMarketSourcesDialog } from "./plugin-market-sources.js";
import { type MarketPlugin, type PluginAddPreview, type PluginAddSource, type PluginContribution, type PluginMarketListing, type PluginSourceUpdate, type StorePlugin } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { addPlugin, ApiError, inspectAddedPlugin, listStorePlugins, readPluginMarket, readPluginStatus, readPluginUpdates, waitForRuntime } from "./api.js";
import { groupStorePlugins, marketUpdate, sourceUpdate, type StorePluginGroup, StorePluginRow, StorePluginDetail, storePluginEnabled, storePluginSearchText, useInstalledPluginMenu, useEveryProjectSwitch } from "./plugin-store.js";
import { MarketPluginPage } from "./plugin-catalog.js";
import { DiscoverList, DiscoverView, type DiscoverSection } from "./plugin-discover.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { settingsHash, type PluginsTab } from "./routes.js";
import { t } from "./i18n.js";
import type { TryPlugin } from "./plugin-try.js";
import { marketPluginSource, PluginAddDialog } from "./plugin-add-dialog.js";
import { Alert, Button, DropdownMenu, Empty, IconButton, SearchInput, Spinner, Tabs, type MenuEntry } from "./ui/index.js";
import "./plugins.css";

/**
 * One the person makes: made with AI, or developed from a folder. Installed
 * lists them first, with the Plugin Builder's drafts. A package added from a
 * folder or file is someone's release, so it's with the rest.
 */
const isMine = (plugin: StorePlugin) => plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`) || plugin.origin?.type === "development";

export function PluginsSettings({ pluginId, adds: initialAdds, tab: routeTab, onPluginChange, onTabChange, onTryPlugin }: {
  pluginId?: string;
  /** Opens Discover at the plugins that add this, as 更多类型… in the new-project dialog does. */
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
  // A section of Discover to scroll to, once: where a link into it points.
  const [jumpTo, setJumpTo] = useState<DiscoverSection | undefined>(initialAdds === "projectType" ? "engine" : undefined);
  const pageRef = useRef<HTMLElement>(null);
  const inventoryRef = useRef<HTMLElement>(null);
  const detailBack = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<"detail" | "row" | "search" | undefined>(undefined);
  const activeRoute = useRef<string | undefined>(pluginId);
  const [compact, setCompact] = useState(false);
  const [lastInstalledId, setLastInstalledId] = useState<string>();
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const listScroll = useRef<number | undefined>(undefined);
  // A plugin just got from Discover: its page opens on Settings when it needs a key or other setting first.
  const [justAdded, setJustAdded] = useState<string>();
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
  useEffect(() => { if (routeTab) showTab(routeTab); }, [routeTab]);
  useEffect(() => {
    if (!initialAdds) return;
    showTab("discover");
    if (initialAdds === "projectType") setJumpTo("engine");
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
      setJustAdded(id);
      void refreshInstalled().then(() => onPluginChange(id, tab === "installed" ? tab : undefined));
    }
  }

  function createWithAi(): void {
    void openPluginBuilder().catch(cause => setError(errorMessage(cause)));
  }

  const normalizedQuery = query.trim().toLowerCase();
  const groups = groupStorePlugins(store).sort((left, right) => left.plugin.displayName.localeCompare(right.plugin.displayName));
  const matching = groups.filter(({ plugin }) => !normalizedQuery || storePluginSearchText(plugin).includes(normalizedQuery));
  // What the header's ⋯ holds: ways to add that most people never need.
  const moreItems: MenuEntry[] = [
    { label: t("pluginAdd.menu"), icon: <Package size="sm" />, disabled: installing, onSelect: () => openAddDialog() },
    { label: t("plugins.addMcp"), icon: <Server size="sm" />, onSelect: () => { window.location.hash = settingsHash("connections"); } },
    ...(market && market.status !== "off" ? ["separator" as const, { label: t("pluginMarketSettings.open"), icon: <SlidersHorizontal size="sm" />, disabled: installing, onSelect: () => setMarketSettings(true) }] : []),
  ];
  // Nav counts describe the installed library and stay available while searching.
  const everyProjectIds = new Set(groups.filter(({ plugin }) => plugin.everyProject && storePluginEnabled(plugin))
    .map(({ plugin }) => plugin.id));
  const toUpdate = groups.flatMap(({ plugin }) => {
    const target = updateTarget(plugin);
    return target ? [{ plugin, target }] : [];
  });
  const updateIds = new Set(toUpdate.map(({ plugin }) => plugin.id));
  // Installed in groups: what has an update, what the person makes, then the rest, each by name.
  const workspaces = usePluginWorkspaces();
  const drafts = pluginDrafts(workspaces.sessions ?? [], new Set(groups.map(({ plugin }) => plugin.id)), normalizedQuery);
  const installedGroups = [
    { id: "updates", title: t("plugins.groupUpdates"), plugins: matching.filter(({ plugin }) => updateIds.has(plugin.id)) },
    { id: "mine", title: t("plugins.groupMine"), plugins: matching.filter(({ plugin }) => isMine(plugin) && !updateIds.has(plugin.id)) },
    { id: "others", title: t("plugins.groupOthers"), plugins: matching.filter(({ plugin }) => !isMine(plugin) && !updateIds.has(plugin.id)) },
  ].filter((group) => group.plugins.length || (group.id === "mine" && drafts.length));
  const shownInstalled = installedGroups.flatMap((group) => group.plugins);
  // One group needs no heading.
  const groupHeadings = installedGroups.length > 1;

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
  // Discover: the market in sections. A card opens the plugin's page, the same page an installed one has.
  const installedIds = new Set(groups.map(group => group.plugin.id));
  const marketPlugins = market?.plugins ?? [];
  const detail = pluginId ? groups.find(group => group.plugin.id === pluginId) : undefined;
  // A plugin that isn't installed has the same page, from what the market says about it.
  const linked = pluginId && !detail ? marketPlugins.find(plugin => plugin.id === pluginId) : undefined;
  const page = pluginId;

  const inInstalled = tab === "installed" && (!pluginId || Boolean(detail));
  // Opened from Discover, a plugin's page sits beside the list; a narrow window gives it the whole page.
  const split = Boolean(page) && !inInstalled && tab === "discover" && !compact;
  useEffect(() => {
    if (!split) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Esc closes what's on top first, and leaves a field to clear itself.
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      showCatalog();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [split, tab]);
  const installedSelection = inInstalled ? detail ?? groups.find(({ plugin }) => plugin.id === lastInstalledId) ?? shownInstalled[0] : undefined;
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
  // A plugin's page starts at its top, and the list it was opened from comes back where it was.
  const pageView = Boolean(page && !inInstalled);
  useLayoutEffect(() => {
    const scroller = pageRef.current?.closest<HTMLElement>(".sidebar-page");
    if (!scroller) return;
    if (pageView) scroller.scrollTop = 0;
    else if (listScroll.current !== undefined) {
      scroller.scrollTop = listScroll.current;
      listScroll.current = undefined;
    }
  }, [pageView, pluginId]);
  useLayoutEffect(() => {
    activeRoute.current = pluginId;
    const target = pendingFocus.current;
    if (target === "detail" && pluginId && detailBack.current) {
      detailBack.current.focus();
      pendingFocus.current = undefined;
    } else if (target && target !== "detail" && !pluginId && inventoryRef.current) {
      const row = target === "row" ? inventoryRef.current.querySelector<HTMLButtonElement>('[aria-current="true"]') : null;
      (row ?? headerSearch())?.focus({ preventScroll: true });
      pendingFocus.current = undefined;
    }
  }, [pluginId, compact, query]);

  const pluginMenu = useInstalledPluginMenu({ market, updates, everyProject, busy: updateDisabled, onChanged: reload,
    onUpdate: (plugin) => void updatePlugin(plugin),
    onRemoved: (id) => { if (activeRoute.current === id) showCatalog(); } });

  const editor = (group: StorePluginGroup, embedded: boolean) => <StorePluginDetail key={group.plugin.id} group={group}
    openOn={group.plugin.id === justAdded && needsSetup(group.plugin) ? "settings" : undefined}
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
      if (!embedded || compact) {
        if (embedded) pendingFocus.current = "search";
        showCatalog();
      } else {
        headerSearch()?.focus();
      }
    }} />;

  const discoverTab = <>
    {/* The main index may be one the person set, so where it's set is right here. */}
    {market?.status === "unavailable" || market?.status === "stale" ? <Alert tone="info" title={t(market.status === "stale" ? "plugins.marketStale" : "plugins.marketUnavailable")}
      action={<Button variant="ghost" size="sm" disabled={installing} onClick={() => setMarketSettings(true)}>{t("pluginMarketSettings.open")}</Button>} /> : null}
    {split && pluginId ? <div className="installed-plugins">
      <DiscoverList plugins={marketPlugins} installed={installedIds} query={normalizedQuery} selected={pluginId} onOpen={openPlugin} />
      <section className="installed-plugin-editor discover-open" aria-label={t("plugins.detailPane")}>
        {/* Esc closes it too: back to the cards, where they were. */}
        <IconButton className="discover-close" size="sm" label={t("common.close")} onClick={showCatalog}><X size="sm" /></IconButton>
        <div className="installed-plugin-document">{pluginPage()}</div>
      </section>
    </div>
    : marketPlugins.length ? <DiscoverView plugins={marketPlugins} installed={installedIds} query={normalizedQuery} jumpTo={jumpTo} onOpen={openPlugin} />
     : <Empty title={t("plugins.nothingToDiscover")} description={t("plugins.browseEmpty")} action={<div className="plugins-empty-actions">
      <Button disabled={installing} icon={<Package size="sm" />} onClick={() => openAddDialog()}>{t("pluginAdd.menu")}</Button>
      <Button icon={<Sparkles size="sm" />} onClick={createWithAi}>{t("plugins.createWithAi")}</Button>
      {/* With no rail to hold it, where the market is listed from is here too. */}
      {market && market.status !== "off" ? <Button variant="ghost" icon={<SlidersHorizontal size="sm" />} disabled={installing} onClick={() => setMarketSettings(true)}>{t("pluginMarketSettings.open")}</Button> : null}
    </div>} />}
  </>;

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
        {workspaces.error ? <Alert tone="danger" title={t("pluginBuilder.loadFailed", { error: workspaces.error })} /> : null}
        {installedGroups.length ? installedGroups.map((group) => <section key={group.id} className="installed-plugin-group" aria-label={group.title}>
          {groupHeadings || group.id === "updates" ? <div className="installed-plugin-group-head">
            {groupHeadings ? <h2>{group.title}</h2> : null}
            {/* Update all takes every update, so not while a search hides some. */}
            {group.id === "updates" && group.plugins.length > 1 && !normalizedQuery ? <Button size="sm" variant="ghost" disabled={updateDisabled}
              icon={operation?.kind === "batch" ? <SpinnerIcon size="sm" /> : <RefreshCw size="sm" />}
              onClick={() => void updateAll()}>{t("plugins.updateAll")}</Button> : null}
          </div> : null}
          <ul className="installed-plugin-list">
            {group.plugins.map((plugin) => <StorePluginRow key={plugin.plugin.id}
              group={plugin} market={market} updates={updates} selected={plugin.plugin.id === selectedId}
              showEveryProject={everyProjectIds.has(plugin.plugin.id)}
              updating={operation?.kind !== "dialog" && operation?.id === plugin.plugin.id} updateDisabled={updateDisabled}
              menu={pluginMenu.menuFor(plugin)}
              onUpdate={() => void updatePlugin(plugin.plugin)} onOpen={() => {
                if (compact) pendingFocus.current = "detail";
                onPluginChange(plugin.plugin.id, "installed");
              }} />)}
            {group.id === "mine" ? drafts.map((session) => <PluginDraftRow key={session.id} session={session}
              onDeleted={() => workspaces.removed(session.id)} onError={(cause) => setError(errorMessage(cause))} />) : null}
          </ul>
        </section>)
          : <Empty title={groups.length || workspaces.sessions?.length ? t("plugins.noMatch") : t("plugins.noneInstalled")} action={!groups.length
            ? <Button icon={<Package size="sm" />} onClick={() => setTab("discover")}>{t("plugins.discoverTab")}</Button> : undefined} />}
      </aside>
      <section className="installed-plugin-editor" aria-label={t("plugins.detailPane")} hidden={!showInstalledDetail}>
        {compact && showInstalledDetail ? <Button ref={detailBack} size="sm" variant="ghost" icon={<ChevronLeft size="sm" />} onClick={() => {
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

  const pageError = error ?? everyProject.error ?? pluginMenu.error;
  return <section ref={pageRef} className="plugins-page">
    {safeMode ? <div className="plugins-safe-mode"><Alert tone="danger" title={t("pluginSafeMode.title")} action={runtimeService
      ? <Button size="sm" onClick={() => restart(false)}>{t("pluginSafeMode.restartNormally")}</Button> : undefined}>
      {t("pluginSafeMode.hint")}
    </Alert></div> : null}
    {phase === "ready" && pageError ? <Alert tone="danger" title={pageError} /> : null}
    {page && !inInstalled && !split ? <>
      <div className="plugins-back">
        <Button variant="ghost" icon={<ChevronLeft size="sm" />} onClick={showCatalog}>{t("plugins.title")}</Button>
      </div>
      {pluginPage()}
    </> : <>
      <SidebarPageHeader title={t("plugins.title")} actions={<div className="plugins-toolbar">
        {/* One search for whichever tab is open. */}
        <SearchInput value={query} onChange={setQuery} placeholder={t(tab === "installed" ? "plugins.searchInstalled" : "plugins.search")} label={t("plugins.searchLabel")} />
        <Button icon={<Sparkles size="sm" />} onClick={createWithAi}>{t("plugins.newPlugin")}</Button>
        <DropdownMenu placement="bottom-end" items={moreItems} trigger={(props) => (
          <IconButton {...props} label={t("plugins.moreActions")}><MoreHorizontal size="md" /></IconButton>
        )} />
      </div>} />
      <Tabs<PluginsTab> variant="pills" label={t("plugins.title")} value={tab} onChange={setTab} tabs={[
        { value: "discover", label: t("plugins.discoverTab") },
        { value: "installed", label: t("plugins.installedTab"), attention: toUpdate.length ? t("plugins.updatesAvailable") : undefined },
      ]} />
      <div className="plugins-panel" role="tabpanel" aria-label={t(`plugins.${tab}Tab`)}>
        {/* An open plugin's page says itself when it's loading, and keeps what's typed in it while the service reconnects. */}
        {split ? discoverTab : <>
          {phase === "loading" ? <PluginState>{t("plugins.loading")}</PluginState> : null}
          {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
          {phase === "ready" && tab === "discover" ? discoverTab : null}
        </>}
        {phase === "ready" && (inInstalled || opened.size > 0) ? <Activity mode={inInstalled ? "visible" : "hidden"}>
          <div className="installed-plugin-workspace">{installedTab}</div>
        </Activity> : null}
      </div>
    </>}
    {pluginMenu.dialogs}
    {marketSettings ? <PluginMarketSourcesDialog sources={market?.sources} onClose={() => setMarketSettings(false)} onSaved={readMarket} /> : null}
    {dialog ? <PluginAddDialog {...dialog} onClose={() => setOperation(undefined)} onAdded={installedFromDialog} /> : null}
  </section>;

  function headerSearch(): HTMLInputElement | null | undefined {
    return pageRef.current?.querySelector<HTMLInputElement>('.plugins-toolbar input[type="search"]');
  }

  /** The open plugin's page, installed or not. */
  function pluginPage(): ReactNode {
    return detail
      ? editor(detail, false)
      : linked ? <MarketPluginPage key={linked.id} plugin={linked} getDisabled={installing} onGet={() => openAddDialog({ listed: linked })}
        // A keyword searches the whole market, not just the section it was opened from.
        onSearch={(keyword) => { setQuery(keyword); listScroll.current = 0; showDiscover(); }} />
      : phase === "loading" || !market ? <PluginState>{t("plugins.loadingPlugin")}</PluginState>
        : <PluginError message={error ?? t("pluginStore.notInstalled")} onRetry={() => { readMarket(); void load(); }} />;
  }

  function openPlugin(id: string): void {
    // Where the cards were, to come back to; going from one plugin to the next keeps it.
    if (!pluginId) listScroll.current = pageRef.current?.closest<HTMLElement>(".sidebar-page")?.scrollTop;
    onPluginChange(id);
  }

  function showDiscover(): void {
    showTab("discover");
    if (onTabChange) onTabChange("discover");
    else onPluginChange();
  }

  function showCatalog(): void {
    // Back to the tab the plugin was opened from.
    if (onTabChange) onTabChange(tab);
    else onPluginChange();
  }
}

/** Whether a plugin asks for something before it works: a key, or a setting it can't do without. */
function needsSetup(plugin: StorePlugin): boolean {
  return plugin.adds.modelProviders.length > 0 || plugin.settings.some((field) => field.required || field.type === "secret");
}

/** How often an open page picks up what the daemon's market has read. */
const MARKET_READ_MS = 2 * 60_000;

function PluginState({ children }: { children: ReactNode }): ReactNode {
  return <div className="plugins-state"><Spinner size={14} label={typeof children === "string" ? children : undefined} />{children}</div>;
}

/** The page couldn't load: the same failed state as Community's and Projects'. */
function PluginError({ message, onRetry }: { message?: string; onRetry: () => void }): ReactNode {
  return <div className="plugins-error-state">
    <Empty fill tone="error" icon={<TriangleAlert size="md" />} title={message ?? t("common.somethingWrong")}
      action={<Button onClick={onRetry}>{t("common.retry")}</Button>} />
  </div>;
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
