import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { packageSkills, type SkillsSource } from "../src/daemon/plugin-conversion.js";
import { isAppWidePlugin } from "../src/shared/plugin-manifest.js";
import type { PluginCategory } from "../src/shared/plugin-manifest.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";
import { isLockedNpmPlugin, prepareNpmPlugin, unpackPinnedNpmPlugin, type LockedNpmPlugin } from "./preinstalled-npm.js";
import { MINIMAX_MIGRATION_PACKAGES } from "../src/daemon/minimax-migration-package.js";
import { git, replaceDirectory } from "./runtime-directory.js";

interface LockedSkillsPlugin {
  type?: "skills";
  pluginId: string;
  releaseId: string;
  repository: string;
  commit: string;
  release?: string;
  version: string;
  artifactSha256: string;
  /** The plugin's name, after `ohmygame/`. */
  name: string;
  /** Where its Skills are in the repository. */
  skills: string | string[];
  assets?: string;
  interface: NonNullable<SkillsSource["interface"]> & { shortDescription: string };
  categories?: PluginCategory[];
}

interface LockFile {
  version: 1;
  plugins: (LockedSkillsPlugin | LockedNpmPlugin)[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(path.join(repositoryRoot, "config", "preinstalled-plugins.json"), "utf8")) as LockFile;
if (lock.version !== 1 || !Array.isArray(lock.plugins)) throw new Error("Invalid preinstalled Plugin lock file");

const output = path.join(repositoryRoot, ".runtime", "preinstalled-plugins");
const lockHash = createHash("sha256").update(JSON.stringify(lock));
for (const entry of lock.plugins) {
  if ("assets" in entry && entry.assets) lockHash.update(await createPluginArchive(path.resolve(repositoryRoot, entry.assets)));
}
const lockSha256 = lockHash.digest("hex");

if (await isCurrentOutput(output, lockSha256)) {
  console.log(`Reusing ${lock.plugins.length} prepared preinstalled Plugin${lock.plugins.length === 1 ? "" : "s"}`);
} else {
  await preparePlugins(output, lockSha256);
}

// Disposable test and panel-regression inputs, never shipped as a second copy.
// Re-extract even on cache hits so local edits cannot alter the test baseline.
const sources = await mkdtemp(path.join(path.dirname(output), "preinstalled-sources-"));
try {
  const packages = path.join(sources, "packages");
  await mkdir(packages);
  for (const entry of lock.plugins) {
    if (entry.type !== "npm") continue;
    if (!isLockedNpmPlugin(entry)) throw new Error("Invalid pinned npm plugin");
    const directory = await mkdtemp(path.join(sources, "extract-"));
    const root = await unpackPinnedNpmPlugin(entry, path.join(output, `${entry.releaseId}.tgz`), directory);
    await rename(root, path.join(packages, entry.package.split("/")[1]!));
  }
  await replaceDirectory(packages, path.join(repositoryRoot, ".runtime", "preinstalled-plugin-sources"));
} finally {
  await rm(sources, { recursive: true, force: true });
}

async function preparePlugins(destination: string, expectedLockSha256: string): Promise<void> {
  const runtimeDirectory = path.dirname(destination);
  await mkdir(runtimeDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(runtimeDirectory, "preinstalled-plugins-build-"));
  const prepared = path.join(temporary, "output");
  await mkdir(prepared);
  try {
    const plugins: PreparedPluginIndex["plugins"] = [];
    for (const entry of lock.plugins) {
      if (entry.type === "npm") {
        if (!isLockedNpmPlugin(entry)) throw new Error("Invalid pinned npm plugin");
        const folder = await mkdtemp(path.join(temporary, "npm-"));
        const archive = await prepareNpmPlugin(entry, folder);
        const artifactFile = `${entry.releaseId}.tgz`;
        await writeFile(path.join(prepared, artifactFile), archive);
        plugins.push({
          pluginId: entry.pluginId, releaseId: entry.releaseId, id: entry.id, version: entry.version,
          artifactFile, artifactSha256: createHash("sha256").update(archive).digest("hex"), artifactBytes: archive.length,
          origin: { type: "npm", package: entry.package, version: entry.version, registry: "npmjs" },
        });
        continue;
      }
      const source = path.join(temporary, entry.pluginId);
      await git(["clone", "--quiet", "--no-checkout", `https://github.com/${entry.repository}.git`, source]);
      await git(["-c", "core.autocrlf=false", "-C", source, "checkout", "--quiet", entry.commit]);
      const actualCommit = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
      if (actualCommit !== entry.commit) throw new Error(`Unexpected commit for ${entry.repository}: ${actualCommit}`);
      await rm(path.join(source, ".git"), { recursive: true, force: true });
      if (entry.assets) await cp(path.resolve(repositoryRoot, entry.assets), path.join(source, "assets"), { recursive: true });

      // It ships as a package that only adds Skills, so it applies by itself.
      const converted = path.join(temporary, `${entry.pluginId}-package`);
      const conversion = await packageSkills({
        root: source,
        manifest: { name: entry.name, version: entry.version, description: entry.interface.shortDescription, skills: entry.skills, interface: entry.interface },
      }, converted, {
        id: `ohmygame/${entry.name}`,
        ...(entry.categories ? { categories: entry.categories } : {}),
      });
      if (!isAppWidePlugin(conversion.entry.manifest)) throw new Error(`${entry.repository} doesn't package as a plugin that applies by itself`);
      const archive = await createPluginArchive(converted);
      const artifactSha256 = createHash("sha256").update(archive).digest("hex");
      if (artifactSha256 !== entry.artifactSha256) {
        throw new Error(`Plugin archive checksum mismatch for ${entry.repository}: ${artifactSha256}`);
      }
      const artifactFile = `${entry.releaseId}.zip`;
      await writeFile(path.join(prepared, artifactFile), archive);
      plugins.push({
        pluginId: entry.pluginId,
        releaseId: entry.releaseId,
        id: conversion.entry.id,
        version: entry.version,
        artifactFile,
        artifactSha256,
        artifactBytes: archive.length,
        origin: { type: "github", repository: entry.repository, commit: entry.commit, ...(entry.release ? { release: entry.release } : {}) },
      });
    }
    const index: PreparedPluginIndex = { version: 1, plugins };
    if (!isPreparedPluginIndex(index)) throw new Error("Generated preinstalled Plugin index is invalid");
    await writeFile(path.join(prepared, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    await writeFile(path.join(prepared, "lock.sha256"), `${expectedLockSha256}\n`);
    await replaceDirectory(prepared, destination);
    console.log(`Prepared ${plugins.length} preinstalled Plugin${plugins.length === 1 ? "" : "s"}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function isCurrentOutput(directory: string, expectedLockSha256: string): Promise<boolean> {
  try {
    if ((await readFile(path.join(directory, "lock.sha256"), "utf8")).trim() !== expectedLockSha256) return false;
    const parsed: unknown = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
    if (!isPreparedPluginIndex(parsed) || parsed.plugins.length !== lock.plugins.length) return false;
    for (const plugin of parsed.plugins) {
      const artifact = await readFile(path.join(directory, plugin.artifactFile));
      if (artifact.length !== plugin.artifactBytes || createHash("sha256").update(artifact).digest("hex") !== plugin.artifactSha256) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

// A verified integration fixture for migration of an already-installed optional
// plugin. It does not join the preinstalled index or grant/install anything.
for (const pin of MINIMAX_MIGRATION_PACKAGES) {
  const migrationOutput = path.join(repositoryRoot, ".runtime", "minimax-migration-packages", pin.version);
  await mkdir(path.dirname(migrationOutput), { recursive: true });
  const migrationStage = await mkdtemp(path.join(repositoryRoot, ".runtime", "minimax-package-"));
  try {
    const archive = path.join(migrationStage, "package.tgz");
    try { await cp(path.join(migrationOutput, "package.tgz"), archive); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const download = await mkdtemp(path.join(migrationStage, "download-"));
      await writeFile(archive, await prepareNpmPlugin(pin, download));
      await rm(download, { recursive: true, force: true });
    }
    const extraction = path.join(migrationStage, "verified");
    await mkdir(extraction);
    const root = await unpackPinnedNpmPlugin(pin, archive, extraction);
    await rename(root, path.join(migrationStage, "source"));
    await rm(extraction, { recursive: true, force: true });
    await replaceDirectory(migrationStage, migrationOutput);
  } finally { await rm(migrationStage, { recursive: true, force: true }); }
}
