import { AudioLines, Box, Cpu, Folder, Gamepad2, House, Images, Library, MoreHorizontal, Plug, Video } from "lucide-react";
import type { ReactNode } from "react";

type SidebarPage = "home" | "community" | "images";

interface AppSidebarProps {
  active: SidebarPage;
  onCommunity: () => void;
  onHome?: () => void;
  onImages?: () => void;
}

export function AppSidebar({ active, onCommunity, onHome, onImages }: AppSidebarProps) {
  return (
    <aside className="home-sidebar">
      <div className="home-sidebar-traffic" aria-hidden="true">
        <span className="home-sidebar-traffic-red" />
        <span className="home-sidebar-traffic-yellow" />
        <span className="home-sidebar-traffic-green" />
      </div>
      <nav aria-label="Main navigation">
        <div className="home-nav-label">WORKSPACE</div>
        <NavigationItem active={active === "home"} icon={<House size={16} />} label="Home" onClick={onHome} />
        <NavigationItem active={false} icon={<Folder size={16} />} label="Projects" />
        <NavigationItem active={false} icon={<Library size={16} />} label="Library" />
        <NavigationItem active={false} icon={<Plug size={16} />} label="Plugins" />
        <div className="home-nav-label home-nav-label-spaced">STUDIOS</div>
        <NavigationItem active={false} icon={<Box size={16} />} label="AVG Studio" />
        <div className="home-nav-label home-nav-label-spaced">TOOLS</div>
        <NavigationItem active={false} icon={<Box size={16} />} label="3D" />
        <NavigationItem active={active === "images"} icon={<Images size={16} />} label="Images" onClick={onImages} />
        <NavigationItem active={false} icon={<AudioLines size={16} />} label="Audio" />
        <NavigationItem active={false} icon={<Video size={16} />} label="Video" />
        <NavigationItem active={false} icon={<Cpu size={16} />} label="Model Hub" />
        <div className="home-nav-label home-nav-label-spaced">DISCOVER</div>
        <NavigationItem active={active === "community"} icon={<Gamepad2 size={16} />} label="Community" onClick={onCommunity} />
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
  onClick?: () => void;
}) {
  const content = <>{icon}<span>{label}</span></>;
  if (active) return <div className="home-nav-item home-nav-item-active" aria-current="page">{content}</div>;
  if (!onClick) return <div className="home-nav-item" aria-disabled="true">{content}</div>;
  return (
    <button
      className="home-nav-item"
      type="button"
      onClick={onClick}
    >
      {content}
    </button>
  );
}
