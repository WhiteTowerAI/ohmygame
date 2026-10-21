import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES, PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES, type InstallPluginRequest, type PluginDetail, type PluginManifest } from "../shared/plugins.js";
import { extractArchive, type ArchiveExtractionFailure } from "./archive-extraction.js";
import { LocalPluginError, validatePluginBundle, type LocalPluginStore } from "./local-plugins.js";
import { discoverPlugins, type DiscoveredPlugin } from "./plugin-discovery.js";

const GIT_TIMEOUT_MS = 60_000;

export type GitRunner = (args: string[]) => Promise<string>;

export async function installPlugin(store: LocalPluginStore, input: InstallPluginRequest, git: GitRunner = runGit): Promise<PluginDetail> {
  return withResolvedSource(input, git, async (root, provenance) => {
    await validatePluginBundle(root);
    const candidates = await discoverPlugins(root);
    const candidate = selectCandidate(candidates, input.candidate);
    return store.install(root, provenance, candidate.manifest, candidate.marketplace);
  });
}

export async function inspectPluginSource(input: InstallPluginRequest, git: GitRunner = runGit): Promise<DiscoveredPlugin[]> {
  return withResolvedSource(input, git, async (root) => {
    await validatePluginBundle(root);
    return discoverPlugins(root);
  });
}

export async function installPreparedPlugin(
  store: LocalPluginStore,
  input: { pluginId: string; releaseId: string; manifest: PluginManifest; archive: Buffer },
): Promise<PluginDetail> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ohmygame-preinstalled-plugin-"));
  const archivePath = path.join(temporaryRoot, "plugin.zip");
  const source = path.join(temporaryRoot, "plugin");
  try {
    await writeFile(archivePath, input.archive, { flag: "wx" });
    await mkdir(source);
    await extractPluginArchive(archivePath, source);
    return await store.installPrepared(source, { type: "preinstalled", pluginId: input.pluginId, releaseId: input.releaseId }, input.manifest);
  } catch (cause) {
    if (cause instanceof LocalPluginError) throw cause;
    throw new LocalPluginError(`Could not install preinstalled Plugin: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function withResolvedSource<T>(
  input: InstallPluginRequest,
  git: GitRunner,
  operation: (root: string, provenance: { type: "directory"; path: string } | { type: "git"; url: string; commit: string }) => Promise<T>,
): Promise<T> {
  if (input.type === "directory") {
    if (!path.isAbsolute(input.path)) throw new LocalPluginError("Plugin directory must be an absolute path");
    const source = path.resolve(input.path);
    return operation(source, { type: "directory", path: source });
  }
  const url = validatedGitUrl(input.url);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-"));
  const clonePath = path.join(temporaryRoot, "repository");
  try {
    await git(["clone", "--depth", "1", "--no-recurse-submodules", "--", url, clonePath]);
    const commit = (await git(["-C", clonePath, "rev-parse", "HEAD"])).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new LocalPluginError("Git repository returned an invalid commit");
    await rm(path.join(clonePath, ".git"), { recursive: true, force: true });
    return await operation(clonePath, { type: "git", url, commit });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function selectCandidate(candidates: DiscoveredPlugin[], key: string | undefined): DiscoveredPlugin {
  if (key) {
    const selected = candidates.find((candidate) => candidate.key === key);
    if (!selected) throw new LocalPluginError("Selected Plugin was not found in the source");
    return selected;
  }
  if (candidates.length !== 1) throw new LocalPluginError("Choose a Plugin from this marketplace before installing");
  return candidates[0]!;
}

export function validatedGitUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new LocalPluginError("Enter a valid Git URL");
  }
  if (url.protocol !== "https:") throw new LocalPluginError("Git URL must use HTTPS");
  if (url.username || url.password) throw new LocalPluginError("Git URL must not contain credentials");
  if (url.hostname.toLowerCase() === "github.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      url.pathname = `/${segments[0]}/${segments[1]!.replace(/\.git$/, "")}.git`;
      url.search = "";
      url.hash = "";
    }
  }
  return url.toString();
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, GIT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new LocalPluginError(cause.code === "ENOENT" ? "Git is not installed" : `Could not start Git: ${cause.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new LocalPluginError("Git operation timed out", 408));
      else if (code === 0) resolve(stdout);
      else reject(new LocalPluginError(stderr.trim() || `Git exited with code ${code ?? "unknown"}`));
    });
  });
}

const PLUGIN_ARCHIVE_ERRORS: Record<ArchiveExtractionFailure, string> = {
  "invalid-zip": "Plugin is not a valid ZIP archive",
  unreadable: "Plugin archive could not be read",
  "too-large": "Plugin archive is too large",
  "invalid-path": "Plugin archive contains an invalid path",
  "symbolic-link": "Plugin archive contains a symbolic link",
  "duplicate-path": "Plugin archive contains the same path twice",
};

export function extractPluginArchive(archivePath: string, destination: string): Promise<void> {
  return extractArchive(archivePath, destination, {
    maxEntries: PLUGIN_ARCHIVE_MAX_ENTRIES,
    maxBytes: PLUGIN_ARCHIVE_MAX_BYTES,
    include: (relative) => {
      const segments = relative.split("/").filter(Boolean);
      if (segments.includes("node_modules")) throw new LocalPluginError(PLUGIN_ARCHIVE_ERRORS["invalid-path"]);
      if (segments.some((part, index) => part.startsWith(".") && (
        index !== 0 || !PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES.includes(part)
      ))) {
        throw new LocalPluginError("Plugin archive contains private files");
      }
      return true;
    },
    error: (reason) => new LocalPluginError(PLUGIN_ARCHIVE_ERRORS[reason]),
  });
}
