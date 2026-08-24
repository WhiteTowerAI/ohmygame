export type SidebarPage =
  | "home"
  | "projects"
  | "library"
  | "plugins"
  | "avg-studio"
  | "asset-studio"
  | "community";

const SIDEBAR_PAGES = new Set<SidebarPage>([
  "home", "projects", "library", "plugins", "avg-studio", "asset-studio", "community",
]);

export type AppRoute =
  | { page: SidebarPage }
  | { page: "community-game"; gameId: string }
  | { page: "project"; projectId: string; conversationId?: string };

export function parseAppRoute(hash: string): AppRoute {
  if (hash === "#/" || hash === "") return { page: "home" };
  const sidebarMatch = /^#\/([^/]+)$/.exec(hash);
  if (sidebarMatch?.[1] && SIDEBAR_PAGES.has(sidebarMatch[1] as SidebarPage)) {
    return { page: sidebarMatch[1] as SidebarPage };
  }
  const communityGameMatch = /^#\/community\/games\/([^/]+)$/.exec(hash);
  if (communityGameMatch?.[1]) {
    try {
      return { page: "community-game", gameId: decodeURIComponent(communityGameMatch[1]) };
    } catch {
      return { page: "home" };
    }
  }
  const conversationMatch = /^#\/projects\/([^/]+)\/conversations\/([^/]+)$/.exec(hash);
  const projectMatch = /^#\/projects\/([^/]+)$/.exec(hash);
  const match = conversationMatch ?? projectMatch;
  if (!match?.[1]) return { page: "home" };
  try {
    return {
      page: "project",
      projectId: decodeURIComponent(match[1]),
      ...(conversationMatch?.[2] ? { conversationId: decodeURIComponent(conversationMatch[2]) } : {}),
    };
  } catch {
    return { page: "home" };
  }
}

export function sidebarHash(page: SidebarPage): string {
  return page === "home" ? "#/" : `#/${page}`;
}

export function projectHash(projectId: string): string {
  return `#/projects/${encodeURIComponent(projectId)}`;
}

export function conversationHash(projectId: string, conversationId: string): string {
  return `${projectHash(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
}

export function communityGameHash(gameId: string): string {
  return `#/community/games/${encodeURIComponent(gameId)}`;
}
