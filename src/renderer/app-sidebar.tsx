import { cloneElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CirclePlus,
  DangerCircle,
  Gamepad2,
  Globe2,
  House,
  Image,
  InfoCircle,
  LogIn,
  MessageCircle,
  PanelToggle,
  Plug,
  RefreshCircle,
  Search,
  Settings,
  UserRound,
} from "./icons.js";
import { getProjectCover, getProjectLogo, listConversations, listProjects, waitForRuntime } from "./api.js";
import { useAuth } from "./auth.js";
import { BrandLogo } from "./brand-logo.js";
import { ProjectPlaceholder } from "./project-placeholder.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { conversationHash, createdProjectView, projectHash, settingsHash, type AppNavigationTarget, type SidebarPage } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { DropdownMenu, IconButton, Popover, Tooltip, type MenuEntry } from "./ui/index.js";
import { useDesktopUpdate } from "./use-desktop-update.js";
import { UserAvatar } from "./user-avatar.js";
import type { ConversationSummary, ProjectState } from "../shared/contracts.js";
import { language, t } from "./i18n.js";
import { openCommandMenu, shortcut } from "./command-menu.js";
import { hasWindowsTitleBar } from "./desktop-window-frame.js";
import "./app-sidebar.css";

export type SidebarActive = SidebarPage | "settings";

const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 232;
const RECENT_LIMIT = 8;
// Home shows the recent projects too, so the pages' sidebar keeps a few and links to the rest.
const SIDEBAR_RECENT = 5;
const WIDTH_KEY = "ohmygame-sidebar-width";
const COLLAPSED_KEY = "ohmygame-sidebar-collapsed";
const RECENT_OPEN_KEY = "ohmygame-sidebar-recent-open";

// Every page renders its own frame, so the sidebar's width, collapsed state
// and folded recent projects live here and survive moving between pages.
interface SidebarPreferences {
  collapsed: boolean;
  width: number;
  recentOpen: boolean;
}

// Read on first use: node tests import this module without a browser.
let preferences: SidebarPreferences | undefined;
const preferenceListeners = new Set<() => void>();

function subscribePreferences(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

function readPreferences(): SidebarPreferences {
  preferences ??= {
    collapsed: localStorage.getItem(COLLAPSED_KEY) === "true",
    width: clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH),
    recentOpen: localStorage.getItem(RECENT_OPEN_KEY) !== "false",
  };
  return preferences;
}

function setPreferences(change: Partial<SidebarPreferences>, persist = true): void {
  preferences = { ...readPreferences(), ...change };
  if (persist) {
    localStorage.setItem(COLLAPSED_KEY, String(preferences.collapsed));
    localStorage.setItem(WIDTH_KEY, String(preferences.width));
    localStorage.setItem(RECENT_OPEN_KEY, String(preferences.recentOpen));
  }
  for (const listener of preferenceListeners) listener();
}

// A narrow window (the browser, a phone) always gets the collapsed column.
const NARROW = "(max-width: 720px)";

