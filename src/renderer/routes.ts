export type SidebarPage =
  | "home"
  | "projects"
  | "library"
  | "plugins"
  | "interactive-drama"
  | "asset-studio"
  | "games"
  | "assets";

export type SettingsSection = "account" | "appearance" | "providers" | "connections" | "about";
export type AppNavigationTarget = SidebarPage | "settings";

const SIDEBAR_PAGES = new Set<SidebarPage>([
  "home", "projects", "library", "plugins", "interactive-drama", "asset-studio", "games", "assets",
]);

export type AppRoute =
  | { page: SidebarPage }
  | { page: "settings"; section: SettingsSection }
  | { page: "game"; gameId: string }
  | { page: "playtest"; projectId: string; chapterId: string }
  | { page: "project"; projectId: string; conversationId?: string };

export function parseAppRoute(hash: string): AppRoute {
  if (hash === "#/" || hash === "") return { page: "home" };
  const settingsMatch = /^#\/settings(?:\/(account|appearance|providers|connections|about))?$/.exec(hash);
  if (settingsMatch) return { page: "settings", section: (settingsMatch[1] as SettingsSection | undefined) ?? "account" };
  const sidebarMatch = /^#\/([^/]+)$/.exec(hash);
  if (sidebarMatch?.[1] && SIDEBAR_PAGES.has(sidebarMatch[1] as SidebarPage)) {
    return { page: sidebarMatch[1] as SidebarPage };
  }
  const gameMatch = /^#\/games\/([^/]+)$/.exec(hash);
  if (gameMatch?.[1]) {
    try {
      return { page: "game", gameId: decodeURIComponent(gameMatch[1]) };
    } catch {
      return { page: "home" };
    }
  }
  const playtestMatch = /^#\/playtest\/([^/]+)\/([^/]+)$/.exec(hash);
  if (playtestMatch?.[1] && playtestMatch[2]) {
    try {
      return {
        page: "playtest",
        projectId: decodeURIComponent(playtestMatch[1]),
        chapterId: decodeURIComponent(playtestMatch[2]),
      };
    } catch {
      return { page: "home" };
    }
  }
  const studioConversationMatch = /^#\/projects\/([^/]+)\/interactive-drama\/conversations\/([^/]+)$/.exec(hash);
  const studioMatch = /^#\/projects\/([^/]+)\/interactive-drama$/.exec(hash);
  const conversationMatch = /^#\/projects\/([^/]+)\/conversations\/([^/]+)$/.exec(hash);
  const projectMatch = /^#\/projects\/([^/]+)$/.exec(hash);
  const match = studioConversationMatch ?? studioMatch ?? conversationMatch ?? projectMatch;
  if (!match?.[1]) return { page: "home" };
  try {
    const encodedConversationId = studioConversationMatch?.[2] ?? conversationMatch?.[2];
    return {
      page: "project",
      projectId: decodeURIComponent(match[1]),
      ...(encodedConversationId ? { conversationId: decodeURIComponent(encodedConversationId) } : {}),
    };
  } catch {
    return { page: "home" };
  }
}

export function sidebarHash(page: SidebarPage): string {
  return page === "home" ? "#/" : `#/${page}`;
}

export function settingsHash(section: SettingsSection): string {
  return `#/settings/${section}`;
}

export function projectHash(projectId: string): string {
  return `#/projects/${encodeURIComponent(projectId)}`;
}

export function conversationHash(projectId: string, conversationId: string): string {
  return `${projectHash(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
}

export function gameHash(gameId: string): string {
  return `#/games/${encodeURIComponent(gameId)}`;
}

export function playtestHash(projectId: string, chapterId: string): string {
  return `#/playtest/${encodeURIComponent(projectId)}/${encodeURIComponent(chapterId)}`;
}
