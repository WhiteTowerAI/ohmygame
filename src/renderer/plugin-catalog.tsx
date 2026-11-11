import { useEffect, useState, type ReactNode } from "react";
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { OHMYGAME_PUBLISHER, PLUGIN_CATEGORIES, type PluginCategory } from "../shared/plugin-manifest.js";
import type { MarketPlugin } from "../shared/plugins.js";
import { readPluginMarketImage } from "./api.js";
import { language, t } from "./i18n.js";
import { ExternalLink } from "./icons.js";
import { PluginMonogram } from "./plugin-icons.js";
import { PluginMarks } from "./plugin-marks.js";
import { PluginCapabilityList } from "./plugin-consent-dialog.js";
import { PluginAddsList, type PluginAddRow } from "./plugin-summary.js";
import { projectTypeLabel } from "./project-types.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Button, Dialog, FilterChips, Select } from "./ui/index.js";

// What the Plugins page browses by: the categories plugins name, how the
// market is sorted, and the market's cards and pages. A plugin may name up to
// three categories; it shows under each when one is picked, and under its
// first in the sections of the unfiltered page.

/** A plugin's categories that this app knows, and `other` for one that names none of them. */
export type CatalogCategory = PluginCategory | "other";
export const CATALOG_CATEGORIES: readonly CatalogCategory[] = [...PLUGIN_CATEGORIES, "other"];
export type CatalogFilter = CatalogCategory | "all";

const known = (categories: readonly string[] | undefined) =>
  (categories ?? []).filter((category): category is PluginCategory => (PLUGIN_CATEGORIES as readonly string[]).includes(category));

/** The section a plugin is listed in. */
export function catalogSection(categories: readonly string[] | undefined): CatalogCategory {
  return known(categories)[0] ?? "other";
}

export function inCatalogCategory(categories: readonly string[] | undefined, filter: CatalogFilter): boolean {
  if (filter === "all") return true;
  const named = known(categories);
  return filter === "other" ? !named.length : named.includes(filter);
}

export const categoryLabel = (category: CatalogCategory) => t(`pluginCatalog.categories.${category}`);

/** The categories to pick from: those some plugin here is in, with how many, and the one picked even when none are. */
export function CategoryChips({ items, value, onChange }: {
  items: readonly (readonly string[] | undefined)[];
  value: CatalogFilter;
  onChange: (value: CatalogFilter) => void;
}): ReactNode {
  // Only categories something here is in, so no chip leads to an empty list; no counts, as on the tabs.
  const options = CATALOG_CATEGORIES.filter((category) => category === value || items.some((categories) => inCatalogCategory(categories, category)))
    .map((category) => ({ value: category as CatalogFilter, label: categoryLabel(category) }));
  return <FilterChips<CatalogFilter> label={t("pluginCatalog.categoriesLabel")}
    options={[{ value: "all", label: t("pluginCatalog.all") }, ...options]}
    value={[value]}
    // A chip turns the others off; turning the picked one off shows everything again.
    onChange={(next) => onChange(next.find((item) => item !== value) ?? "all")} />;
}

export type MarketSort = "recommended" | "downloads" | "updated" | "name";
const MARKET_SORTS: readonly MarketSort[] = ["recommended", "downloads", "updated", "name"];

/** The market in an order; `recommended` keeps the daemon's: featured first, then by downloads. */
export function sortMarket(plugins: readonly MarketPlugin[], sort: MarketSort): MarketPlugin[] {
  const sorted = [...plugins];
  if (sort === "downloads") sorted.sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0));
  if (sort === "updated") sorted.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  if (sort === "name") sorted.sort((a, b) => a.displayName.localeCompare(b.displayName, language));
  return sorted;
}

/** Cards in a row of the market's front page: two lines of the grid, three for Popular. */
const FRONT_ROW = 4;
const FRONT_POPULAR = 6;
/** Category rows on the front page; the chips above reach the rest. */
const FRONT_CATEGORIES = 6;

export interface MarketFront {
  featured: MarketPlugin[];
  popular: MarketPlugin[];
  recent: MarketPlugin[];
  categories: { category: PluginCategory; plugins: MarketPlugin[]; total: number }[];
}

