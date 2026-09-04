import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  publisher: { id: string; displayName: string };
  curation?: "featured";
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
const temporary = await mkdtemp(path.join(tmpdir(), "open-game-preinstalled-plugins-"));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

try {
  const plugins: PreparedPluginIndex["plugins"] = [];
  for (const entry of lock.plugins) {
    const source = path.join(temporary, entry.pluginId);
    await git(["clone", "--quiet", "--no-checkout", `https://github.com/${entry.repository}.git`, source]);
    await git(["-C", source, "checkout", "--quiet", entry.commit]);
    const actualCommit = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    if (actualCommit !== entry.commit) throw new Error(`Unexpected commit for ${entry.repository}: ${actualCommit}`);
    const publishedAt = (await git(["-C", source, "show", "-s", "--format=%cI", entry.commit])).trim();
    await rm(path.join(source, ".git"), { recursive: true, force: true });

    const candidates = await discoverPlugins(source);
    const selected = candidates.find((candidate) => candidate.key === entry.candidate);
    if (!selected) throw new Error(`Plugin candidate ${entry.candidate} was not found in ${entry.repository}`);
    const manifest: ResolvedPluginManifest = {
      ...selected.manifest,
      version: entry.version,
      interface: { ...selected.manifest.interface, ...entry.interface },
    };
    const detail = await inspectPluginBundle(source, {
      idPrefix: "opengame:",
      marketplace: { id: "opengame", displayName: "OpenGame" },
      source: { type: "catalog", pluginId: entry.pluginId, releaseId: entry.releaseId },
    }, undefined, manifest);
    const archive = await createPluginArchive(source);
    const artifactSha256 = createHash("sha256").update(archive).digest("hex");
    if (artifactSha256 !== entry.artifactSha256) {
      throw new Error(`Plugin archive checksum mismatch for ${entry.repository}: ${artifactSha256}`);
    }
    const artifactFile = `${entry.releaseId}.zip`;
    await writeFile(path.join(output, artifactFile), archive);
    plugins.push({
      pluginId: entry.pluginId,
      releaseId: entry.releaseId,
      name: manifest.name,
      version: entry.version,
      publishedAt,
      artifactFile,
      artifactSha256,
      artifactBytes: archive.length,
      manifest,
      skills: detail.skills.map(({ id, name, description }) => ({
        id,
        name: id === "SKILL.md" ? selected.displayName : name,
        description: description ?? (id === "SKILL.md" ? selected.description : undefined),
      })),
      publisher: entry.publisher,
      origin: { type: "github", repository: entry.repository, commit: entry.commit, ...(entry.release ? { release: entry.release } : {}) },
      ...(entry.curation ? { curation: entry.curation } : {}),
    });
  }
  const index: PreparedPluginIndex = { version: 1, plugins };
  if (!isPreparedPluginIndex(index)) throw new Error("Generated preinstalled Plugin index is invalid");
  await writeFile(path.join(output, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Prepared ${plugins.length} preinstalled Plugin${plugins.length === 1 ? "" : "s"}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
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
