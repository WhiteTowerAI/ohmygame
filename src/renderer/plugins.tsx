import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { PluginBuilderSessions } from "./plugin-builder.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ChevronLeft, CirclePlus, Package, Server, Sparkles, Store } from "./icons.js";
import { useEffect, useState, type ReactNode } from "react";
import { type MarketPlugin, type PluginContribution, PLUGIN_CONTRIBUTIONS, type PluginMarketListing, type StorePlugin } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { listStorePlugins, readPluginMarket, setStorePluginEnabled, waitForRuntime } from "./api.js";
import { groupStorePlugins, marketContributions, MarketPluginCard, type StorePluginGroup, StorePluginBrowseCard, StorePluginCard, storePluginContributions, StorePluginDetail, storePluginSearchText, StoreSkillCard } from "./plugin-store.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { settingsHash } from "./routes.js";
import { t } from "./i18n.js";
import type { TryPlugin } from "./plugin-try.js";
import { PluginAddDialog } from "./plugin-add-dialog.js";
import { Alert, Button, DropdownMenu, Empty, SearchInput, Select, Spinner, Tabs, type MenuEntry } from "./ui/index.js";
import "./plugins.css";

/** The page's groups, by the categories a plugin declares. */
const PLUGIN_GROUPS = [
  { id: "creation", categories: ["workflow"] },
  { id: "engines", categories: ["engine", "publishing"] },
  { id: "assets", categories: ["art", "audio"] },
  { id: "other", categories: [] },
] as const;

type CatalogTab = "installed" | "browse" | "skills";
type BrowseSource = "all" | "public" | "personal";

function storePluginGroup(plugin: StorePlugin) {
  return PLUGIN_GROUPS.find(group => group.categories.some(category => plugin.categories?.includes(category)))?.id ?? "other";
}

/** A plugin the person made themselves. */
const madeByPerson = (plugin: StorePlugin) => plugin.id.startsWith(`${PERSONAL_PUBLISHER}/`);

