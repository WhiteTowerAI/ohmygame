import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { discoverPlugins } from "../src/daemon/plugin-discovery.js";
import { inspectPluginBundle } from "../src/daemon/local-plugins.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";
import type { ResolvedPluginManifest } from "../src/shared/plugins.js";

interface LockedPlugin {
  pluginId: string;
  releaseId: string;
  repository: string;
  commit: string;
  release?: string;
  version: string;
  artifactSha256: string;
  candidate: string;
  interface?: NonNullable<ResolvedPluginManifest["interface"]>;
}

interface LockFile {
  version: 1;
  plugins: LockedPlugin[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(path.join(repositoryRoot, "config", "preinstalled-plugins.json"), "utf8")) as LockFile;
if (lock.version !== 1 || !Array.isArray(lock.plugins)) throw new Error("Invalid preinstalled Plugin lock file");

const output = path.join(repositoryRoot, ".runtime", "preinstalled-plugins");
const lockSha256 = createHash("sha256").update(JSON.stringify(lock)).digest("hex");

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
      const source = path.join(temporary, entry.pluginId);
      await git(["clone", "--quiet", "--no-checkout", `https://github.com/${entry.repository}.git`, source]);
      await git(["-c", "core.autocrlf=false", "-C", source, "checkout", "--quiet", entry.commit]);
      const actualCommit = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
      if (actualCommit !== entry.commit) throw new Error(`Unexpected commit for ${entry.repository}: ${actualCommit}`);
      await rm(path.join(source, ".git"), { recursive: true, force: true });

      const candidates = await discoverPlugins(source);
      const selected = candidates.find((candidate) => candidate.key === entry.candidate);
      if (!selected) throw new Error(`Plugin candidate ${entry.candidate} was not found in ${entry.repository}`);
      const manifest: ResolvedPluginManifest = {
        ...selected.manifest,
        version: entry.version,
        interface: { ...selected.manifest.interface, ...entry.interface },
      };
      await inspectPluginBundle(source, {
        idPrefix: "ohmygame:",
        marketplace: { id: "ohmygame", displayName: "OhMyGame" },
        source: { type: "preinstalled", pluginId: entry.pluginId, releaseId: entry.releaseId },
      }, undefined, manifest);
      const archive = await createPluginArchive(source);
      const artifactSha256 = createHash("sha256").update(archive).digest("hex");
      if (artifactSha256 !== entry.artifactSha256) {
        throw new Error(`Plugin archive checksum mismatch for ${entry.repository}: ${artifactSha256}`);
      }
      const artifactFile = `${entry.releaseId}.zip`;
      await writeFile(path.join(prepared, artifactFile), archive);
      plugins.push({
        pluginId: entry.pluginId,
        releaseId: entry.releaseId,
        name: manifest.name,
        version: entry.version,
        artifactFile,
        artifactSha256,
        artifactBytes: archive.length,
        manifest,
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

async function replaceDirectory(source: string, destination: string): Promise<void> {
  const backup = `${destination}.previous`;
  await rm(backup, { recursive: true, force: true });
  let hasBackup = false;
  try {
    await rename(destination, backup);
    hasBackup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(source, destination);
  } catch (error) {
    if (hasBackup) await rename(backup, destination);
    throw error;
  }
  if (hasBackup) await rm(backup, { recursive: true, force: true });
}

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git exited with ${code}`)));
  });
}