function subscribeNarrow(listener: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function useSidebarPreferences(): SidebarPreferences & { narrow: boolean } {
  const current = useSyncExternalStore(subscribePreferences, readPreferences, readPreferences);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  return { ...current, collapsed: current.collapsed || narrow, narrow };
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/** The frame's class and sidebar width; the collapsed column's width is in the CSS. */
export function useSidebarLayout(): { className: string; style?: CSSProperties } {
  const { collapsed, width } = useSidebarPreferences();
  return collapsed
    ? { className: " is-sidebar-collapsed" }
    : { className: "", style: { "--sidebar-width": `${width}px` } as CSSProperties };
}

// Recent projects, newest first. Pages that load the project list hand it over
// so a rename or removal shows here without another request; on the others the
// sidebar asks for it.
const PAGES_WITH_PROJECT_LIST = new Set<SidebarActive>(["home", "projects"]);
let recentProjects: ProjectState[] = [];
const recentListeners = new Set<() => void>();

export function publishRecentProjects(projects: readonly ProjectState[]): void {
  recentProjects = [...projects]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_LIMIT);
  for (const listener of recentListeners) listener();
}

/** Shows a project's new name or cover in the list without asking again. */
export function refreshRecentProject(project: ProjectState): void {
  if (!recentProjects.some((item) => item.id === project.id)) return;
  publishRecentProjects(recentProjects.map((item) => (item.id === project.id ? project : item)));
}

function subscribeRecent(listener: () => void): () => void {
  recentListeners.add(listener);
  return () => recentListeners.delete(listener);
}

function useRecentProjects(active?: SidebarActive): ProjectState[] {
  const generation = useReadyRuntimeGeneration();
  const pageLoadsList = !!active && PAGES_WITH_PROJECT_LIST.has(active);
  useEffect(() => {
    if (pageLoadsList) return;
    let disposed = false;
    void waitForRuntime().then(listProjects).then((projects) => {
      if (!disposed) publishRecentProjects(projects);
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [generation, pageLoadsList]);
  return useSyncExternalStore(subscribeRecent, () => recentProjects, () => recentProjects);
}

// Covers and logos load once per project version and stay while the app runs.
const images = new Map<string, { version: string; url: Promise<string | undefined> }>();

function imageUrl(project: ProjectState, kind: "cover" | "logo"): Promise<string | undefined> {
  const key = `${kind}:${project.id}`;
  const cached = images.get(key);
  if (cached?.version === project.updatedAt) return cached.url;
  const url = (kind === "logo" ? getProjectLogo(project.id) : getProjectCover(project.id))
    .then((image) => (image ? URL.createObjectURL(image) : undefined))
    .catch(() => undefined);
  void cached?.url.then((previous) => previous && URL.revokeObjectURL(previous));
  images.set(key, { version: project.updatedAt, url });
  return url;
}

/**
 * A recent project's mark: its uploaded logo, the default icon it chose, its
 * cover, or else the default template, with the icon centred at the given size.
 */
function SidebarCover({ project, className, iconSize }: { project: ProjectState; className: string; iconSize: number }) {
  const appearance = project.appearance;
  const kind = appearance?.logo ? "logo" : appearance?.icon || appearance?.cover === "template" ? undefined : "cover";
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!kind) return;
    let disposed = false;
    void imageUrl(project, kind).then((next) => {
      if (!disposed) setUrl(next);
    });
    return () => {
      disposed = true;
    };
  }, [project.id, project.updatedAt, kind]);
  return (
    <span className={className} aria-hidden="true">
      {url ? <img src={url} alt="" onError={() => setUrl(undefined)} /> : <ProjectPlaceholder projectId={project.id} appearance={appearance} size={iconSize} />}
    </span>
  );
}

/** The shortcut the app uses for settings. */

// The Navigation API (Chromium) says whether there is somewhere to go; the
// buttons stay enabled where it is missing.
interface NavigationLike extends EventTarget {
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Whether the window can go back and forward, as the title bars show it. */
export function useHistoryState() {
  const navigationApi = (window as unknown as { navigation?: NavigationLike }).navigation;
  const read = () => ({ back: navigationApi?.canGoBack ?? true, forward: navigationApi?.canGoForward ?? true });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    navigationApi?.addEventListener("currententrychange", update);
    window.addEventListener("hashchange", update);
    return () => {
      navigationApi?.removeEventListener("currententrychange", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  return state;
}

function SidebarItem({ icon, label, shortcut: keys, dot, active = false, onClick }: {
  icon: ReactNode;
  label: string;
  /** The keyboard shortcut, shown at the end while the sidebar is expanded. */
  shortcut?: string;
  /** Marks the icon, so it shows in the collapsed sidebar too. */
  dot?: "accent" | "warning";
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarTip label={label}>
      <button type="button" className={`sidebar-item${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined} onClick={onClick}>
        <span className="sidebar-item-icon" aria-hidden="true">{icon}{dot ? <span className={`sidebar-dot is-${dot}`} /> : null}</span>
        <span className="sidebar-item-label">{label}</span>
        {keys ? <kbd className="sidebar-item-shortcut">{keys}</kbd> : null}
      </button>
    </SidebarTip>
  );
}

// Collapsed, an item is only its icon, so its name shows beside it on hover;
// expanded, a long name cut off by the width shows in full the same way.
function SidebarTip({ label, children }: { label: string; children: ReactElement<Record<string, unknown>> }) {
  const { collapsed } = useSidebarPreferences();
  // Collapsed, the label is hidden, so the button carries its name itself.
  return collapsed
    ? <Tooltip content={label} placement="right">{cloneElement(children, { "aria-label": label })}</Tooltip>
    : cloneElement(children, { title: label });
}

// The expanded sidebar's right edge: drag or use the arrow keys to resize,
// double-click to go back to the default width.
function SidebarResizer({ width }: { width: number }) {
  const resize = (next: number, persist = true) => setPreferences({ width: clampWidth(next) }, persist);
  const stop = () => {
    if (!document.documentElement.classList.contains("is-resizing-sidebar")) return;
    document.documentElement.classList.remove("is-resizing-sidebar");
    setPreferences({});
  };
  return (
    <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label={t("sidebar.resize")} tabIndex={0}
      aria-valuenow={width} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} title={t("sidebar.resizeHint")}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.classList.add("is-resizing-sidebar");
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        resize(event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left, false);
      }}
      onPointerUp={stop} onLostPointerCapture={stop} onDoubleClick={() => resize(DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") resize(width - 16);
        else if (event.key === "ArrowRight") resize(width + 16);
        else return;
        event.preventDefault();
      }} />
  );
}

const SECTIONS: { page: SidebarPage; label: () => string; icon: ReactNode }[] = [
  { page: "home", label: () => t("sidebar.home"), icon: <House size={18} /> },
  { page: "projects", label: () => t("sidebar.projects"), icon: <Gamepad2 size={18} /> },
  { page: "library", label: () => t("sidebar.library"), icon: <Image size={18} /> },
  { page: "community", label: () => t("sidebar.community"), icon: <Globe2 size={18} /> },
  { page: "plugins", label: () => t("sidebar.plugins"), icon: <Plug size={18} /> },
];

// The pages' sidebar, flat on the app background: search, the sections,
// recent projects, then the update and the account, whose menu holds
// settings. It collapses to icons, and its edge drags to resize.
export function AppSidebar({ active, onNavigate }: { active?: SidebarActive; onNavigate: (page: AppNavigationTarget) => void }) {
  const { collapsed, width, recentOpen, narrow } = useSidebarPreferences();
  const projects = useRecentProjects(active);
  const history = useHistoryState();
  const mac = window.ohMyGameDesktop?.platform === "darwin";
  const toggle = () => setPreferences({ collapsed: !collapsed });
  const toggleButton = narrow ? null : (
    <IconButton size="sm" label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")} onClick={toggle}>
      <PanelToggle size={18} />
    </IconButton>
  );
  const foldRecent = () => setPreferences({ recentOpen: !recentOpen });

  return (
    <>
      <nav className="sidebar" aria-label={t("sidebar.mainNavigation")}>
        {/* On macOS the top row is the title bar. Expanded, it holds the window
            controls and the sidebar toggle at its right end. Collapsed, it spans
            the window: controls, back, forward, then the toggle. */}
        {mac ? (
          <div className="sidebar-titlebar">
            {collapsed ? <>
              <IconButton size="sm" label={t("sidebar.back")} disabled={!history.back} onClick={() => window.history.back()}><ArrowLeft size={16} /></IconButton>
              <IconButton size="sm" label={t("sidebar.forward")} disabled={!history.forward} onClick={() => window.history.forward()}><ArrowRight size={16} /></IconButton>
            </> : null}
            {toggleButton}
          </div>
        ) : null}
        <div className="sidebar-head">
          <button type="button" className="sidebar-brand" aria-label={t("sidebar.brandHome")} onClick={() => onNavigate("home")}>
            <BrandLogo size={22} /><span>OhMyGame</span>
          </button>
          {mac || collapsed ? null : toggleButton}
        </div>
        <div className="sidebar-group">
          {collapsed && !mac && !narrow ? <SidebarItem icon={<PanelToggle size={18} />} label={t("sidebar.expand")} onClick={toggle} /> : null}
          <SidebarItem icon={<Search size={18} />} label={t("sidebar.search")} shortcut={shortcut("k")} onClick={openCommandMenu} />
        </div>
        <div className="sidebar-group">
          {SECTIONS.map((item) => (
            <SidebarItem key={item.page} icon={item.icon} label={item.label()} active={active === item.page}
              onClick={() => onNavigate(item.page)} />
          ))}
        </div>
        {projects.length ? (
          <div className={`sidebar-group sidebar-recent${recentOpen ? "" : " is-folded"}`}>
            {/* The heading folds the list. Collapsed, a bare chevron does the
                same above the icons. */}
            {collapsed ? (
              <IconButton size="sm" className="sidebar-recent-fold" label={recentOpen ? t("sidebar.hideRecent") : t("sidebar.showRecent")}
                aria-expanded={recentOpen} onClick={foldRecent}>
                {recentOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </IconButton>
            ) : (
              <button type="button" className="sidebar-label sidebar-label-fold" aria-expanded={recentOpen} onClick={foldRecent}>
                {t("sidebar.recent")}<ChevronRight size={12} className="sidebar-label-caret" />
              </button>
            )}
            {recentOpen ? projects.slice(0, SIDEBAR_RECENT).map((project) => {
              const open = () => { window.location.hash = projectHash(project.id); };
              return collapsed ? (
                <SidebarTip key={project.id} label={project.name}>
                  <button type="button" className="sidebar-app" aria-label={project.name} onClick={open}>
                    <SidebarCover project={project} className="sidebar-app-cover" iconSize={18} />
                  </button>
                </SidebarTip>
              ) : (
                <SidebarItem key={project.id} icon={<SidebarCover project={project} className="sidebar-cover" iconSize={12} />} label={project.name} onClick={open} />
              );
            }) : null}
          </div>
        ) : null}
        <span className="sidebar-spacer" />
        <div className="sidebar-group">
          <UpdateItem />
          <AccountMenu active={active === "settings"} avatarSize={collapsed ? 28 : 24} onNavigate={onNavigate} />
        </div>
      </nav>
      {collapsed ? null : <SidebarResizer width={width} />}
    </>
  );
}

const HOVER_OPEN = 220;
const HOVER_CLOSE = 160;

/** The open project's conversations, for its icon in the rail. */
export interface RailConversations {
  items: readonly ConversationSummary[];
  current?: string;
  onOpen: (conversationId: string) => void;
  onNew: () => void;
}

/** "Edited 3 hours ago", from when a project or conversation last changed. */
export function editedAgo(value: string, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "second");
}

// A recent project in the rail. Hovering it lists that project's
// conversations, so switching between them, or to another project, is one move.
// From the keyboard, the right arrow opens the list and the arrows move through
// it; the left arrow or Escape goes back to the icon.
function RailProject({ project, open: openProject, conversations }: {
  project: ProjectState;
  open: (hash: string) => void;
  /** Given for the open project; other projects load theirs on hover. */
  conversations?: RailConversations;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const focusFirst = useRef(false);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<readonly ConversationSummary[]>();
  const active = !!conversations;
  const items = conversations?.items ?? loaded ?? [];
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open || active) return;
    let disposed = false;
    void listConversations(project.id).then((next) => {
      if (!disposed) setLoaded(next);
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [open, active, project.id]);
  const focusInside = () => !!body.current?.contains(document.activeElement);
  const menuItems = () => [...(body.current?.querySelectorAll<HTMLButtonElement>(".rail-popover-item") ?? [])];
  useEffect(() => {
    if (!open || !focusFirst.current) return;
    const first = menuItems()[0];
    if (!first) return;
    focusFirst.current = false;
    first.focus();
  }, [open, items.length]);
  const hover = (next: boolean) => {
    window.clearTimeout(timer.current);
    // The pointer leaving doesn't close a list the keyboard is in.
    if (!next && focusInside()) return;
    timer.current = window.setTimeout(() => setOpen(next), next ? HOVER_OPEN : HOVER_CLOSE);
  };
  // Closing now also drops a pending hover, which would open it again. Focus
  // inside the list goes back to the icon.
  const close = () => {
    window.clearTimeout(timer.current);
    focusFirst.current = false;
    if (focusInside()) anchor.current?.focus();
    setOpen(false);
  };
  const pick = (conversationId: string) => {
    close();
    if (conversations) conversations.onOpen(conversationId);
    else openProject(conversationHash(project.id, conversationId));
  };
  return (
    <>
      <button ref={anchor} type="button" className={`sidebar-app${active ? " is-active" : ""}`} aria-label={project.name}
        aria-current={active ? "page" : undefined} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => {
          close();
          if (!active) openProject(projectHash(project.id));
        }}
        onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          window.clearTimeout(timer.current);
          focusFirst.current = true;
          setOpen(true);
          menuItems()[0]?.focus();
        }}
        onBlur={(event) => {
          // Leaving before the list loaded cancels moving into it.
          if (!focusFirst.current || body.current?.contains(event.relatedTarget as Node | null)) return;
          close();
        }}>
        <SidebarCover project={project} className="sidebar-app-cover" iconSize={18} />
      </button>
      <Popover open={open} onClose={close} anchor={anchor} placement="right-start" className="rail-popover"
        label={t("sidebar.projectConversations", { name: project.name })}>
        <div ref={body} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}
          onKeyDown={(event) => {
            const list = menuItems();
            const at = list.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const step = event.key === "ArrowDown" ? 1 : -1;
              list[(at + step + list.length) % list.length]?.focus();
            } else if (event.key === "ArrowLeft") close();
            else return;
            event.preventDefault();
          }}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && (body.current?.contains(next) || anchor.current?.contains(next))) return;
            close();
          }}>
          <div className="rail-popover-head">
            <strong>{project.name}</strong>
            <small>{t("sidebar.editedAgo", { time: editedAgo(project.updatedAt) })}</small>
          </div>
          {[...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => (
            <button key={item.id} type="button" className={`rail-popover-item${item.id === conversations?.current ? " is-current" : ""}`}
              aria-current={item.id === conversations?.current ? "true" : undefined} onClick={() => pick(item.id)}>
              <MessageCircle size={14} />
              <span>{item.title}</span>
              <small>{editedAgo(item.updatedAt)}</small>
            </button>
          ))}
          {conversations ? (
            <button type="button" className="rail-popover-item rail-popover-new" onClick={() => {
              close();
              conversations.onNew();
            }}>
              <CirclePlus size={14} /><span>{t("projectShell.newConversation")}</span>
            </button>
          ) : null}
        </div>
      </Popover>
    </>
  );
}

// Inside a project the app's sections step aside: the rail keeps the way home,
// the recent projects (with their conversations on hover), a new project,
// search and the account. The pages' sidebar comes back on the way out.
// `onLeave` runs before anything here leaves the project, so the project can
// save first.
export function ProjectRail({ projectId, project, conversations, onNavigate, onLeave }: {
  projectId: string;
  /** The open project, listed even when it isn't among the recent ones. */
  project?: ProjectState;
  conversations?: RailConversations;
  onNavigate: (page: AppNavigationTarget) => void;
  onLeave: (go: () => void) => void;
}) {
  const latest = useRecentProjects();
  const recent = !project || latest.some((item) => item.id === project.id)
    ? latest : [...latest.slice(0, RECENT_LIMIT - 1), project];
  const history = useHistoryState();
  const [creating, setCreating] = useState(false);
  const leaveTo = (page: AppNavigationTarget) => onLeave(() => onNavigate(page));
  const openHash = (hash: string) => onLeave(() => { window.location.hash = hash; });
  return (
    <nav className="sidebar project-rail" aria-label={t("sidebar.projectNavigation")}>
      {/* Back and forward lead the title bar: here, over the rail, beside the
          macOS window controls or at the window's edge where the system draws
          the title bar; on Windows they follow the window's menus instead. */}
      {!hasWindowsTitleBar() ? (
        <div className="sidebar-titlebar">
          <IconButton size="sm" label={t("sidebar.back")} disabled={!history.back} onClick={() => onLeave(() => window.history.back())}><ArrowLeft size={16} /></IconButton>
          <IconButton size="sm" label={t("sidebar.forward")} disabled={!history.forward} onClick={() => onLeave(() => window.history.forward())}><ArrowRight size={16} /></IconButton>
        </div>
      ) : null}
      <div className="sidebar-head">
        <Tooltip content={t("sidebar.home")} placement="right-start">
          <button type="button" className="sidebar-brand" aria-label={t("sidebar.brandHome")} onClick={() => leaveTo("home")}>
            <BrandLogo size={22} />
          </button>
        </Tooltip>
      </div>
      <div className="sidebar-group sidebar-recent">
        {recent.map((project) => (
          <RailProject key={project.id} project={project} open={openHash}
            conversations={project.id === projectId ? conversations : undefined} />
        ))}
        <Tooltip content={t("sidebar.newProject")} placement="right-start">
          <button type="button" className="sidebar-app sidebar-app-new" aria-label={t("sidebar.newProject")} onClick={() => setCreating(true)}>
            <CirclePlus size={16} />
          </button>
        </Tooltip>
      </div>
      {creating ? <ProjectCreateDialog
        onClose={() => setCreating(false)}
        onOpenProject={(id) => { setCreating(false); openHash(projectHash(id)); }}
        onCreated={(created) => { setCreating(false); openHash(projectHash(created.id, createdProjectView(created.type))); }}
      /> : null}
      <span className="sidebar-spacer" />
      <div className="sidebar-group">
        <SidebarItem icon={<Search size={18} />} label={t("sidebar.search")} onClick={openCommandMenu} />
        <UpdateItem />
        <AccountMenu active={false} avatarSize={28} onNavigate={leaveTo} />
      </div>
    </nav>
  );
}

function openSettings(section: "account" | "about"): void {
  window.location.hash = settingsHash(section);
}

// The account at the foot of the sidebar: your avatar and name, or Sign in
// while signed out. Its menu holds settings either way.
function AccountMenu({ active, avatarSize, onNavigate }: { active: boolean; avatarSize: number; onNavigate: (page: AppNavigationTarget) => void }) {
  const auth = useAuth();
  const signedIn = auth.state.status === "signed-in" ? auth.state.user : undefined;
  const loading = auth.state.status === "loading";
  const name = signedIn?.name ?? (loading ? t("sidebar.loadingAccount") : t("common.signIn"));
  const settings: MenuEntry = { label: t("common.settings"), icon: <Settings size={16} />, shortcut: shortcut(","), onSelect: () => onNavigate("settings") };
  const about: MenuEntry = { label: t("sidebar.about"), icon: <InfoCircle size={16} />, onSelect: () => openSettings("about") };
  const items: MenuEntry[] = signedIn ? [
    settings,
    { label: t("sidebar.account"), icon: <UserRound size={16} />, onSelect: () => openSettings("account") },
    "separator",
    about,
  ] : [
    // Signed out, the menu leads with signing in; settings stay one step away.
    { label: t("sidebar.signInEllipsis"), icon: <LogIn size={16} />, disabled: loading, onSelect: auth.openSignIn },
    settings,
    "separator",
    about,
  ];
  return (
    <DropdownMenu placement="top-start" items={items} trigger={(props) => (
      <button type="button" {...props} className={`sidebar-account${active ? " is-active" : ""}`} title={signedIn?.email ?? name}>
        {signedIn ? (
          <span className="sidebar-avatar" style={{ width: avatarSize, height: avatarSize }}>
            <UserAvatar className="sidebar-avatar-image" name={signedIn.name} avatarUrl={signedIn.avatarUrl} />
          </span>
        ) : (
          <span className="sidebar-guest" style={{ width: avatarSize, height: avatarSize }} aria-hidden="true"><UserRound size={16} /></span>
        )}
        <span className="sidebar-item-label"><strong>{name}</strong></span>
      </button>
    )} />
  );
}

// A desktop update needs you only twice, to start it and to restart; it stays
// out of sight otherwise. A failure leads to About, which says why.
function UpdateItem() {
  const status = useDesktopUpdate()?.status;
  const updates = window.ohMyGameDesktop?.updates;
  if (!status || !updates) return null;
  switch (status.type) {
    case "available":
      return <SidebarItem icon={<ArrowDownToLine size={18} />} dot="accent" label={t("sidebar.updateTo", { version: status.version })}
        onClick={() => void updates.download()} />;
    case "downloading":
      return (
        <div className="sidebar-item sidebar-update" role="progressbar" aria-label={t("sidebar.downloadingUpdate")}
          title={t("sidebar.downloadProgress", { percent: status.percent })} aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
          <span className="sidebar-item-icon" aria-hidden="true"><ArrowDownToLine size={18} /></span>
          <span className="sidebar-item-label">{t("sidebar.downloadProgress", { percent: status.percent })}</span>
          <span className="sidebar-update-bar" style={{ width: `${status.percent}%` }} />
        </div>
      );
    case "ready":
      return <SidebarItem icon={<RefreshCircle size={18} />} dot="accent" label={t("sidebar.restartToUpdate")}
        onClick={() => void updates.install()} />;
    case "error":
      return <SidebarItem icon={<DangerCircle size={18} />} dot="warning" label={t("sidebar.updateFailed")}
        onClick={() => openSettings("about")} />;
    default:
      return null;
  }
}
