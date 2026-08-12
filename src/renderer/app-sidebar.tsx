import { Gamepad2, House, Wrench } from "lucide-react";
import type { ReactNode } from "react";

type SidebarPage = "home" | "community" | "tools";

interface AppSidebarProps {
  active: SidebarPage;
  onCommunity: () => void;
  onHome?: () => void;
  onTools?: () => void;
}

export function AppSidebar({ active, onCommunity, onHome, onTools }: AppSidebarProps) {
  return (
    <aside className="home-sidebar">
      <div className="home-sidebar-brand">OpenGame</div>
      <nav aria-label="Main navigation">
        <div className="home-nav-label">WORKSPACE</div>
        <NavigationItem active={active === "home"} icon={<House size={16} />} label="Home" onClick={onHome} />
        <NavigationItem active={active === "community"} icon={<Gamepad2 size={16} />} label="Community" onClick={onCommunity} />
        <NavigationItem active={active === "tools"} icon={<Wrench size={16} />} label="Tools" onClick={onTools} />
      </nav>
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
