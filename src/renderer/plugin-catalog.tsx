import { useEffect, useState, type ReactNode } from "react";
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { OHMYGAME_PUBLISHER, PLUGIN_CATEGORIES, type PluginCategory } from "../shared/plugin-manifest.js";
import type { MarketPlugin } from "../shared/plugins.js";
import { PLUGIN_PROJECT_KINDS } from "../shared/project-runtime.js";
import { readPluginMarketAvatar, readPluginMarketImage } from "./api.js";
import { language, t } from "./i18n.js";
import { ExternalLink } from "./icons.js";
import { PluginMonogram } from "./plugin-icons.js";
import { formatBytes } from "./format-bytes.js";
import { PluginMarks } from "./plugin-marks.js";
import { PluginCapabilityList } from "./plugin-consent-dialog.js";
import { PluginAddsList, PluginHead, type PluginAddRow } from "./plugin-summary.js";
import { projectTypeLabel } from "./project-types.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Button, Chip, Dialog } from "./ui/index.js";

// What the Plugins page shows of the market: the categories plugins name, and
// the market's cards and pages. Discover's sections are in plugin-discover.tsx.

/** A plugin's categories that this app knows, and `other` for one that names none of them. */
export type CatalogCategory = PluginCategory | "other";
export const CATALOG_CATEGORIES: readonly CatalogCategory[] = [...PLUGIN_CATEGORIES, "other"];
export type CatalogFilter = CatalogCategory | "all";

const known = (categories: readonly string[] | undefined) =>
  (categories ?? []).filter((category): category is PluginCategory => (PLUGIN_CATEGORIES as readonly string[]).includes(category));

export function inCatalogCategory(categories: readonly string[] | undefined, filter: CatalogFilter): boolean {
  if (filter === "all") return true;
  const named = known(categories);
  return filter === "other" ? !named.length : named.includes(filter);
}

export const categoryLabel = (category: CatalogCategory) => t(`pluginCatalog.categories.${category}`);

/** What search reads of a market plugin: its name, description, ids, keywords and what it adds by name. */
export function marketSearchText(plugin: MarketPlugin): string {
  return [plugin.displayName, plugin.description, plugin.id, ...(plugin.keywords ?? []), ...(plugin.names ?? [])].join(" ").toLowerCase();
}

/** A plugin's keywords; each searches for itself when the page can search. */
export function PluginKeywords({ keywords, onSearch }: { keywords: readonly string[]; onSearch?: ((keyword: string) => void) | undefined }): ReactNode {
  return <span className="plugin-keywords">
    {keywords.map((keyword) => onSearch
      ? <button key={keyword} type="button" className="ui-chip ui-chip-outline plugin-keyword" title={t("pluginCatalog.searchKeyword", { keyword })}
        onClick={() => onSearch(keyword)}><span className="ui-chip-label">{keyword}</span></button>
      : <Chip key={keyword} outline>{keyword}</Chip>)}
  </span>;
}

/** Published by OhMyGame: the market takes the publisher only from its own GitHub releases. */
export const isOfficialPlugin = (id: string) => id.startsWith(`${OHMYGAME_PUBLISHER}/`);

export function pluginPublisherName(id: string): string {
  return `@${id.split("/")[0]}`;
}

/**
 * Images the market lists for a plugin (its icon, its screenshots), read
 * through the daemon from beside the index, as addresses an `img` can show:
 * undefined while reading, null for one that can't be read.
 */