/**
 * The market's front page, a few cards a row however many plugins there are:
 * featured, the most downloaded, the latest updated, then the categories most
 * used. Each plugin shows once, in the first row that takes it.
 */
export function marketFront(plugins: readonly MarketPlugin[]): MarketFront {
  const shown = new Set<string>();
  const take = (list: readonly MarketPlugin[], count: number) => {
    const picked = list.filter((plugin) => !shown.has(plugin.id)).slice(0, count);
    for (const plugin of picked) shown.add(plugin.id);
    return picked;
  };
  const featured = take(plugins.filter((plugin) => plugin.featured), FRONT_ROW);
  const popular = take(sortMarket(plugins.filter((plugin) => plugin.weeklyDownloads), "downloads"), FRONT_POPULAR);
  const recent = take(sortMarket(plugins.filter((plugin) => plugin.publishedAt), "updated"), FRONT_ROW);
  const used = (list: readonly MarketPlugin[]) => list.reduce((sum, plugin) => sum + (plugin.weeklyDownloads ?? 0), 0);
  const categories = PLUGIN_CATEGORIES
    .map((category) => ({ category, all: plugins.filter((plugin) => catalogSection(plugin.categories) === category) }))
    .sort((a, b) => used(b.all) - used(a.all))
    .flatMap(({ category, all }) => {
      const rest = all.filter((plugin) => !shown.has(plugin.id));
      // A row of one says less than the chip does.
      // View all opens the category, which also lists plugins that name it second.
      return rest.length > 1 ? [{ category, rest, total: plugins.filter((plugin) => inCatalogCategory(plugin.categories, category)).length }] : [];
    })
    .slice(0, FRONT_CATEGORIES)
    .map(({ category, rest, total }) => ({ category, plugins: take(sortMarket(rest, "downloads"), FRONT_ROW), total }));
  return { featured, popular, recent, categories };
}

export function MarketSortSelect({ value, onChange }: { value: MarketSort; onChange: (value: MarketSort) => void }): ReactNode {
  return <Select<MarketSort> size="sm" label={t("pluginCatalog.sortLabel")} value={value} onChange={onChange}
    options={MARKET_SORTS.map((sort) => ({ value: sort, label: t(`pluginCatalog.sort.${sort}`) }))} />;
}

/** Published by OhMyGame: npm lets only its members publish to the scope. */
export const isOfficialPlugin = (id: string) => id.startsWith(`${OHMYGAME_PUBLISHER}/`);

function publisherName(plugin: MarketPlugin): string {
  return isOfficialPlugin(plugin.id) ? t("plugins.officialSource") : `@${plugin.id.slice(0, plugin.id.indexOf("/"))}`;
}

/**
 * Images the market lists, read through the daemon, as addresses an `img` can
 * show: undefined while reading, null for one that can't be read.
 */
