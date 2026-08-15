import { AudioLines, Box, Cpu, Folder, Gamepad2, House, Images, Library, MoreHorizontal, Plug, Video } from "lucide-react";
import type { ReactNode } from "react";
import type { SidebarPage } from "./routes.js";

interface AppSidebarProps {
  active: SidebarPage;
  onNavigate: (page: SidebarPage) => void;
}

export function AppSidebar({ active, onNavigate }: AppSidebarProps) {
  return (
    <aside className="home-sidebar">
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
    </aside>
  );
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
