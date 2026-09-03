export const PUBLISH_GAME_TITLE_MAX_LENGTH = 200;
export const PUBLISH_ASSET_TITLE_MAX_LENGTH = 200;
export const PUBLISH_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

export type PublishListingStatus = "listed" | "unlisted";

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
  publishedAt: string;
}

export interface CreatePublishGameRequest {
  title: string;
  description?: string;
}

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

export type PublishAssetMediaType = "image" | "video" | "audio" | "model";

export interface PublishAsset {
  id: string;
  publisherId: string;
  title: string;
  description: string;
  mediaType: PublishAssetMediaType;
  currentReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishAssetRelease {
  id: string;
  assetId: string;
  artifactSha256: string;
  artifactBytes: number;
  fileName: string;
  contentType: string;
  publishedAt: string;
}

export interface PublishExploreAsset {
  id: string;
  title: string;
  description: string;
  mediaType: PublishAssetMediaType;
  releaseId: string;
  artifactSha256: string;
  artifactBytes: number;
  fileName: string;
  contentType: string;
  publishedAt: string;
}

export type PublishAssetListing = {
  assetId: string;
  updatedAt: string;
} & (
  | { status: "listed"; listedAt: string }
  | { status: "unlisted"; listedAt: null }
);

export interface CreatePublishAssetRequest {
  title: string;
  description?: string;
  mediaType: PublishAssetMediaType;
}

export interface CreatePublishAssetReleaseMetadata {
  artifactSha256: string;
  artifactBytes: number;
  fileName: string;
  contentType: string;
}

export interface CreatePublishAssetReleaseResult {
  asset: PublishAsset;
  release: PublishAssetRelease;
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
