export type AppRoute =
  | { page: "home" }
  | { page: "community" }
  | { page: "tools" }
  | { page: "project"; projectId: string; conversationId?: string };

export function parseAppRoute(hash: string): AppRoute {
  if (hash === "#/community") return { page: "community" };
  if (hash === "#/tools") return { page: "tools" };
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

export function projectHash(projectId: string): string {
  return `#/projects/${encodeURIComponent(projectId)}`;
}

export function conversationHash(projectId: string, conversationId: string): string {
  return `${projectHash(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
}
