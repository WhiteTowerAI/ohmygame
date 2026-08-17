interface UserAvatarProps {
  avatarUrl?: string;
  className: string;
  name: string;
}

export function UserAvatar({ avatarUrl, className, name }: UserAvatarProps) {
  return avatarUrl
    ? <img className={className} src={avatarUrl} alt="" referrerPolicy="no-referrer" />
    : <span className={className} aria-hidden="true">{initials(name)}</span>;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "OG";
}
