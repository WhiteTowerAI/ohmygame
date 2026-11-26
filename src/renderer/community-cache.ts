import type { CommunityGame } from "../shared/contracts.js";
import type { CommunityProfile } from "../shared/publish-v1.js";
import type { AuthState } from "./auth.js";
import { DEFAULT_COMMUNITY_FILTERS, type CommunityFilters } from "./community-filters.js";

/**
 * What the Community pages last loaded in this window. Going back to a page,
 * or opening a game seen on one, shows this at once while a fresh read runs.
 * It belongs to one viewer: likes and an owner's hidden works never carry over
 * to another account or a signed-out window.
 */
let viewer: string | undefined;
const games = new Map<string, CommunityGame>();
let listIds: string[] | undefined;
// A profile's total is its listed games' likes as they are now, plus any it
// counts beyond them, so likes and removed games change it without bookkeeping.
const profiles = new Map<string, { author: CommunityProfile["author"]; otherLikes: number; ids: string[] }>();
let listFilters: CommunityFilters = { ...DEFAULT_COMMUNITY_FILTERS };
const scrollPositions = new Map<string, number>();

export function communityViewer(state: AuthState): string {
  return state.status === "signed-in" ? `user:${state.user.id}` : "visitor";
}

function forViewer(current: string): void {
  if (viewer === current) return;
  viewer = current;
  games.clear();
  listIds = undefined;
  profiles.clear();
}

function keep(list: CommunityGame[]): string[] {
  for (const game of list) games.set(game.id, game);
  return list.map((game) => game.id);
}

function read<T extends CommunityGame>(ids: string[]): T[] {
  return ids.flatMap((id) => {
    const game = games.get(id);
    return game ? [game as T] : [];
  });
}

export function cachedGames(current: string): CommunityGame[] | undefined {
  forViewer(current);
  return listIds && read(listIds);
}

export function keepGames(current: string, list: CommunityGame[]): void {
  forViewer(current);
  listIds = keep(list);
}

/** A game from its detail, a list or a profile, whichever was read last. */
export function cachedGame(current: string, gameId: string): CommunityGame | undefined {
  forViewer(current);
  return games.get(gameId);
}

/** Related games before the service answers: the list without this game. */
export function cachedRelatedGames(current: string, gameId: string, limit: number): CommunityGame[] {
  forViewer(current);
  return listIds ? read(listIds.filter((id) => id !== gameId).slice(0, limit)) : [];
}

export function keepGame(current: string, ...list: CommunityGame[]): void {
  forViewer(current);
  keep(list);
}

export function cachedProfile(current: string, authorId: string): CommunityProfile | undefined {
  forViewer(current);
  const profile = profiles.get(authorId);
  if (!profile) return undefined;
  const list = read<CommunityProfile["games"][number]>(profile.ids);
  return { author: profile.author, totalLikes: profile.otherLikes + likes(list), games: list };
}

export function keepProfile(current: string, profile: CommunityProfile): void {
  forViewer(current);
  profiles.set(profile.author.id, {
    author: profile.author,
    otherLikes: profile.totalLikes - likes(profile.games),
    ids: keep(profile.games),
  });
}

function likes(list: CommunityGame[]): number {
  return list.reduce((sum, game) => sum + (game.stats?.likeCount ?? 0), 0);
}

/** A change made on one page, such as a like or an edit, so the others show it too. */
export function updateCachedGame(current: string, gameId: string, change: Partial<CommunityGame>): void {
  forViewer(current);
  const game = games.get(gameId);
  if (game) games.set(gameId, { ...game, ...change });
}

export function forgetCachedGame(gameId: string): void {
  games.delete(gameId);
  listIds = listIds?.filter((id) => id !== gameId);
  for (const profile of profiles.values()) profile.ids = profile.ids.filter((id) => id !== gameId);
}

/** The list's search, sort and time filter, kept while the window is open. */
export function cachedListFilters(): CommunityFilters {
  return listFilters;
}

export function keepListFilters(filters: CommunityFilters): void {
  listFilters = filters;
}

export function cachedScrollTop(key: string): number {
  return scrollPositions.get(key) ?? 0;
}

export function keepScrollTop(key: string, top: number): void {
  scrollPositions.set(key, top);
}

/** For tests. */
export function resetCommunityCache(): void {
  viewer = undefined;
  games.clear();
  listIds = undefined;
  profiles.clear();
  listFilters = { ...DEFAULT_COMMUNITY_FILTERS };
  scrollPositions.clear();
}
