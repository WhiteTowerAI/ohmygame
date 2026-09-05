import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES, PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES, type InstallPluginRequest, type PluginDetail, type PluginManifest } from "../shared/plugins.js";
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

export async function installCatalogPlugin(
  store: LocalPluginStore,
  input: { pluginId: string; releaseId: string; manifest: PluginManifest; archive: Buffer; replaceId?: string },
): Promise<PluginDetail> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "open-game-catalog-plugin-"));
  const archivePath = path.join(temporaryRoot, "plugin.zip");
  const source = path.join(temporaryRoot, "plugin");
  try {
    await writeFile(archivePath, input.archive, { flag: "wx" });
    await mkdir(source);
    await extractPluginArchive(archivePath, source);
    return await store.installCatalog(source, { type: "catalog", pluginId: input.pluginId, releaseId: input.releaseId }, input.manifest, input.replaceId);
  } catch (cause) {
    if (cause instanceof LocalPluginError) throw cause;
    throw new LocalPluginError(`Could not install Catalog Plugin: ${cause instanceof Error ? cause.message : String(cause)}`);
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
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "open-game-plugin-"));
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

async function extractPluginArchive(archivePath: string, destination: string): Promise<void> {
  const zip = await openZip(archivePath);
  let entries = 0;
  let bytes = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      entries += 1;
      bytes += entry.uncompressedSize;
      if (entries > PLUGIN_ARCHIVE_MAX_ENTRIES || bytes > PLUGIN_ARCHIVE_MAX_BYTES || entry.uncompressedSize > PLUGIN_ARCHIVE_MAX_BYTES) {
        throw new LocalPluginError("Plugin archive is too large");
      }
      const relative = pluginArchivePath(entry);
      if (relative.endsWith("/")) {
        await mkdir(path.join(destination, relative), { recursive: true });
        continue;
      }
      const target = path.join(destination, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(await openEntry(zip, entry), createWriteStream(target, { flags: "wx" }));
    }
  } finally {
    zip.close();
  }
}

function pluginArchivePath(entry: Entry): string {
  const name = entry.fileName;
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new LocalPluginError("Plugin archive contains an invalid path");
  }
  const segments = name.split("/").filter(Boolean);
  if (!segments.length || segments.some((part) => part === "." || part === ".." || part === "node_modules")) {
    throw new LocalPluginError("Plugin archive contains an invalid path");
  }
  if (segments.some((part, index) => part.startsWith(".") && (
    index !== 0 || !PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES.includes(part)
  ))) {
    throw new LocalPluginError("Plugin archive contains private files");
  }
  const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (fileType === 0xa000) throw new LocalPluginError("Plugin archive contains a symbolic link");
  return `${segments.join("/")}${name.endsWith("/") ? "/" : ""}`;
}

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(file, {
    lazyEntries: true, decodeStrings: true, validateEntrySizes: true,
  }, (error, zip) => error || !zip ? reject(new LocalPluginError("Plugin is not a valid ZIP archive")) : resolve(zip)));
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError); };
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = () => { cleanup(); reject(new LocalPluginError("Plugin is not a valid ZIP archive")); };
    zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError); zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => (
    error || !stream ? reject(new LocalPluginError("Plugin archive could not be read")) : resolve(stream)
  )));
}
