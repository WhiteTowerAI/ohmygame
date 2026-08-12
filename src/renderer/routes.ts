export type AppRoute =
  | { page: "home" }
  | { page: "community" }
  | { page: "project"; projectId: string };

export function parseAppRoute(hash: string): AppRoute {
  if (hash === "#/community") return { page: "community" };
  const match = /^#\/projects\/([^/]+)$/.exec(hash);
  if (!match?.[1]) return { page: "home" };
  try {
    return { page: "project", projectId: decodeURIComponent(match[1]) };
  } catch {
    return { page: "home" };
  }
}

export function projectHash(projectId: string): string {
  return `#/projects/${encodeURIComponent(projectId)}`;
}
