import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstallPluginRequest, PluginDetail } from "../shared/plugins.js";
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
