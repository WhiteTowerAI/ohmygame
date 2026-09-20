import type { CommunitySection } from "./routes.js";
import { Box, Film, Gamepad2, Image, Music2, type IconComponent } from "./icons.js";

const COMMUNITY_SECTIONS: readonly { id: CommunitySection; label: string; icon: IconComponent }[] = [
  { id: "games", label: "Games", icon: Gamepad2 },
  { id: "images", label: "Images", icon: Image },
  { id: "videos", label: "Videos", icon: Film },
  { id: "audio", label: "Audio", icon: Music2 },
  { id: "models", label: "3D Models", icon: Box },
];

export function CommunityCategories({ active, onChange }: {
  active: CommunitySection;
  onChange: (section: CommunitySection) => void;
}) {
  return (
    <nav className="library-filters community-categories" aria-label="Community categories">
      {COMMUNITY_SECTIONS.map(({ id, label, icon: Icon }) => (
        <button type="button" aria-current={active === id ? "page" : undefined} className={active === id ? "is-active" : ""} key={id} onClick={() => onChange(id)}>
          <Icon size={15} /><span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
