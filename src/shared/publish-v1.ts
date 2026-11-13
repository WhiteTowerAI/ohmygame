import type { PublicationState } from "./contracts.js";

export const PUBLISH_GAME_TITLE_MAX_LENGTH = 200;
export const PUBLISH_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
export const PUBLISH_GAME_COVER_PATH = "__ohmygame/cover.webp";

export type PublishListingStatus = "listed" | "unlisted";

export interface CommunityAuthor {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

export interface PublishGame {
  id: string;
  publisherId: string;
  title: string;
  description: string;
  /** The current name in the game's page address. Missing from Cloud versions before names. */
  name?: string;
  /** The bare game, for embedding. Share `pageUrl` instead. */
  playUrl: string;
  /** The page to send players to: the game with the site's player around it. */
  pageUrl?: string;
  currentDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishDeployment {
  id: string;
  gameId: string;
  artifactSha256: string;
  versionUrl: string;
  coverUrl?: string;
  publishedAt: string;
}

interface PublishCommunityListingBase {
  gameId: string;
  updatedAt: string;
}

export type PublishCommunityListing = PublishCommunityListingBase & (
  | { status: "listed"; listedAt: string }
  | { status: "unlisted"; listedAt: null }
);

export interface PublishCommunityGame {
  id: string;
  title: string;
  description: string;
  deploymentId: string;
  name?: string;
  playUrl: string;
  pageUrl?: string;
  coverUrl?: string;
  publishedAt: string;
  author: CommunityAuthor;
  firstListedAt?: string;
  stats?: CommunityGameStats;
  listingStatus?: PublishListingStatus;
}

export interface CommunityGamesQuery {
  limit?: number;
  excludeGameId?: string;
}

export interface CommunityGameStats {
  /** Successful game entry requests since play counting was enabled. */
  viewCount: number;
  likeCount: number;
  liked?: boolean;
}

export interface ManagedCommunityGame extends PublishCommunityGame {
  listingStatus: PublishListingStatus;
  updatedAt: string;
}

export interface CommunityProfile {
  author: CommunityAuthor;
  games: ManagedCommunityGame[];
  totalLikes: number;
}

export interface CreatePublishGameRequest {
  title: string;
  description?: string;
}

export type UpdatePublishGameRequest = CreatePublishGameRequest;

export interface CreatePublishDeploymentMetadata {
  artifactSha256: string;
  artifactBytes: number;
}

export interface SetPublishListingRequest {
  status: PublishListingStatus;
}

export interface SetGameNameRequest {
  name: string;
}

export interface GameNameAvailability {
  /** The name as it would be stored: trimmed and lowercase. */
  name: string;
  available: boolean;
  reason?: "invalid" | "reserved" | "taken";
}

/** Lowercase letters, digits and inner hyphens, 3 to 32 characters; the Cloud also keeps some names. */
export const GAME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const GAME_NAME_MAX_LENGTH = 32;

export function normalizeGameName(value: string): string {
  return value.trim().toLowerCase();
}

/** The address to share: the game's page, or the bare game from a Cloud without pages. */
export function gameShareUrl(game: { playUrl: string; pageUrl?: string }): string {
  return game.pageUrl ?? game.playUrl;
}

/** What a project keeps of the game it published. */
export function publicationOf(game: Pick<PublishCommunityGame, "id" | "deploymentId" | "playUrl" | "publishedAt" | "title" | "description" | "name" | "pageUrl">): PublicationState {
  return {
    gameId: game.id,
    deploymentId: game.deploymentId,
    playUrl: game.playUrl,
    publishedAt: game.publishedAt,
    title: game.title,
    description: game.description,
    ...(game.name ? { name: game.name } : {}),
    ...(game.pageUrl ? { pageUrl: game.pageUrl } : {}),
  };
}

/** A game's new page name, as the Cloud answered a rename. */
export interface GameRename {
  gameId: string;
  name?: string;
  pageUrl?: string;
}

/** Whether a game has its page on the site, <site>/g/<name>, rather than only its bare play address. */
export function hasGamePage(game: { name?: string; pageUrl?: string }): boolean {
  return Boolean(game.name && game.pageUrl?.endsWith(`/g/${game.name}`));
}

/** A publication with the game's new page name, if it is still that game's. */
export function withRename(publication: PublicationState, renamed: GameRename): PublicationState {
  if (publication.gameId !== renamed.gameId) return publication;
  return { ...publication, ...(renamed.name ? { name: renamed.name } : {}), ...(renamed.pageUrl ? { pageUrl: renamed.pageUrl } : {}) };
}

/** An address as people read it: ohmygame.ai/g/zombie for https://www.ohmygame.ai/g/zombie. */
export function readableUrl(url: string): string {
  return url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "");
}

export interface CreatePublishDeploymentResult {
  deployment: PublishDeployment;
  game: PublishGame;
}


export type PublishErrorCode =
  | "authentication_required"
  | "visitor_invalid"
  | "rate_limited"
  | "origin_not_allowed"
  | "unavailable"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "idempotency_conflict"
  | "artifact_invalid"
  | "artifact_too_large"
  | "name_invalid"
  | "name_reserved"
  | "name_taken"
  | "internal_error";

export interface PublishApiError {
  error: {
    code: PublishErrorCode;
    message: string;
    requestId: string;
  };
}
