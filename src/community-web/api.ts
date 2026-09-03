import type { PublishApiError, PublishCommunityGame } from "../shared/publish-v1.js";

export function listCommunityGames(fetcher: typeof fetch = fetch): Promise<PublishCommunityGame[]> {
  return request("/v1/community/games", fetcher);
}

export function getCommunityGame(gameId: string, fetcher: typeof fetch = fetch): Promise<PublishCommunityGame> {
  return request(`/v1/community/games/${encodeURIComponent(gameId)}`, fetcher);
}

async function request<T>(pathname: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(pathname, { headers: { accept: "application/json" } });
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => undefined) as PublishApiError | undefined;
  throw new Error(body?.error.message ?? `Request failed with ${response.status}`);
}
