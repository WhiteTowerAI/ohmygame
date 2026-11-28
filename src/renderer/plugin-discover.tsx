import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { PluginCategory } from "../shared/plugin-manifest.js";
import type { ProviderCapability } from "../shared/contracts.js";
import { PROVIDER_KINDS, type MarketPlugin } from "../shared/plugins.js";
import { language, t } from "./i18n.js";
import type { PluginsSection } from "./routes.js";
import { isOfficialPlugin, MarketPluginCard, marketSearchText, MarketTile, pluginPublisherName } from "./plugin-catalog.js";
import { PluginMarks } from "./plugin-marks.js";
import { Button, Empty } from "./ui/index.js";

// Discover: every plugin on the market, in sections by what someone wants to
// do with it rather than by the categories authors pick. A plugin can be in
// several sections, as a provider that makes images and sound is in both; All
// shows it once.

export type DiscoverSection = PluginsSection;

/**
 * The sections, in the order a game is made. A plugin is in a section when it
 * names one of its categories or makes one of its kinds. Search also reads each
 * section's words, in both languages, so "配音" finds the plugins that say "speech".
 */
const SECTIONS = [
  { id: "engine", categories: ["engine"], kinds: [], words: ["引擎", "平台", "小游戏", "engine", "platform", "minigame"] },
  { id: "agent", categories: ["agent"], kinds: ["language"], words: ["智能体", "大模型", "编程", "对话", "agent", "llm", "coding", "chat"] },
  { id: "image", categories: ["art"], kinds: ["image"], words: ["图片", "图像", "像素", "美术", "绘画", "贴图", "精灵", "立绘", "image", "pixel", "art", "sprite", "texture", "drawing"] },
  { id: "audio", categories: ["audio"], kinds: ["audio"], words: ["声音", "音频", "配音", "语音", "音效", "音乐", "tts", "voice", "speech", "sound", "audio", "music", "sfx"] },
  { id: "3d", categories: ["3d"], kinds: ["3d"], words: ["3d", "建模", "网格", "mesh", "glb"] },
  { id: "video", categories: ["video"], kinds: ["video"], words: ["视频", "过场", "video", "cutscene", "clip"] },
  { id: "design", categories: ["design", "story", "workflow", "templates"], kinds: [], words: ["关卡", "玩法", "地图", "剧情", "策划", "模板", "level", "map", "tilemap", "gameplay", "story", "template", "workflow"] },
  { id: "ship", categories: ["testing", "publishing", "online"], kinds: [], words: ["测试", "发布", "上架", "联机", "test", "publish", "release", "multiplayer", "online"] },
  { id: "connect", categories: ["integration"], kinds: [], words: ["连接", "集成", "消息", "机器人", "integration", "connect", "bot", "message"] },
] as const satisfies readonly { id: Exclude<PluginsSection, "featured" | "other">; categories: readonly PluginCategory[]; kinds: readonly ProviderCapability[]; words: readonly string[] }[];

/**
 * Featured waits until the market's picks are made: off, the index's `featured`
 * neither adds the section nor moves a plugin up. Turning it on brings both back.
 */
const SHOW_FEATURED = false;

const inSection = (plugin: MarketPlugin, section: (typeof SECTIONS)[number]) =>
  section.categories.some((category) => plugin.categories?.includes(category))
  || section.kinds.some((kind) => plugin.providerKinds?.includes(kind));

/** A search names a section by one of its words, or the start of one. */
const namesSection = (query: string, section: (typeof SECTIONS)[number]) =>
  section.words.some((word) => query.includes(word) || (query.length >= 2 && word.startsWith(query)));

/** Featured first, in the market's order, then by name. */
function ordered(plugins: readonly MarketPlugin[]): MarketPlugin[] {
  const featured = SHOW_FEATURED ? plugins.filter((plugin) => plugin.featured) : [];
  return [...featured, ...plugins.filter((plugin) => !featured.includes(plugin)).sort((a, b) => a.displayName.localeCompare(b.displayName, language))];
}

/**
 * The market in sections, each with what's in it, empty ones included so the
 * side list can show them greyed while searching. Featured, once shown, comes
 * first when nothing is searched; Other holds what's in no section.
 */