function useMarketImages(role: "icon" | "screenshot", source: string | undefined, paths: readonly (string | undefined)[]): (string | null | undefined)[] {
  const generation = useReadyRuntimeGeneration();
  const [urls, setUrls] = useState<(string | null | undefined)[]>([]);
  const key = [role, source ?? "", ...paths].join("\n");
  useEffect(() => {
    setUrls([]);
    const controller = new AbortController();
    const made: string[] = [];
    void Promise.all(paths.map((path) => path
      ? readPluginMarketImage(path, role, source, controller.signal).then((blob) => {
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

/** Avatars by GitHub id, read once a run: many plugins share a publisher. */
const avatars = new Map<string, Promise<string | null>>();
/** How many cards show each avatar now; one on screen is never dropped. */
const avatarUsers = new Map<string, number>();
const AVATAR_CACHE_LIMIT = 200;

function useMarketAvatar(id: string | undefined): string | null | undefined {
  const generation = useReadyRuntimeGeneration();
  const [url, setUrl] = useState<string | null | undefined>(id ? undefined : null);
  useEffect(() => {
    if (!id) return setUrl(null);
    // Not the last publisher's face while this one's loads.
    setUrl(undefined);
    let read = avatars.get(id);
    if (!read) {
      read = readPluginMarketAvatar(id).then((blob) => URL.createObjectURL(blob), () => {
        // Tried again the next time a card shows it.
        avatars.delete(id);
        return null;
      });
      avatars.set(id, read);
      if (avatars.size > AVATAR_CACHE_LIMIT)
        for (const [oldest, old] of avatars) {
          if (oldest === id || avatarUsers.get(oldest)) continue;
          avatars.delete(oldest);
          void old.then((made) => { if (made) URL.revokeObjectURL(made); });
          break;
        }
    }
    avatarUsers.set(id, (avatarUsers.get(id) ?? 0) + 1);
    let live = true;
    void read.then((next) => { if (live) setUrl(next); });
    return () => {
      live = false;
      const users = (avatarUsers.get(id) ?? 1) - 1;
      if (users > 0) avatarUsers.set(id, users);
      else avatarUsers.delete(id);
    };
  }, [id, generation]);
  return url;
}

/** A market plugin's own icon, as an installed one's tile shows it, or its first letter. */
export function MarketTile({ plugin, large = false }: { plugin: MarketPlugin; large?: boolean }): ReactNode {
  const [icon] = useMarketImages("icon", plugin.source, [plugin.icon]);
  const size = large ? 40 : 24;
  return <span className={`plugin-tile${large ? " plugin-tile-large" : ""}`}>
    {icon ? <img className="plugin-icon-image" src={icon} width={size} height={size} alt="" aria-hidden="true" />
      // While the icon loads the tile stays empty, rather than flashing a letter.
      : plugin.icon && icon === undefined ? null : <PluginMonogram id={plugin.id} name={plugin.displayName} size={size} />}
  </span>;
}

/** Who publishes a market plugin, after their GitHub avatar when the index has one and it can be read. */
function Publisher({ plugin }: { plugin: MarketPlugin }): ReactNode {
  const avatar = useMarketAvatar(plugin.avatar);
  return <span className="plugin-publisher">
    {avatar ? <img src={avatar} alt="" aria-hidden="true" /> : null}
    {pluginPublisherName(plugin.id)}
  </span>;
}

/** Official and Beta are on its page; a card only says it's installed. */
function MarketBadges({ plugin, installed = false, card = false }: { plugin: MarketPlugin; installed?: boolean; card?: boolean }): ReactNode {
  return <PluginMarks official={!card && isOfficialPlugin(plugin.id)} marks={[!card && plugin.beta && "beta", installed && "installed"]} />;
}

/**
 * A plugin on the market, as a whole card that opens its page: its icon, name,
 * Installed when it is, two lines of what it does, and a line of what tells it
 * apart, when there is something.
 */
export function MarketPluginCard({ plugin, installed = false, fact, onOpen }: {
  plugin: MarketPlugin;
  installed?: boolean;
  fact?: string | undefined;
  onOpen: () => void;
}): ReactNode {
  return <article className="plugin-card">
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <MarketTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          <MarketBadges plugin={plugin} installed={installed} card />
        </strong>
        <small>{plugin.description}</small>
        {fact ? <span className="plugin-card-fact">{fact}</span> : null}
      </span>
    </button>
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

/**
 * The project types a plugin names, by their names here, each once. A plugin's
 * type that the app had as its own (Godot) goes by that name; another
 * plugin's type by its id after the plugin's.
 */
export function appliesToLabels(appliesTo: readonly string[] | undefined): string[] {
  const kinds: Record<string, string> = PLUGIN_PROJECT_KINDS;
  // Types are told apart by id, so two plugins' `level` types stay two; the app's own name for one appears once.
  const types = new Set((appliesTo ?? []).map((type) => Object.keys(kinds).find((kind) => kinds[kind] === type) ?? type));
  return [...types].map((app) => (PROJECT_TYPE_IDS as readonly string[]).includes(app) ? projectTypeLabel(app as ProjectType) : app.slice(app.indexOf(":") + 1));
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

/**
 * A plugin on the market that isn't installed, on the same page an installed
 * one has: its name, what it is and Get first, then its screenshots and
 * description, what it adds and asks for, and at the side the same Information
 * card, with its version, size and dates.
 */
export function MarketPluginPage({ plugin, getDisabled, onGet, onSearch }: {
  plugin: MarketPlugin;
  getDisabled?: boolean;
  onGet: () => void;
  /** Searches the market for one of its keywords. */
  onSearch?: (keyword: string) => void;
}): ReactNode {
  const compact = new Intl.NumberFormat(language, { notation: "compact" });
  const rows = marketAddRows(plugin.adds);
  const categories = known(plugin.categories);
  const worksWith = appliesToLabels(plugin.appliesTo);
  const date = (value: string | undefined) => {
    const time = value ? new Date(value) : undefined;
    return time && !Number.isNaN(time.getTime()) ? time.toLocaleDateString(language, { year: "numeric", month: "short", day: "numeric" }) : undefined;
  };
  const updated = date(plugin.publishedAt);
  const created = date(plugin.createdAt);
  const shots = useMarketImages("screenshot", plugin.source, (plugin.screenshots ?? []).map((shot) => shot.path));
  return <div className="plugin-page">
    <PluginHead tile={<MarketTile plugin={plugin} large />} title={plugin.displayName} description={plugin.description}
      badges={<MarketBadges plugin={plugin} />}>
      <div className="plugin-head-actions">
        <Button variant="primary" disabled={getDisabled} onClick={onGet}>{t("pluginCatalog.get")}</Button>
      </div>
    </PluginHead>
    <PluginScreenshots shots={(plugin.screenshots ?? []).flatMap((shot, index) => {
      const src = shots[index];
      return src ? [{ src, ...(shot.caption ? { caption: shot.caption } : {}) }] : [];
    })} />
    <div className="plugin-layout">
      <div className="plugin-main">
        {plugin.longDescription ? <p className="plugin-long">{plugin.longDescription}</p> : null}
        {rows.length ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
          <h2>{t("pluginStore.adds")}</h2>
          <PluginAddsList rows={rows} />
        </section> : null}
        <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
          <h2>{t("pluginStore.asksFor")}</h2>
          {plugin.asks.length ? <PluginCapabilityList capabilities={plugin.asks} /> : <p className="plugins-note">{t("pluginCatalog.asksNothing")}</p>}
        </section>
      </div>
      <aside className="plugin-side" aria-label={t("pluginCatalog.information")}>
        <h2>{t("pluginCatalog.information")}</h2>
        <dl className="plugin-props">
          <dt>{t("pluginCatalog.publisher")}</dt>
          <dd><Publisher plugin={plugin} /></dd>
          <dt>{t("pluginCatalog.categoriesLabel")}</dt>
          <dd>{categories.length ? categories.map(categoryLabel).join(" · ") : categoryLabel("other")}</dd>
          {plugin.keywords?.length ? <><dt>{t("pluginCatalog.keywords")}</dt><dd><PluginKeywords keywords={plugin.keywords} onSearch={onSearch} /></dd></> : null}
          <dt>{t("pluginCatalog.worksWith")}</dt>
          <dd>{worksWith.length ? worksWith.join(" · ") : t("pluginCatalog.everyType")}</dd>
          <dt>{t("plugins.version")}</dt>
          <dd className="plugins-mono">v{plugin.version}</dd>
          {plugin.size !== undefined ? <><dt>{t("pluginCatalog.size")}</dt><dd>{formatBytes(plugin.size)}</dd></> : null}
          {updated ? <><dt>{t("pluginCatalog.updated")}</dt><dd>{updated}</dd></> : null}
          {created ? <><dt>{t("pluginCatalog.firstPublished")}</dt><dd>{created}</dd></> : null}
          {/* The market counts stars only for a verified repository of one plugin, so never OhMyGame's own. */}
          {plugin.stars !== undefined ? <><dt>{t("pluginCatalog.starsShort")}</dt><dd>{compact.format(plugin.stars)}</dd></> : null}
          {plugin.source ? <><dt>{t("pluginMarketSettings.listedBy")}</dt><dd>{new URL(plugin.source).host}</dd></> : null}
          {plugin.repository ? <><dt>{t("plugins.repository")}</dt><dd>
            <a href={plugin.repository} target="_blank" rel="noreferrer">{repositoryLabel(plugin.repository.replace(/^https:\/\/github\.com\//, ""))}<ExternalLink size="xs" /></a>
            <span className="plugins-note">{t(plugin.sourceVerified ? "plugins.sourceVerified" : "plugins.sourceUnverified")}</span>
          </dd></> : null}
        </dl>
      </aside>
    </div>
  </div>;
}

/** A repository as `owner/name`, which wraps after the slash rather than inside a name. */
export function repositoryLabel(repository: string): ReactNode {
  const slash = repository.indexOf("/");
  return slash < 0 ? repository : <>{repository.slice(0, slash + 1)}<wbr />{repository.slice(slash + 1)}</>;
}