function useMarketImages(paths: readonly (string | undefined)[]): (string | null | undefined)[] {
  const generation = useReadyRuntimeGeneration();
  const [urls, setUrls] = useState<(string | null | undefined)[]>([]);
  const key = paths.join("\n");
  useEffect(() => {
    setUrls([]);
    const controller = new AbortController();
    const made: string[] = [];
    void Promise.all(paths.map((path) => path
      ? readPluginMarketImage(path, controller.signal).then((blob) => {
        const url = URL.createObjectURL(blob);
        made.push(url);
        return url;
      }, () => null)
      : null))
      .then((next) => { if (!controller.signal.aborted) setUrls(next); });
    return () => {
      controller.abort();
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [key, generation]);
  return urls;
}

/** A market plugin's icon, which the index copied out of its package, or its first letter. */
function MarketTile({ plugin, large = false }: { plugin: MarketPlugin; large?: boolean }): ReactNode {
  const [icon] = useMarketImages([plugin.icon]);
  const size = large ? 40 : 24;
  return <span className={`plugin-tile${large ? " plugin-tile-large" : ""}`}>
    {icon ? <img src={icon} width={size} height={size} alt="" aria-hidden="true" className="plugin-icon-image" />
      // While its icon loads the tile stays empty, rather than flashing a letter.
      : icon === undefined && plugin.icon ? null : <PluginMonogram id={plugin.id} name={plugin.displayName} size={size} />}
  </span>;
}

function MarketBadges({ plugin }: { plugin: MarketPlugin }): ReactNode {
  return <PluginMarks official={isOfficialPlugin(plugin.id)} marks={[plugin.beta && "beta"]} />;
}

/** A plugin on the market. Opening it shows it in a dialog; Get reviews the package to add it. */
export function MarketPluginCard({ plugin, installed = false, onOpen, onGet }: {
  plugin: MarketPlugin;
  installed?: boolean;
  onOpen: () => void;
  onGet: () => void;
}): ReactNode {
  const compact = new Intl.NumberFormat(language, { notation: "compact" });
  const section = catalogSection(plugin.categories);
  return <article className="plugin-card">
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <MarketTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          <MarketBadges plugin={plugin} />
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{publisherName(plugin)}</span>
          {section !== "other" ? <span className="plugins-tag">{categoryLabel(section)}</span> : null}
          {plugin.weeklyDownloads ? <span className="plugins-tag">{t("plugins.weeklyDownloads", { count: compact.format(plugin.weeklyDownloads) })}</span> : null}
        </span>
      </span>
    </button>
    {installed ? <span className="plugins-installed-label">{t("plugins.installed")}</span>
      : <Button size="sm" onClick={onGet} aria-label={t("pluginCatalog.getName", { name: plugin.displayName })}>{t("pluginCatalog.get")}</Button>}
  </article>;
}

/** Screenshots in a row that scrolls; one opens larger. */
export function PluginScreenshots({ shots }: { shots: readonly { src: string; caption?: string }[] }): ReactNode {
  const [open, setOpen] = useState<number>();
  const shown = open === undefined ? undefined : shots[open];
  if (!shots.length) return null;
  return <section className="plugin-shots" aria-label={t("pluginCatalog.screenshots")}>
    <div className="plugin-shots-row">
      {shots.map((shot, index) => <figure key={`${index}:${shot.src}`} className="plugin-shot">
        <button type="button" onClick={() => setOpen(index)} aria-label={shot.caption ?? t("pluginCatalog.screenshotNumber", { number: index + 1 })}>
          <img src={shot.src} alt="" loading="lazy" />
        </button>
        {shot.caption ? <figcaption>{shot.caption}</figcaption> : null}
      </figure>)}
    </div>
    <Dialog open={Boolean(shown)} size="lg" onClose={() => setOpen(undefined)}
      title={shown?.caption ?? t("pluginCatalog.screenshotNumber", { number: (open ?? 0) + 1 })}>
      {shown ? <img className="plugin-shot-large" src={shown.src} alt="" /> : null}
    </Dialog>
  </section>;
}

/** The project types a plugin names that this app has, by their names here. */
export function appliesToLabels(appliesTo: readonly string[] | undefined): string[] {
  return (appliesTo ?? []).map((type) => (PROJECT_TYPE_IDS as readonly string[]).includes(type) ? projectTypeLabel(type as ProjectType) : type);
}

/** What a market plugin adds, by how many of each; kinds this app doesn't know are left out. */
function marketAddRows(adds: Record<string, number>): PluginAddRow[] {
  const labels: Record<string, string> = {
    projectTypes: t("pluginStore.addsType"),
    panels: t("pluginStore.addsPanel"),
    commands: t("pluginStore.addsCommand"),
    mcpServers: t("pluginStore.addsMcpServer"),
    providers: t("pluginStore.addsModelProvider"),
    agents: t("pluginStore.addsAgent"),
    tools: t("pluginStore.tools"),
    skills: t("plugins.skills"),
    themes: t("pluginCatalog.adds.themes"),
    canvasNodes: t("pluginCatalog.adds.canvasNodes"),
    canvasPresets: t("pluginCatalog.adds.canvasPresets"),
    previewDevices: t("pluginCatalog.adds.previewDevices"),
    previewFilters: t("pluginCatalog.adds.previewFilters"),
    inputMaps: t("pluginCatalog.adds.inputMaps"),
  };
  return Object.entries(labels).flatMap(([key, kind]) => (adds[key] ? [{ id: key, kind, title: String(adds[key]) }] : []));
}

/** A plugin on the market, over the list it was opened from: what the index says about it. */
export function MarketPluginDialog({ plugin, installed, onClose, onGet, onManage }: {
  plugin: MarketPlugin;
  installed: boolean;
  onClose: () => void;
  onGet: () => void;
  /** Opens the installed plugin's own page. */
  onManage: () => void;
}): ReactNode {
  const compact = new Intl.NumberFormat(language, { notation: "compact" });
  const rows = marketAddRows(plugin.adds);
  const categories = known(plugin.categories);
  const worksWith = appliesToLabels(plugin.appliesTo);
  const updated = plugin.publishedAt ? new Date(plugin.publishedAt) : undefined;
  const shots = useMarketImages((plugin.screenshots ?? []).map((shot) => shot.path));
  return <Dialog open size="lg" onClose={onClose}
    title={<span className="plugin-dialog-title">{plugin.displayName}<MarketBadges plugin={plugin} /></span>}>
    <div className="plugin-dialog">
      <div className="plugin-dialog-head">
        <MarketTile plugin={plugin} large />
        <div className="plugin-dialog-summary">
          <p>{plugin.description}</p>
          <span className="plugins-meta">
            <span>{publisherName(plugin)}</span>
            {plugin.weeklyDownloads ? <span className="plugins-tag">{t("plugins.weeklyDownloads", { count: compact.format(plugin.weeklyDownloads) })}</span> : null}
          </span>
        </div>
        {installed ? <Button onClick={onManage}>{t("pluginCatalog.manage")}</Button>
          : <Button variant="primary" onClick={onGet}>{t("pluginCatalog.get")}</Button>}
      </div>
      <PluginScreenshots shots={(plugin.screenshots ?? []).flatMap((shot, index) => {
        const src = shots[index];
        return src ? [{ src, ...(shot.caption ? { caption: shot.caption } : {}) }] : [];
      })} />
      {plugin.longDescription ? <p className="plugin-long">{plugin.longDescription}</p> : null}
      {rows.length ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
        <h2>{t("pluginStore.adds")}</h2>
        <PluginAddsList rows={rows} />
      </section> : null}
      <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
        <h2>{t("pluginStore.asksFor")}</h2>
        {plugin.asks.length ? <PluginCapabilityList capabilities={plugin.asks} /> : <p className="plugins-note">{t("pluginCatalog.asksNothing")}</p>}
      </section>
      <section className="plugins-section" aria-label={t("pluginCatalog.information")}>
        <h2>{t("pluginCatalog.information")}</h2>
        <dl className="plugin-props plugin-dialog-props">
          <dt>{t("pluginCatalog.publisher")}</dt>
          <dd>{publisherName(plugin)}</dd>
          <dt>{t("plugins.version")}</dt>
          <dd className="plugins-mono">v{plugin.version}</dd>
          {updated && !Number.isNaN(updated.getTime()) ? <><dt>{t("pluginCatalog.updated")}</dt><dd>{updated.toLocaleDateString(language)}</dd></> : null}
          <dt>{t("pluginStore.npmPackage")}</dt>
          <dd><a href={`https://www.npmjs.com/package/${plugin.package}`} target="_blank" rel="noreferrer">{plugin.package}<ExternalLink size={11} /></a></dd>
          {plugin.repository ? <><dt>{t("plugins.repository")}</dt><dd>
            <a href={plugin.repository} target="_blank" rel="noreferrer">{plugin.repository.replace("https://github.com/", "")}<ExternalLink size={11} /></a>
            <span className="plugins-note">{t(plugin.sourceVerified ? "plugins.sourceVerified" : "plugins.sourceUnverified")}</span>
          </dd></> : null}
          {plugin.stars !== undefined ? <><dt>{t("pluginCatalog.stars")}</dt><dd>★ {compact.format(plugin.stars)}</dd></> : null}
          {categories.length ? <><dt>{t("pluginCatalog.categoriesLabel")}</dt><dd>{categories.map(categoryLabel).join(" · ")}</dd></> : null}
          <dt>{t("pluginCatalog.worksWith")}</dt>
          <dd>{worksWith.length ? worksWith.join(" · ") : t("pluginCatalog.everyType")}</dd>
        </dl>
      </section>
    </div>
  </Dialog>;
}
