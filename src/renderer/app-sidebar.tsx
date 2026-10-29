import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  DangerCircle,
  Gamepad2,
  Globe2,
  House,
  Image,
  InfoCircle,
  LogIn,
  PanelToggle,
  Plug,
  RefreshCircle,
  Search,
  Settings,
  UserRound,
  Wallet,
} from "./icons.js";
import { getProjectCover, listProjects, waitForRuntime } from "./api.js";
import { useAuth } from "./auth.js";
import { BrandLogo } from "./brand-logo.js";
import { ProjectPlaceholder } from "./project-placeholder.js";
import { projectHash, settingsHash, type AppNavigationTarget, type SidebarPage } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { DropdownMenu, IconButton, type MenuEntry } from "./ui/index.js";
import { useDesktopUpdate } from "./use-desktop-update.js";
import { UserAvatar } from "./user-avatar.js";
import type { ProjectState } from "../shared/contracts.js";
import { t } from "./i18n.js";
import "./app-sidebar.css";

export type SidebarActive = SidebarPage | "settings";

const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 232;
const RECENT_LIMIT = 8;
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
const PAGES_WITH_PROJECT_LIST = new Set<SidebarActive>(["home", "projects", "general", "web-game", "interactive-story", "godot", "asset-canvas"]);
let recentProjects: ProjectState[] = [];
const recentListeners = new Set<() => void>();

export function publishRecentProjects(projects: readonly ProjectState[]): void {
  recentProjects = [...projects]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_LIMIT);
  for (const listener of recentListeners) listener();
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

// Covers load once per project version and stay while the app runs.
const covers = new Map<string, { version: string; url: Promise<string | undefined> }>();

function coverUrl(project: ProjectState): Promise<string | undefined> {
  const cached = covers.get(project.id);
  if (cached?.version === project.updatedAt) return cached.url;
  const url = getProjectCover(project.id)
    .then((cover) => (cover ? URL.createObjectURL(cover) : undefined))
    .catch(() => undefined);
  void cached?.url.then((previous) => previous && URL.revokeObjectURL(previous));
  covers.set(project.id, { version: project.updatedAt, url });
  return url;
}

function SidebarCover({ project, className }: { project: ProjectState; className: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void coverUrl(project).then((next) => {
      if (!disposed) setUrl(next);
    });
    return () => {
      disposed = true;
    };
  }, [project.id, project.updatedAt]);
  return (
    <span className={className} aria-hidden="true">
      {url ? <img src={url} alt="" onError={() => setUrl(undefined)} /> : <ProjectPlaceholder projectId={project.id} />}
    </span>
  );
}

/** The shortcut the app uses for settings. */
function settingsShortcut(): string {
  const platform = window.ohMyGameDesktop?.platform;
  return (platform ? platform === "darwin" : /Mac/.test(navigator.platform)) ? "⌘," : "Ctrl+,";
}

// The Navigation API (Chromium) says whether there is somewhere to go; the
// buttons stay enabled where it is missing.
interface NavigationLike extends EventTarget {
  canGoBack: boolean;
  canGoForward: boolean;
}

function useHistoryState() {
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

function SidebarItem({ icon, label, dot, active = false, onClick }: {
  icon: ReactNode;
  label: string;
  /** Marks the icon, so it shows in the collapsed sidebar too. */
  dot?: "accent" | "warning";
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`sidebar-item${active ? " is-active" : ""}`} title={label}
      aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="sidebar-item-icon" aria-hidden="true">{icon}{dot ? <span className={`sidebar-dot is-${dot}`} /> : null}</span>
      <span className="sidebar-item-label">{label}</span>
    </button>
  );
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
          <SidebarItem icon={<Search size={18} />} label={t("sidebar.search")} onClick={() => searchProjects(onNavigate)} />
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
            {recentOpen ? projects.map((project) => {
              const open = () => { window.location.hash = projectHash(project.id); };
              return collapsed ? (
                <button key={project.id} type="button" className="sidebar-app" title={project.name} aria-label={project.name} onClick={open}>
                  <SidebarCover project={project} className="sidebar-app-cover" />
                </button>
              ) : (
                <SidebarItem key={project.id} icon={<SidebarCover project={project} className="sidebar-cover" />} label={project.name} onClick={open} />
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

// Until the command menu moves over, search is the project list's search field.
let projectSearchRequested = false;

/** Whether the Projects page should focus its search field on mount, once. */
export function takeProjectSearchFocus(): boolean {
  const requested = projectSearchRequested;
  projectSearchRequested = false;
  return requested;
}

function searchProjects(onNavigate: (page: AppNavigationTarget) => void): void {
  const field = document.querySelector<HTMLInputElement>("#projects-search-input");
  if (field) {
    field.focus();
    return;
  }
  projectSearchRequested = true;
  onNavigate("projects");
}

function openSettings(section: "account" | "billing" | "about"): void {
  window.location.hash = settingsHash(section);
}

// The account at the foot of the sidebar: your avatar and name, or Sign in
// while signed out. Its menu holds settings either way.
function AccountMenu({ active, avatarSize, onNavigate }: { active: boolean; avatarSize: number; onNavigate: (page: AppNavigationTarget) => void }) {
  const auth = useAuth();
  const signedIn = auth.state.status === "signed-in" ? auth.state.user : undefined;
  const loading = auth.state.status === "loading";
  const name = signedIn?.name ?? (loading ? t("sidebar.loadingAccount") : t("common.signIn"));
  const settings: MenuEntry = { label: t("common.settings"), icon: <Settings size={16} />, shortcut: settingsShortcut(), onSelect: () => onNavigate("settings") };
  const about: MenuEntry = { label: t("sidebar.about"), icon: <InfoCircle size={16} />, onSelect: () => openSettings("about") };
  const items: MenuEntry[] = signedIn ? [
    settings,
    { label: t("sidebar.account"), icon: <UserRound size={16} />, onSelect: () => openSettings("account") },
    { label: t("sidebar.billing"), icon: <Wallet size={16} />, onSelect: () => openSettings("billing") },
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
