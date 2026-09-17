import { ArrowDownToLine, LogOut, MoreHorizontal, RefreshCw, UserRound, Wrench } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAuth } from "./auth.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { UserAvatar } from "./user-avatar.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";

interface AppSidebarProps {
  active: SidebarPage;
  onNavigate: (page: AppNavigationTarget) => void;
}

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 272;
const SIDEBAR_WIDTH_STORAGE_KEY = "open-game-sidebar-width";

export function AppSidebar({ active, onNavigate }: AppSidebarProps) {
  const auth = useAuth();
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const account = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizingRef = useRef(false);

  useLayoutEffect(() => {
    sidebar.current?.parentElement?.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!account.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [accountMenuOpen]);

  useEffect(() => {
    const updates = window.openGameDesktop?.updates;
    if (!updates) return;
    let disposed = false;
    void updates.state().then((state) => {
      if (!disposed) setUpdate(state);
    }).catch(() => undefined);
    const unsubscribe = updates.onState(setUpdate);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const updateStatus = update?.status.type;
  const updateAction = updateStatus === "available"
    ? { label: "Update", icon: <ArrowDownToLine size={15} />, action: () => void window.openGameDesktop?.updates.download() }
    : updateStatus === "ready"
      ? { label: "Restart", icon: <RefreshCw size={14} />, action: () => void window.openGameDesktop?.updates.install() }
      : undefined;
  const updateButton = updateAction ? (
    <button className="home-sidebar-update" type="button" aria-label={updateAction.label} onClick={updateAction.action}>
      {updateAction.icon}<span>{updateAction.label}</span>
    </button>
  ) : null;

  function resize(clientX: number): void {
    const shell = sidebar.current?.parentElement;
    const bounds = shell?.getBoundingClientRect();
    if (!shell || !bounds) return;
    const width = clampSidebarWidth(Math.round(clientX - bounds.left));
    sidebarWidthRef.current = width;
    shell.style.setProperty("--sidebar-width", `${width}px`);
  }

  function finishResize(): void {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    setResizing(false);
    setSidebarWidth(sidebarWidthRef.current);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidthRef.current));
  }

  function resetWidth(): void {
    sidebarWidthRef.current = DEFAULT_SIDEBAR_WIDTH;
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH));
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const nextWidth = clampSidebarWidth(sidebarWidthRef.current + direction * 8);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
  }

  return (
    <aside className={`home-sidebar${resizing ? " home-sidebar-resizing" : ""}`} ref={sidebar}>
      {resizing ? <div className="home-sidebar-resize-shield" /> : null}
      <div className="home-sidebar-traffic" aria-hidden="true">
        <span className="home-sidebar-traffic-red" />
        <span className="home-sidebar-traffic-yellow" />
        <span className="home-sidebar-traffic-green" />
      </div>
      <nav aria-label="Main navigation">
        <NavigationItem active={active === "home"} icon="home" label="Home" onClick={() => onNavigate("home")} />
        <NavigationItem active={active === "projects"} icon="project" label="Projects" onClick={() => onNavigate("projects")} />
        <NavigationItem active={active === "library"} icon="library" label="Library" onClick={() => onNavigate("library")} />
        <NavigationItem active={active === "plugins"} icon="plugins" label="Plugins" onClick={() => onNavigate("plugins")} />
        <div className="home-nav-label home-nav-label-spaced">STUDIOS</div>
        <NavigationItem active={active === "interactive-drama"} icon="interactive-drama" label="Interactive Drama" onClick={() => onNavigate("interactive-drama")} />
        <NavigationItem active={active === "asset-studio"} icon="asset-studio" label="Asset Studio" onClick={() => onNavigate("asset-studio")} />
        <div className="home-nav-label home-nav-label-spaced">EXPLORE</div>
        <NavigationItem active={active === "games"} icon="games" label="Games" onClick={() => onNavigate("games")} />
        <NavigationItem active={active === "assets"} icon="assets" label="Assets" onClick={() => onNavigate("assets")} />
      </nav>
      {auth.state.status === "signed-in" ? (
        <div className="home-sidebar-account" ref={account}>
          <button className="home-sidebar-account-main" type="button" aria-label="Open account menu" aria-expanded={accountMenuOpen} onClick={() => {
            setAccountError(undefined);
            setAccountMenuOpen((open) => !open);
          }}>
            <UserAvatar className="home-sidebar-avatar" name={auth.state.user.name} avatarUrl={auth.state.user.avatarUrl} />
            <span className="home-sidebar-account-name" title={auth.state.user.email}>{auth.state.user.name}</span>
          </button>
          {updateButton}
          {accountMenuOpen ? (
            <div className="home-sidebar-account-popover" role="menu">
              <button type="button" role="menuitem" onClick={() => {
                setAccountMenuOpen(false);
                onNavigate("settings");
              }}>
                <Wrench size={16} />
                <span>Settings</span>
              </button>
              <button className="home-sidebar-account-sign-out" type="button" role="menuitem" onClick={() => void auth.signOut().then(() => {
                setAccountMenuOpen(false);
              }).catch((error) => {
                setAccountError(errorMessage(error));
              })}>
                <LogOut size={16} />
                <span>Sign out</span>
              </button>
              {accountError ? <p className="home-sidebar-account-error" role="alert">{accountError}</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="home-sidebar-account" ref={account}>
          <button className="home-sidebar-sign-in-main" type="button" onClick={auth.openSignIn} disabled={auth.state.status === "loading"}>
            <span className="home-sidebar-signed-out-icon" aria-hidden="true"><UserRound size={16} /></span>
            <span className="home-sidebar-account-name">{auth.state.status === "loading" ? "Loading account" : "Sign in"}</span>
          </button>
          {updateButton ?? <button className="home-sidebar-account-menu" type="button" aria-label="Application menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}><MoreHorizontal size={16} /></button>}
          {accountMenuOpen ? (
            <div className="home-sidebar-account-popover" role="menu">
              <button type="button" role="menuitem" onClick={() => {
                setAccountMenuOpen(false);
                onNavigate("settings");
              }}>
                <Wrench size={16} />
                <span>Settings</span>
              </button>
            </div>
          ) : null}
        </div>
      )}
      <div
        className="home-sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onDoubleClick={resetWidth}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizingRef.current = true;
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          finishResize();
        }}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
      />
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
}

function NavigationItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: "home" | "project" | "library" | "plugins" | "asset-studio" | "interactive-drama" | "games" | "assets";
  label: string;
  onClick: () => void;
}) {
  const content = <><span className={`home-nav-icon home-nav-icon-${icon}`} aria-hidden="true" /><span>{label}</span></>;
  return (
    <button
      className={`home-nav-item${active ? " home-nav-item-active" : ""}`}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </button>
  );
}