export function discoverSections(plugins: readonly MarketPlugin[], query: string): { id: DiscoverSection; plugins: MarketPlugin[] }[] {
  const matches = (plugin: MarketPlugin, named: boolean) => !query || named || marketSearchText(plugin).includes(query);
  const sections: { id: DiscoverSection; plugins: MarketPlugin[] }[] = SECTIONS.map((section) => {
    const named = Boolean(query) && namesSection(query, section);
    return { id: section.id, plugins: ordered(plugins.filter((plugin) => inSection(plugin, section) && matches(plugin, named))) };
  });
  const other = plugins.filter((plugin) => !SECTIONS.some((section) => inSection(plugin, section)) && matches(plugin, false));
  return [
    ...(query || !SHOW_FEATURED ? [] : [{ id: "featured" as const, plugins: plugins.filter((plugin) => plugin.featured) }]),
    ...sections,
    { id: "other", plugins: ordered(other) },
  ];
}

/**
 * What tells a card apart from its neighbours: whose it is when it isn't
 * OhMyGame's, and what it makes when that's more than one kind.
 */
export function marketFact(plugin: MarketPlugin): string | undefined {
  const kinds = PROVIDER_KINDS.filter((kind) => kind !== "language" && plugin.providerKinds?.includes(kind));
  return [
    ...(isOfficialPlugin(plugin.id) ? [] : [`${t("pluginCatalog.community")} · ${pluginPublisherName(plugin.id)}`]),
    ...(kinds.length > 1 ? [kinds.map((kind) => t(`capability.${kind}`)).join(" · ")] : []),
  ].join(" · ") || undefined;
}

/** What Discover shows: one section, or All. */
export type DiscoverShelf = DiscoverSection | "all";

/** All shows this many of each section, and a way into the rest. */
const SHELF = 4;

const shelfLabel = (id: DiscoverShelf) => t(`pluginCatalog.sections.${id}`);

/** Each plugin once, in the first section it's in, so one that makes images and sound isn't listed twice. */
function onceEach(sections: readonly { id: DiscoverSection; plugins: MarketPlugin[] }[]): { id: DiscoverSection; plugins: MarketPlugin[] }[] {
  const seen = new Set<string>();
  return sections.map((section) => ({ ...section, plugins: section.plugins.filter((plugin) => {
    if (seen.has(plugin.id)) return false;
    seen.add(plugin.id);
    return true;
  }) })).filter((section) => section.plugins.length);
}

/** All's few of each section: ones not shown above first, then ones that were, so no section is left out. */
function shelves(sections: readonly { id: DiscoverSection; plugins: MarketPlugin[] }[]): { id: DiscoverSection; plugins: MarketPlugin[] }[] {
  const seen = new Set<string>();
  return sections.filter((section) => section.plugins.length).map((section) => {
    const fresh = section.plugins.filter((plugin) => !seen.has(plugin.id)).slice(0, SHELF);
    const again = section.plugins.filter((plugin) => seen.has(plugin.id)).slice(0, SHELF - fresh.length);
    const picked = new Set([...fresh, ...again]);
    for (const plugin of fresh) seen.add(plugin.id);
    return { ...section, plugins: section.plugins.filter((plugin) => picked.has(plugin)) };
  });
}

/**
 * Discover's cards: a side list of All and the sections, and what's picked.
 * All shows a few of each section with a way into the rest; a section shows all
 * of it. A search narrows either and greys out the sections it left empty.
 */
