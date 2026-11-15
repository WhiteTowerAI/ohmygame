import { isPluginId } from "./plugin-manifest.js";
import { isPluginVersion, npmPackagePluginIds, type PluginOrigin } from "./plugins.js";

export interface PreparedPluginRelease {
  pluginId: string;
  releaseId: string;
  /** The plugin the archive holds. */
  id: string;
  version: string;
  artifactFile: string;
  artifactSha256: string;
  artifactBytes: number;
  origin: PluginOrigin;
}

export interface PreparedPluginIndex {
  version: 1;
  plugins: PreparedPluginRelease[];
}

export function isPreparedPluginIndex(value: unknown): value is PreparedPluginIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Partial<PreparedPluginIndex>;
  return index.version === 1 && Array.isArray(index.plugins) && index.plugins.every(isPreparedPluginRelease)
    && ["pluginId", "releaseId", "id", "artifactFile"].every((key) =>
      new Set(index.plugins!.map((entry) => entry[key as keyof PreparedPluginRelease])).size === index.plugins!.length);
}

function isPreparedPluginRelease(value: unknown): value is PreparedPluginRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plugin = value as Partial<PreparedPluginRelease>;
  return [plugin.pluginId, plugin.releaseId, plugin.id, plugin.version, plugin.artifactFile, plugin.artifactSha256]
    .every((item) => typeof item === "string" && item.length > 0)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:zip|tgz)$/.test(plugin.artifactFile!)
    && /^[a-f0-9]{64}$/.test(plugin.artifactSha256!)
    && Number.isSafeInteger(plugin.artifactBytes) && plugin.artifactBytes! > 0
    && isPluginId(plugin.id!)
    && (plugin.origin?.type === "npm"
      ? plugin.origin.registry === "npmjs" && typeof plugin.origin.package === "string"
        && plugin.origin.package.startsWith("@ohmygame/") && Boolean(npmPackagePluginIds(plugin.origin.package)?.includes(plugin.id!))
        && plugin.origin.version === plugin.version && isPluginVersion(plugin.version)
      : plugin.artifactFile!.endsWith(".zip") && plugin.origin?.type === "github"
    && typeof plugin.origin.repository === "string" && plugin.origin.repository.length > 0
    && typeof plugin.origin.commit === "string" && plugin.origin.commit.length > 0
    && (plugin.origin.release === undefined || typeof plugin.origin.release === "string"));
}
