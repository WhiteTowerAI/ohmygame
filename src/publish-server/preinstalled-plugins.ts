import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES, PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES } from "../shared/plugins.js";
import { isPreparedPluginIndex } from "../shared/preinstalled-plugins.js";
import type { ArtifactStore } from "./artifacts.js";
import type { PublishStore, StoredPlugin, StoredPluginRelease } from "./store.js";

export async function seedPreparedPlugins(directory: string, store: PublishStore, artifacts: ArtifactStore): Promise<void> {
  const value = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8")) as unknown;
  if (!isPreparedPluginIndex(value)) throw new Error("Invalid preinstalled Plugin index");
  for (const entry of value.plugins) {
    const archive = path.join(directory, entry.artifactFile);
    const contents = await readFile(archive);
    const digest = createHash("sha256").update(contents).digest("hex");
    if (contents.length !== entry.artifactBytes || digest !== entry.artifactSha256) {
      throw new Error(`Preinstalled Plugin archive failed verification: ${entry.name}`);
    }
    if (!await artifacts.exists(entry.releaseId, "plugin.zip")) {
      const temporary = artifacts.temporaryFile(entry.releaseId, ".zip");
      await cp(archive, temporary, { errorOnExist: true, force: false });
      await artifacts.installArchive(temporary, entry.releaseId, {
        archiveFileName: "plugin.zip",
        allowedHiddenDirectories: PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES,
        limits: { expandedBytes: PLUGIN_ARCHIVE_MAX_BYTES, fileBytes: PLUGIN_ARCHIVE_MAX_BYTES, files: PLUGIN_ARCHIVE_MAX_ENTRIES },
      });
    }
    const plugin: StoredPlugin = {
      id: entry.pluginId,
      publisherId: entry.publisher.id,
      name: entry.name,
      currentReleaseId: entry.releaseId,
      createdAt: entry.publishedAt,
      updatedAt: entry.publishedAt,
      origin: entry.origin,
      curation: entry.curation,
    };
    const release: StoredPluginRelease = {
      id: entry.releaseId,
      pluginId: entry.pluginId,
      version: entry.version,
      artifactSha256: entry.artifactSha256,
      artifactBytes: entry.artifactBytes,
      manifest: entry.manifest,
      skills: entry.skills,
      publishedAt: entry.publishedAt,
    };
    store.seedPlugin(plugin, release, entry.publisher);
  }
}
