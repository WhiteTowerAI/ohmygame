import { AudioLines, Box, Cpu, Folder, Gamepad2, House, Images, Library, MoreHorizontal, Plug, Video } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SidebarPage } from "./routes.js";

interface AppSidebarProps {
  active: SidebarPage;
  onNavigate: (page: SidebarPage) => void;
}

const DEFAULT_SIDEBAR_WIDTH = 232;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 272;
const SIDEBAR_WIDTH_STORAGE_KEY = "open-game-sidebar-width";

export function AppSidebar({ active, onNavigate }: AppSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizingRef = useRef(false);

  useLayoutEffect(() => {
    sidebar.current?.parentElement?.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

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
        <div className="home-nav-label">WORKSPACE</div>
        <NavigationItem active={active === "home"} icon={<House size={16} />} label="Home" onClick={() => onNavigate("home")} />
        <NavigationItem active={active === "projects"} icon={<Folder size={16} />} label="Projects" onClick={() => onNavigate("projects")} />
        <NavigationItem active={active === "library"} icon={<Library size={16} />} label="Library" onClick={() => onNavigate("library")} />
        <NavigationItem active={active === "plugins"} icon={<Plug size={16} />} label="Plugins" onClick={() => onNavigate("plugins")} />
        <div className="home-nav-label home-nav-label-spaced">STUDIOS</div>
        <NavigationItem active={active === "avg-studio"} icon={<Box size={16} />} label="AVG Studio" onClick={() => onNavigate("avg-studio")} />
        <div className="home-nav-label home-nav-label-spaced">TOOLS</div>
        <NavigationItem active={active === "3d"} icon={<Box size={16} />} label="3D" onClick={() => onNavigate("3d")} />
        <NavigationItem active={active === "images"} icon={<Images size={16} />} label="Images" onClick={() => onNavigate("images")} />
        <NavigationItem active={active === "audio"} icon={<AudioLines size={16} />} label="Audio" onClick={() => onNavigate("audio")} />
        <NavigationItem active={active === "video"} icon={<Video size={16} />} label="Video" onClick={() => onNavigate("video")} />
        <NavigationItem active={active === "model-hub"} icon={<Cpu size={16} />} label="Model Hub" onClick={() => onNavigate("model-hub")} />
        <div className="home-nav-label home-nav-label-spaced">DISCOVER</div>
        <NavigationItem active={active === "community"} icon={<Gamepad2 size={16} />} label="Community" onClick={() => onNavigate("community")} />
      </nav>
      <div className="home-sidebar-account">
        <span className="home-sidebar-avatar" aria-hidden="true">HD</span>
        <span className="home-sidebar-account-name">Di Huang</span>
        <button className="home-sidebar-account-menu" type="button" aria-label="Account menu" title="Account menu">
          <MoreHorizontal size={16} />
        </button>
      </div>
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

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readSidebarWidth(): number {
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
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const content = <>{icon}<span>{label}</span></>;
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
