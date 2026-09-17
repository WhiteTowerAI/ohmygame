export type PlayTarget = { kind: "game" | "deployment"; id: string };

export function gameUrl(playOrigin: string, gameId: string): string {
  return playUrl(playOrigin, "g", gameId);
}

export function deploymentUrl(playOrigin: string, deploymentId: string): string {
  return playUrl(playOrigin, "d", deploymentId);
}

export function playTarget(host: string | undefined, playOrigin: string): PlayTarget | undefined {
  if (!host) return undefined;
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = new URL(playOrigin).hostname.toLowerCase();
  const match = new RegExp(`^([gd])-([0-9a-f-]+)\\.${escapeRegExp(suffix)}$`, "i").exec(hostname);
  if (!match || !isId(match[2])) return undefined;
  return { kind: match[1].toLowerCase() === "g" ? "game" : "deployment", id: match[2].toLowerCase() };
}

function playUrl(origin: string, prefix: "g" | "d", id: string): string {
  const url = new URL(origin);
  url.hostname = `${prefix}-${id}.${url.hostname}`;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
