export const PUBLISH_GAME_TITLE_MAX_LENGTH = 200;
export const PUBLISH_ASSET_TITLE_MAX_LENGTH = 200;
export const PUBLISH_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const PUBLISH_GAME_COVER_PATH = "__opengame/cover.webp";

export type PublishListingStatus = "listed" | "unlisted";

export type CommunitySubjectType = "game" | "asset" | "plugin" | "template";

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

export interface PublishPluginOrigin {
  type: "github";
  repository: string;
  commit: string;
  release?: string;
}

export type PublishPluginCuration = "featured";

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
  author: CommunityAuthor;
  stats: CommunityStats;
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

export interface PublishPlugin {
  id: string;
  publisherId: string;
  name: string;
  currentReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishTemplate {
  id: string;
  publisherId: string;
  name: string;
  currentReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishTemplateRelease {
  id: string;
  templateId: string;
  definition: import("./asset-templates.js").AssetTemplateDefinition;
  publishedAt: string;
}

export type PublishExploreTemplate = import("./asset-templates.js").AssetTemplateDefinition & {
  id: string;
  releaseId: string;
  publishedAt: string;
  author: CommunityAuthor;
  stats: CommunityStats;
};

export interface CreatePublishTemplateRequest {
  name: string;
}

export interface CreatePublishTemplateReleaseRequest {
  definition: import("./asset-templates.js").AssetTemplateDefinition;
}

export interface CreatePublishTemplateReleaseResult {
  template: PublishTemplate;
  release: PublishTemplateRelease;
}

export type PublishTemplateListing = {
  templateId: string;
  updatedAt: string;
} & (
  | { status: "listed"; listedAt: string }
  | { status: "unlisted"; listedAt: null }
);

export interface PublishPluginRelease {
  id: string;
  pluginId: string;
  version: string;
  artifactSha256: string;
  artifactBytes: number;
  publishedAt: string;
}

export interface PublishPluginSkill {
  id: string;
  name: string;
  description?: string;
}

export interface PublishExplorePlugin {
  id: string;
  name: string;
  version: string;
  releaseId: string;
  artifactSha256: string;
  artifactBytes: number;
  manifest: import("./plugins.js").PluginManifest;
  skills: PublishPluginSkill[];
  publishedAt: string;
  author: CommunityAuthor;
  stats: CommunityStats;
  origin?: PublishPluginOrigin;
  curation?: PublishPluginCuration;
}

export interface CreatePublishPluginRequest {
  name: string;
}

export interface CreatePublishPluginReleaseMetadata {
  artifactSha256: string;
  artifactBytes: number;
  manifest: import("./plugins.js").PluginManifest;
  skills: PublishPluginSkill[];
}

export interface CreatePublishPluginReleaseResult {
  plugin: PublishPlugin;
  release: PublishPluginRelease;
}

export type PublishPluginListing = {
  pluginId: string;
  updatedAt: string;
} & (
  | { status: "listed"; listedAt: string }
  | { status: "unlisted"; listedAt: null }
);

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
