export const PUBLISH_GAME_TITLE_MAX_LENGTH = 200;
export const PUBLISH_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const PUBLISH_GAME_COVER_PATH = "__ohmygame/cover.webp";

export type PublishListingStatus = "listed" | "unlisted";

export type CommunitySubjectType = "game";

export interface CommunityAuthor {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

export interface CommunityStats {
  likes: number;
  uses: number;
}

export interface CommunityViewerState {
  liked: boolean;
}

export interface CommunityInteractionResult extends CommunityViewerState {
  stats: CommunityStats;
}

export interface PublishGame {
  id: string;
  publisherId: string;
  title: string;
  description: string;
  playUrl: string;
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
  playUrl: string;
  coverUrl?: string;
  publishedAt: string;
  author: CommunityAuthor;
  stats: CommunityStats;
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

export interface CreatePublishDeploymentResult {
  deployment: PublishDeployment;
  game: PublishGame;
}


export type PublishErrorCode =
  | "authentication_required"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "idempotency_conflict"
  | "artifact_invalid"
  | "artifact_too_large"
  | "internal_error";

export interface PublishApiError {
  error: {
    code: PublishErrorCode;
    message: string;
    requestId: string;
  };
}