export function PluginsSettings({ pluginId, adds: initialAdds, onPluginChange, onTryPlugin }: {
  pluginId?: string;
  /** Opens the marketplace filtered to plugins that add this, as 更多类型… in the new-project dialog does. */
  adds?: PluginContribution;
  onPluginChange: (pluginId?: string) => void;
  onTryPlugin: TryPlugin;
}) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [store, setStore] = useState<StorePlugin[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [addOpen, setAddOpen] = useState(false);
  const [market, setMarket] = useState<PluginMarketListing>();
  const [adding, setAdding] = useState<MarketPlugin>();
  const [tab, setTab] = useState<CatalogTab>(initialAdds ? "browse" : "installed");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<BrowseSource>("all");
  const [adds, setAdds] = useState<PluginContribution | "all">(initialAdds ?? "all");
  useEffect(() => {
    if (!initialAdds) return;
    setTab("browse");
    setAdds(initialAdds);
  }, [initialAdds]);
  const [updating, setUpdating] = useState<string>();
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

  async function togglePlugin(id: string, enabled: boolean): Promise<void> {
    if (updating) return;
    setUpdating(id);
    setError(undefined);
    try {
      await setStorePluginEnabled(id, enabled);
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  useEffect(() => { void load(); }, [serviceGeneration]);
  // The page works without the market, so it neither waits for it nor reports it failing.
  useEffect(() => {
    void waitForRuntime().then(readPluginMarket).then(setMarket, () => setMarket(undefined));
  }, [serviceGeneration]);

  function createWithAi(): void {
    void openPluginBuilder().catch(cause => setError(errorMessage(cause)));
  }

  const normalizedQuery = query.trim().toLowerCase();
  const groups = groupStorePlugins(store);
  const matching = groups.filter(group => storePluginSearchText(group.plugin).includes(normalizedQuery))
    .sort((left, right) => left.plugin.displayName.localeCompare(right.plugin.displayName));
  const card = (group: StorePluginGroup) => <StorePluginCard key={group.plugin.id} group={group} market={market} disabled={Boolean(updating)}
    onToggle={enabled => void togglePlugin(group.plugin.id, enabled)} onOpen={() => onPluginChange(group.plugin.id)} />;
  const appWide = matching.filter(({ plugin }) => plugin.appWide && !madeByPerson(plugin));
  const perProject = matching.filter(({ plugin }) => !plugin.appWide && !madeByPerson(plugin));
  const made = matching.filter(({ plugin }) => madeByPerson(plugin));
  const perProjectSection = perProject.length ? <section className="plugins-section" aria-label={t("pluginStore.section")}>
    <h2>{t("pluginStore.section")} <span className="plugins-count">{perProject.length}</span></h2>
    <div className="plugins-grid">{perProject.map(card)}</div>
  </section> : null;
  // Only categories some plugin falls in, so no choice leads to an empty page.
  const installedIds = new Set(groups.map(group => group.plugin.id));
  const onMarket = (market?.plugins ?? []).filter(plugin => !installedIds.has(plugin.id));
  const categories = PLUGIN_CONTRIBUTIONS.filter(kind => kind === adds || groups.some(group => storePluginContributions(group.plugin).includes(kind)) || onMarket.some(plugin => marketContributions(plugin).includes(kind)));
  const browsed = matching.filter(({ plugin }) => (source === "all" || (plugin.bundled || plugin.preinstalled ? "public" : "personal") === source)
    && (adds === "all" || storePluginContributions(plugin).includes(adds)));
  const listed = source === "public" ? [] : onMarket.filter(plugin => `${plugin.displayName} ${plugin.description} ${plugin.id} ${plugin.package}`.toLowerCase().includes(normalizedQuery)
    && (adds === "all" || marketContributions(plugin).includes(adds)));
  const marketCards = (plugins: MarketPlugin[]) => <div className="plugins-grid">
    {plugins.map(plugin => <MarketPluginCard key={plugin.id} plugin={plugin} onOpen={() => setAdding(plugin)} />)}
  </div>;
  const skills = groups.flatMap(({ plugin }) => plugin.skills.map(skill => ({ plugin, skill })));
  const visibleSkills = skills.filter(({ plugin, skill }) => `${skill.name} ${skill.description} ${plugin.displayName}`.toLowerCase().includes(normalizedQuery));
  const addMenuItems: MenuEntry[] = [
    { label: t("plugins.browseMarket"), icon: <Store size={14} />, onSelect: () => setTab("browse") },
    { label: t("plugins.createWithAiMenu"), icon: <Sparkles size={14} />, onSelect: createWithAi },
    { label: t("plugins.addMcp"), icon: <Server size={14} />, onSelect: () => { window.location.hash = settingsHash("connections"); } },
    "separator",
    { label: t("pluginAdd.menu"), icon: <Package size={14} />, onSelect: () => setAddOpen(true) },
  ];
  const searchCopy = tab === "skills"
    ? { placeholder: t("plugins.searchSkills"), label: t("plugins.searchSkillsLabel") }
    : { placeholder: t("plugins.search"), label: t("plugins.searchLabel") };
  const createCard = (kind: "plugin" | "skill") => <button type="button" className="plugin-card plugin-card-create" onClick={createWithAi}>
    <span className="plugin-tile"><Sparkles size={18} /></span>
    <span className="plugin-card-text">
      <strong>{kind === "skill" ? t("plugins.createSkillWithAi") : t("plugins.createPluginWithAi")}</strong>
      <small>{t("plugins.createWithAiHint")}</small>
    </span>
  </button>;

  const installedTab = normalizedQuery ? (
    matching.length ? <>
      {appWide.length || made.length ? <div className="plugins-grid">{[...appWide, ...made].map(card)}</div> : null}
      {perProjectSection}
    </> : <Empty title={t("plugins.noMatch")} />
  ) : <>
    {PLUGIN_GROUPS.map(group => ({ id: group.id, plugins: appWide.filter(({ plugin }) => storePluginGroup(plugin) === group.id) }))
      .filter(group => group.plugins.length)
      .map(group => <PluginGroup key={group.id} title={t(`plugins.categories.${group.id}`)} cards={group.plugins.map(card)} />)}
    {perProjectSection}
    <section className="plugins-section" aria-label={t("plugins.personal")}>
      <h2>{t("plugins.personal")} <span className="plugins-count">{made.length}</span></h2>
      <div className="plugins-grid">
        {made.map(card)}
        {createCard("plugin")}
      </div>
    </section>
    <PluginBuilderSessions />
  </>;

  const browsedCards = <div className="plugins-grid">
    {browsed.map(group => <StorePluginBrowseCard key={group.plugin.id} group={group} onOpen={() => onPluginChange(group.plugin.id)} />)}
  </div>;
  const browseTab = <>
    <div className="plugins-filters">
      <Select<BrowseSource> size="sm" label={t("plugins.sourceFilter")} value={source} onChange={setSource} options={[
        { value: "all", label: t("plugins.allSources") },
        { value: "public", label: t("plugins.officialSource") },
        { value: "personal", label: t("plugins.otherSources") },
      ]} />
      <Select<PluginContribution | "all"> size="sm" label={t("plugins.addsFilter")} value={adds} onChange={setAdds} options={[
        { value: "all", label: t("plugins.allContributions") },
        ...categories.map(kind => ({ value: kind, label: t(`plugins.contributions.${kind}`) })),
      ]} />
    </div>
    {market?.status === "unavailable" ? <Alert tone="info" title={t("plugins.marketUnavailable")} /> : null}
    {market?.status === "stale" ? <Alert tone="info" title={t("plugins.marketStale")} /> : null}
    {listed.some(plugin => plugin.featured) ? <section className="plugins-section" aria-label={t("plugins.marketFeatured")}>
      <h2>{t("plugins.marketFeatured")}</h2>
      {marketCards(listed.filter(plugin => plugin.featured))}
    </section> : null}
    {listed.some(plugin => !plugin.featured) ? <section className="plugins-section" aria-label={t("plugins.marketListed")}>
      <h2>{t("plugins.marketListed")}</h2>
      {marketCards(listed.filter(plugin => !plugin.featured))}
    </section> : null}
    {browsed.length ? listed.length ? <section className="plugins-section" aria-label={t("plugins.installed")}>
      <h2>{t("plugins.installed")}</h2>
      {browsedCards}
    </section> : browsedCards : listed.length ? null : <Empty title={t("plugins.noMatch")} description={t("plugins.browseEmpty")} action={<div className="plugins-empty-actions">
      <Button icon={<Package size={14} />} onClick={() => setAddOpen(true)}>{t("pluginAdd.menu")}</Button>
      <Button icon={<Sparkles size={14} />} onClick={createWithAi}>{t("plugins.createWithAi")}</Button>
    </div>} />}
  </>;

  const skillCard = ({ plugin, skill }: typeof skills[number]) =>
    <StoreSkillCard key={`${plugin.id}:${skill.id}`} plugin={plugin} skill={skill} onOpen={() => onPluginChange(plugin.id)} />;
  const pluginSkills = visibleSkills.filter(entry => !madeByPerson(entry.plugin));
  const personalSkills = visibleSkills.filter(entry => madeByPerson(entry.plugin));
  const skillsTab = normalizedQuery && !visibleSkills.length ? <Empty title={t("plugins.noMatchingSkills")} /> : <>
    {pluginSkills.length ? <section className="plugins-section" aria-label={t("plugins.fromPlugins")}>
      <h2>{t("plugins.fromPlugins")} <span className="plugins-count">{pluginSkills.length}</span></h2>
      <div className="plugins-grid">{pluginSkills.map(skillCard)}</div>
    </section> : null}
    <section className="plugins-section" aria-label={t("plugins.personal")}>
      <h2>{t("plugins.personal")} <span className="plugins-count">{personalSkills.length}</span></h2>
      <div className="plugins-grid">
        {personalSkills.map(skillCard)}
        {createCard("skill")}
      </div>
    </section>
  </>;

  const detail = pluginId ? groups.find(group => group.plugin.id === pluginId) : undefined;

  return <section className="plugins-page">
    {pluginId ? <>
      <div className="plugins-back">
        <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={showCatalog}>{t("plugins.title")}</Button>
      </div>
      {detail
        ? <StorePluginDetail key={pluginId} group={detail} market={market} onUpdate={setAdding} onChanged={reload} onRemoved={showCatalog} onTry={onTryPlugin} />
        : phase === "loading" ? <PluginState>{t("plugins.loadingPlugin")}</PluginState>
          : <PluginError message={error ?? t("pluginStore.notInstalled")} onRetry={() => void load()} />}
    </> : <>
      <SidebarPageHeader title={t("plugins.title")} actions={<div className="plugins-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder={searchCopy.placeholder} label={searchCopy.label} />
        <DropdownMenu placement="bottom-end" items={addMenuItems} trigger={(props) => (
          <Button {...props} variant="primary" icon={<CirclePlus size={14} />}>{t("plugins.add")}</Button>
        )} />
      </div>} />
      <Tabs<CatalogTab> variant="pills" label={t("plugins.title")} value={tab} onChange={setTab} tabs={[
        { value: "installed", label: t("plugins.installedTab"), count: phase === "ready" ? groups.length : undefined },
        { value: "browse", label: t("plugins.browseTab") },
        { value: "skills", label: t("plugins.skills"), count: phase === "ready" ? skills.length : undefined },
      ]} />
      <div className="plugins-panel" role="tabpanel" aria-label={tab === "installed" ? t("plugins.installedTab") : tab === "browse" ? t("plugins.browseTab") : t("plugins.skills")}>
        {phase === "ready" && error ? <Alert tone="danger" title={error} /> : null}
        {phase === "loading" ? <PluginState>{t("plugins.loading")}</PluginState> : null}
        {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
        {phase === "ready" ? tab === "browse" ? browseTab : tab === "skills" ? skillsTab : installedTab : null}
      </div>
    </>}
    {addOpen ? <PluginAddDialog onClose={() => setAddOpen(false)} onAdded={(id) => { setAddOpen(false); void reload().then(() => onPluginChange(id)); }} /> : null}
    {adding ? <PluginAddDialog key={adding.id} listed={adding} onClose={() => setAdding(undefined)} onAdded={(id) => { setAdding(undefined); void reload().then(() => onPluginChange(id)); }} /> : null}
  </section>;

  function showCatalog(): void {
    onPluginChange();
  }
}

const INSTALLED_PLUGIN_LIMIT = 6;

/** A category of installed plugins: its first six cards, and the rest behind View all. */
function PluginGroup({ title, cards }: { title: string; cards: ReactNode[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const limited = !expanded && cards.length > INSTALLED_PLUGIN_LIMIT;
  return <section className="plugins-section" aria-label={title}>
    <h2>{title} <span className="plugins-count">{cards.length}</span></h2>
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
