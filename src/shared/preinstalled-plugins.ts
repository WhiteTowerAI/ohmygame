import type { CommunityAuthor, PublishPluginCuration, PublishPluginOrigin, PublishPluginSkill } from "./publish-v1.js";
import { isPluginManifest, type PluginManifest } from "./plugins.js";

export interface PreparedPluginRelease {
  pluginId: string;
  releaseId: string;
  name: string;
  version: string;
  publishedAt: string;
  artifactFile: string;
  artifactSha256: string;
  artifactBytes: number;
  manifest: PluginManifest;
  skills: PublishPluginSkill[];
  publisher: CommunityAuthor;
  origin: PublishPluginOrigin;
  curation?: PublishPluginCuration;
}

export interface PreparedPluginIndex {
  version: 1;
  plugins: PreparedPluginRelease[];
}

export function isPreparedPluginIndex(value: unknown): value is PreparedPluginIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Partial<PreparedPluginIndex>;
  return index.version === 1 && Array.isArray(index.plugins) && index.plugins.every(isPreparedPluginRelease);
}

function isPreparedPluginRelease(value: unknown): value is PreparedPluginRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plugin = value as Partial<PreparedPluginRelease>;
  return [plugin.pluginId, plugin.releaseId, plugin.name, plugin.version, plugin.publishedAt, plugin.artifactFile, plugin.artifactSha256]
    .every((item) => typeof item === "string" && item.length > 0)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(plugin.artifactFile!)
    && /^[a-f0-9]{64}$/.test(plugin.artifactSha256!)
    && Number.isSafeInteger(plugin.artifactBytes) && plugin.artifactBytes! > 0
    && isPluginManifest(plugin.manifest)
    && Array.isArray(plugin.skills) && plugin.skills.every(isPluginSkill)
    && Boolean(plugin.publisher
      && typeof plugin.publisher.id === "string" && plugin.publisher.id.length > 0
      && typeof plugin.publisher.displayName === "string" && plugin.publisher.displayName.length > 0
      && (plugin.publisher.avatarUrl === undefined || typeof plugin.publisher.avatarUrl === "string"))
    && plugin.origin?.type === "github"
    && typeof plugin.origin.repository === "string" && plugin.origin.repository.length > 0
    && typeof plugin.origin.commit === "string" && plugin.origin.commit.length > 0
    && (plugin.origin.release === undefined || typeof plugin.origin.release === "string")
    && (plugin.curation === undefined || plugin.curation === "featured");
}

function isPluginSkill(value: unknown): value is PublishPluginSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const skill = value as Partial<PublishPluginSkill>;
  return typeof skill.id === "string" && skill.id.length > 0
    && typeof skill.name === "string" && skill.name.length > 0
    && (skill.description === undefined || typeof skill.description === "string");
}
