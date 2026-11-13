import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { packageSkills, type SkillsSource } from "../src/daemon/plugin-conversion.js";
import { isAppWidePlugin } from "../src/shared/plugin-manifest.js";
import type { PluginCategory } from "../src/shared/plugin-manifest.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";
import { git, replaceDirectory } from "./runtime-directory.js";

interface LockedPlugin {
  pluginId: string;
  releaseId: string;
  /** A package in this repository, bundled as it is rather than cloned. */
  source?: string;
  repository?: string;
  commit?: string;
  release?: string;
  version: string;
  artifactSha256?: string;
  /** The plugin's name, after `ohmygame/`. */
  name?: string;
  /** Where its Skills are in the repository. */
  skills?: string | string[];
  assets?: string;
  interface?: NonNullable<SkillsSource["interface"]> & { shortDescription: string };
  categories?: PluginCategory[];
}

interface LockFile {
  version: 1;
  plugins: LockedPlugin[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(path.join(repositoryRoot, "config", "preinstalled-plugins.json"), "utf8")) as LockFile;
if (lock.version !== 1 || !Array.isArray(lock.plugins)) throw new Error("Invalid preinstalled Plugin lock file");

const output = path.join(repositoryRoot, ".runtime", "preinstalled-plugins");
const lockHash = createHash("sha256").update(JSON.stringify(lock));
for (const entry of lock.plugins) {
  if (entry.assets) lockHash.update(await createPluginArchive(path.resolve(repositoryRoot, entry.assets)));
  if (entry.source) lockHash.update(await createPluginArchive(path.resolve(repositoryRoot, entry.source)));
}
const lockSha256 = lockHash.digest("hex");

if (await isCurrentOutput(output, lockSha256)) {
  console.log(`Reusing ${lock.plugins.length} prepared preinstalled Plugin${lock.plugins.length === 1 ? "" : "s"}`);
} else {
  await preparePlugins(output, lockSha256);
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
      if (entry.source) {
        if (!entry.version) throw new Error(`Preinstalled plugin source has no version: ${entry.source}`);
        const source = path.resolve(repositoryRoot, entry.source);
        if (!source.startsWith(`${repositoryRoot}${path.sep}`))
          throw new Error(`Preinstalled plugin source must stay inside this repository: ${entry.source}`);
        const manifest = JSON.parse(await readFile(path.join(source, ".ohmygame-plugin", "plugin.json"), "utf8")) as { id?: unknown; version?: unknown };
        if (typeof manifest.id !== "string" || typeof manifest.version !== "string") throw new Error(`${entry.source} has no valid plugin manifest`);
        if (manifest.version !== entry.version) throw new Error(`${entry.source} version ${manifest.version} does not match its lock entry ${entry.version}`);
        const archive = await createPluginArchive(source);
        const artifactSha256 = createHash("sha256").update(archive).digest("hex");
        if (entry.artifactSha256 && artifactSha256 !== entry.artifactSha256) throw new Error(`Plugin archive checksum mismatch for ${entry.source}: ${artifactSha256}`);
        const artifactFile = `${entry.releaseId}.zip`;
        await writeFile(path.join(prepared, artifactFile), archive);
        plugins.push({
          pluginId: entry.pluginId,
          releaseId: entry.releaseId,
          id: manifest.id,
          version: entry.version,
          artifactFile,
          artifactSha256,
          artifactBytes: archive.length,
          origin: { type: "github", repository: "WhiteTowerAI/ohmygame", commit: (await git(["rev-parse", "HEAD"])).trim() },
        });
        continue;
      }
      if (!entry.repository || !entry.commit || !entry.name || !entry.skills || !entry.interface || !entry.artifactSha256) throw new Error("Invalid remote preinstalled Plugin lock entry");
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