export function DiscoverView({ plugins, installed, query, shelf, onShelf, onOpen }: {
  plugins: readonly MarketPlugin[];
  installed: ReadonlySet<string>;
  /** The page's search, lowercase. */
  query: string;
  shelf: DiscoverShelf;
  onShelf: (shelf: DiscoverShelf) => void;
  onOpen: (id: string) => void;
}): ReactNode {
  const main = useRef<HTMLDivElement>(null);
  const sections = discoverSections(plugins, query);
  // A search lists every match once; otherwise a few of each section, and the section has the rest.
  const overview = query ? onceEach(sections) : shelves(sections);
  if (!overview.length) return <Empty title={t("plugins.noMatch")} />;
  const picked = shelf === "all" ? undefined : sections.find((section) => section.id === shelf);
  const pick = (next: DiscoverShelf) => {
    onShelf(next);
    // A section starts at its top, wherever All was scrolled to.
    main.current?.closest<HTMLElement>(".sidebar-page")?.scrollTo({ top: 0 });
  };
  const cards = (list: readonly MarketPlugin[]) => <div className="plugins-grid">
    {list.map((plugin) => <MarketPluginCard key={plugin.id} plugin={plugin} installed={installed.has(plugin.id)} fact={marketFact(plugin)} onOpen={() => onOpen(plugin.id)} />)}
  </div>;
  const count = (id: DiscoverShelf) => id === "all" ? new Set(sections.flatMap((section) => section.plugins.map((plugin) => plugin.id))).size
    : sections.find((section) => section.id === id)?.plugins.length ?? 0;
  const items: DiscoverShelf[] = ["all", ...sections.filter((section) => section.plugins.length || (section.id !== "featured" && section.id !== "other")).map((section) => section.id)];
  return <div className="plugins-browse">
    <nav className="plugins-rail" aria-label={t("pluginCatalog.categoriesLabel")}>
      {items.map((id) => <button key={id} type="button" className="plugins-rail-item" disabled={!count(id)}
        aria-current={id === shelf ? "true" : undefined} onClick={() => pick(id)}>
        <span>{shelfLabel(id)}</span>
        {id === "featured" ? null : <span className="plugins-rail-count">{count(id)}</span>}
      </button>)}
    </nav>
    <div ref={main} className="plugins-browse-main">
      {picked ? <section className="plugins-section" aria-label={shelfLabel(picked.id)}>
        <div className="plugins-section-head"><h2>{shelfLabel(picked.id)}</h2></div>
        {picked.plugins.length ? cards(picked.plugins) : <Empty title={t("plugins.noMatch")} />}
      </section>
      : overview.map((section) => {
        const shown = section.plugins;
        const total = count(section.id);
        return <section key={section.id} className="plugins-section" aria-label={shelfLabel(section.id)}>
          <div className="plugins-section-head">
            <h2>{shelfLabel(section.id)}</h2>
            {total > shown.length ? <Button variant="ghost" size="sm" onClick={() => pick(section.id)}>{t("pluginCatalog.showAllInSection", { count: total })}</Button> : null}
          </div>
          {cards(shown)}
        </section>;
      })}
    </div>
  </div>;
}

/**
 * Discover with a plugin open: the cards fold into one column beside its page,
 * from the section they were in, so the next one to compare is a click away.
 * Installed's list looks the same.
 */
export function DiscoverList({ plugins, installed, query, shelf, selected, hidden = false, onOpen }: {
  plugins: readonly MarketPlugin[];
  installed: ReadonlySet<string>;
  query: string;
  shelf: DiscoverShelf;
  selected: string;
  /** A narrow window shows only the plugin's page. */
  hidden?: boolean;
  onOpen: (id: string) => void;
}): ReactNode {
  const list = useRef<HTMLElement>(null);
  const sections = discoverSections(plugins, query);
  const picked = sections.filter((section) => section.id === shelf && section.plugins.length);
  // A plugin opened from elsewhere, not in the section, has All beside it.
  const shown = picked.some((section) => section.plugins.some((plugin) => plugin.id === selected)) ? picked : onceEach(sections);
  // The open plugin stays in view.
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return <aside ref={list} className="installed-plugin-inventory" aria-label={t("plugins.discoverTab")} hidden={hidden}>
    {shown.length ? shown.map((section) => <section key={section.id} className="installed-plugin-group" aria-label={shelfLabel(section.id)}>
      <div className="installed-plugin-group-head"><h2>{shelfLabel(section.id)}</h2></div>
      <ul className="installed-plugin-list">
        {section.plugins.map((plugin) => <li key={plugin.id} className="installed-plugin-row">
          <button type="button" className="installed-plugin-open" aria-current={plugin.id === selected ? "true" : undefined} onClick={() => onOpen(plugin.id)}>
            <MarketTile plugin={plugin} />
            <span className="installed-plugin-label">
              <span className="installed-plugin-title">
                <span className="installed-plugin-identity"><span className="installed-plugin-name" title={plugin.displayName}>{plugin.displayName}</span></span>
                <PluginMarks marks={[installed.has(plugin.id) && "installed"]} />
              </span>
              <span className="installed-plugin-meta"><span className="discover-row-text">{marketFact(plugin) ?? plugin.description}</span></span>
            </span>
          </button>
        </li>)}
      </ul>
    </section>) : <Empty title={t("plugins.noMatch")} />}
  </aside>;
}
