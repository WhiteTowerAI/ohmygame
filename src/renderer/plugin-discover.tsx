import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
// several sections, as a provider that makes images and sound is in both.

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

/** Past this many, a section shows this many until All N opens the rest. */
const SECTION_LIMIT = 12;

const inSection = (plugin: MarketPlugin, section: (typeof SECTIONS)[number]) =>
  section.categories.some((category) => plugin.categories?.includes(category))
  || section.kinds.some((kind) => plugin.providerKinds?.includes(kind));

/** A search names a section by one of its words, or the start of one. */
const namesSection = (query: string, section: (typeof SECTIONS)[number]) =>
  section.words.some((word) => query.includes(word) || (query.length >= 2 && word.startsWith(query)));

/** Featured first, in the market's order, then by name. */
function ordered(plugins: readonly MarketPlugin[]): MarketPlugin[] {
  const featured = plugins.filter((plugin) => plugin.featured);
  return [...featured, ...plugins.filter((plugin) => !plugin.featured).sort((a, b) => a.displayName.localeCompare(b.displayName, language))];
}

/**
 * The market in sections, each with what's in it, empty ones included so the
 * side list can show them greyed while searching. Featured comes first when
 * nothing is searched; Other holds what's in no section.
 */
export function discoverSections(plugins: readonly MarketPlugin[], query: string): { id: DiscoverSection; plugins: MarketPlugin[] }[] {
  const matches = (plugin: MarketPlugin, named: boolean) => !query || named || marketSearchText(plugin).includes(query);
  const sections: { id: DiscoverSection; plugins: MarketPlugin[] }[] = SECTIONS.map((section) => {
    const named = Boolean(query) && namesSection(query, section);
    return { id: section.id, plugins: ordered(plugins.filter((plugin) => inSection(plugin, section) && matches(plugin, named))) };
  });
  const other = plugins.filter((plugin) => !SECTIONS.some((section) => inSection(plugin, section)) && matches(plugin, false));
  return [
    ...(query ? [] : [{ id: "featured" as const, plugins: plugins.filter((plugin) => plugin.featured) }]),
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

const sectionLabel = (id: DiscoverSection) => t(`pluginCatalog.sections.${id}`);
const anchorId = (id: DiscoverSection) => `plugins-section-${id}`;

/**
 * Discover's overview: a side list that jumps to each section and follows the
 * scroll, and the sections of cards. A search keeps the sections and greys out
 * the empty ones in the side list.
 */
export function DiscoverView({ plugins, installed, query, jumpTo, onOpen }: {
  plugins: readonly MarketPlugin[];
  installed: ReadonlySet<string>;
  /** The page's search, lowercase. */
  query: string;
  /** A section to scroll to once, as a link into Discover asks. */
  jumpTo?: DiscoverSection;
  onOpen: (id: string) => void;
}): ReactNode {
  const sections = discoverSections(plugins, query);
  const shown = sections.filter((section) => section.plugins.length);
  const [current, setCurrent] = useState<DiscoverSection | undefined>(shown[0]?.id);
  const [opened, setOpened] = useState<ReadonlySet<DiscoverSection>>(() => new Set());
  const main = useRef<HTMLDivElement>(null);
  const shownKey = shown.map((section) => section.id).join();

  // The side list follows the scroll: the last section whose top has reached the top of the page.
  useEffect(() => {
    const scroller = main.current?.closest<HTMLElement>(".sidebar-page");
    if (!scroller) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = scroller.getBoundingClientRect().top + SCROLL_MARGIN + 1;
        const heads = [...(main.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])];
        const reached = heads.filter((head) => head.getBoundingClientRect().top <= top).at(-1) ?? heads[0];
        setCurrent(reached?.dataset.section as DiscoverSection | undefined);
      });
    };
    follow();
    scroller.addEventListener("scroll", follow, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", follow);
    };
  }, [shownKey]);

  useLayoutEffect(() => {
    if (jumpTo) document.getElementById(anchorId(jumpTo))?.scrollIntoView({ block: "start" });
  }, [jumpTo]);

  if (!shown.length) return <Empty title={t("plugins.noMatch")} />;
  return <div className="plugins-browse">
    <nav className="plugins-rail" aria-label={t("pluginCatalog.categoriesLabel")}>
      {sections.filter((section) => section.id !== "featured" || section.plugins.length).filter((section) => section.id !== "other" || section.plugins.length)
        .map((section) => <button key={section.id} type="button" className="plugins-rail-item" disabled={!section.plugins.length}
          aria-current={section.id === current ? "true" : undefined}
          onClick={() => document.getElementById(anchorId(section.id))?.scrollIntoView({ block: "start", behavior: "smooth" })}>
          <span>{sectionLabel(section.id)}</span>
          {section.id === "featured" ? null : <span className="plugins-rail-count">{section.plugins.length}</span>}
        </button>)}
    </nav>
    <div ref={main} className="plugins-browse-main">
      {shown.map((section) => {
        const all = Boolean(query) || opened.has(section.id) || section.plugins.length <= SECTION_LIMIT;
        return <section key={section.id} id={anchorId(section.id)} data-section={section.id} className="plugins-section" aria-label={sectionLabel(section.id)}>
          <div className="plugins-section-head">
            <h2>{sectionLabel(section.id)}</h2>
          </div>
          <div className="plugins-grid">
            {(all ? section.plugins : section.plugins.slice(0, SECTION_LIMIT)).map((plugin) => <MarketPluginCard key={plugin.id} plugin={plugin}
              installed={installed.has(plugin.id)} fact={marketFact(plugin)} onOpen={() => onOpen(plugin.id)} />)}
          </div>
          {all ? null : <div className="plugins-all">
            <Button variant="ghost" size="sm" onClick={() => setOpened((current) => new Set([...current, section.id]))}>
              {t("pluginCatalog.showAllInSection", { count: section.plugins.length })}
            </Button>
          </div>}
        </section>;
      })}
    </div>
  </div>;
}

/**
 * Discover with a plugin open: the cards fold into one column beside its page,
 * still in sections, so the next one to compare is a click away. Installed's
 * list looks the same.
 */
export function DiscoverList({ plugins, installed, query, selected, onOpen }: {
  plugins: readonly MarketPlugin[];
  installed: ReadonlySet<string>;
  query: string;
  selected: string;
  onOpen: (id: string) => void;
}): ReactNode {
  const list = useRef<HTMLElement>(null);
  const shown = discoverSections(plugins, query).filter((section) => section.plugins.length);
  // The open plugin stays in view, first where it's listed.
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return <aside ref={list} className="installed-plugin-inventory" aria-label={t("plugins.discoverTab")}>
    {shown.length ? shown.map((section) => <section key={section.id} className="installed-plugin-group" aria-label={sectionLabel(section.id)}>
      <div className="installed-plugin-group-head"><h2>{sectionLabel(section.id)}</h2></div>
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

/** Room above a section that a jump leaves, matching `scroll-margin-top` in plugins.css. */
const SCROLL_MARGIN = 16;
