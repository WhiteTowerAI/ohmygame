import { spawn, type ChildProcess } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { ProjectState } from "../../shared/contracts.js";
import { isWebRuntimeProjectType } from "../../shared/project-runtime.js";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES } from "../../shared/plugins.js";
import { PUBLISH_ARTIFACT_MAX_BYTES, PUBLISH_GAME_COVER_PATH } from "../../shared/publish-v1.js";
import { packageManagerCommand, packageManagerRunArguments, resolvePackageManager } from "../package-manager.js";
import { ensureProjectDependencies } from "../project-dependencies.js";
import { projectProcessEnvironment } from "../project-process.js";
import { resolveStartupDirectory } from "../projects.js";
import { buildPlayableProject } from "../playable-project.js";
import { isCloudConfig, type CloudConfig } from "@ohmygame/sdk/cloud-protocol";
import { isMultiplayerManifestConfig, isRecord, sameMultiplayerConfig, type MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { isGameAccountConfig, type GameAccountConfig } from "@ohmygame/sdk/account-protocol";
import { isWebStory, publishableWebStoryFiles } from "../story-web-project.js";
import { compressArchiveFile } from "../archive-compression.js";
import { PublishMediaOptimizer } from "./media.js";

interface PackageJson {
  scripts?: { build?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** Why a story made before web stories cannot be built or published yet. */
const STORY_NEEDS_UPGRADE = "This story was made before stories played as their own web page. Open it in the Story editor, which upgrades it, then try again.";

export class PublishError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export interface ArtifactBuilderOptions {
  /**
   * Where published games sign players in with their OhMyGame account; publishing writes
   * it to manifest.json as "account". Local publishing never does: local builds play as guests.
   */
  account?: GameAccountConfig;
  /**
   * The game service that keeps published games' cloud saves and leaderboards, an HTTPS
   * origin. Publishing writes it with the game's OhMyGame ID to manifest.json as "cloud";
   * local publishing never does, so local builds keep saves in the browser.
   */
  gameServiceUrl?: string;
}

/** A built game waiting to be packaged; see ArtifactBuilder.prepare. */
export interface PreparedArtifact {
  /** The artifact. gameId is the game's OhMyGame ID, which a build with cloud saves names. */
  package(gameId?: string): Promise<Buffer>;
  dispose(): Promise<void>;
}

export class ArtifactBuilder {
  readonly #running = new Map<string, ChildProcess>();
  readonly #account?: GameAccountConfig;
  readonly #gameServiceUrl?: string;

  constructor(options: ArtifactBuilderOptions = {}) {
    if (options.account && !isGameAccountConfig(options.account)) throw new Error("The account issuer must be an HTTPS URL.");
    if (options.gameServiceUrl && !isCloudConfig({ serverUrl: options.gameServiceUrl, gameId: "check" }))
      throw new Error("The game service must be an HTTPS origin.");
    this.#account = options.account;
    this.#gameServiceUrl = options.gameServiceUrl;
  }

  async create(project: ProjectState, cover?: Buffer, multiplayer?: MultiplayerManifestConfig): Promise<Buffer> {
    return this.#create(project, cover, PUBLISH_ARTIFACT_MAX_BYTES, multiplayer);
  }

  /**
   * Builds and checks the game, then waits for its OhMyGame ID before packaging it, so a
   * build with cloud saves can name the game. Publishing builds first, which rejects a
   * game that cannot be published before the publish service hears of it, and creates the
   * game record only then. Call dispose when done, packaged or not.
   */
  async prepare(project: ProjectState, cover?: Buffer, multiplayer?: MultiplayerManifestConfig): Promise<PreparedArtifact> {
    return this.#prepare(project, cover, PUBLISH_ARTIFACT_MAX_BYTES, multiplayer);
  }

  /** Only the authenticated local debug publisher may use a loopback backend. */
  async createLocal(project: ProjectState, cover?: Buffer, multiplayer?: MultiplayerManifestConfig): Promise<Buffer> {
    return this.#create(project, cover, PUBLISH_ARTIFACT_MAX_BYTES, multiplayer, true);
  }

  async buildInteractiveStory(project: ProjectState): Promise<Buffer> {
    if (project.type !== "interactive-story") throw new PublishError("Build requires an Interactive Story project");
    return this.#create(project);
  }

  async #create(project: ProjectState, cover?: Buffer, maxBytes?: number, multiplayer?: MultiplayerManifestConfig, localTesting = false): Promise<Buffer> {
    const prepared = await this.#prepare(project, cover, maxBytes, multiplayer, localTesting);
    try {
      return await prepared.package();
    } finally {
      await prepared.dispose();
    }
  }

  async #prepare(project: ProjectState, cover?: Buffer, maxBytes?: number, multiplayer?: MultiplayerManifestConfig, localTesting = false): Promise<PreparedArtifact> {
    const temporaries: string[] = [];
    const media = maxBytes !== undefined && project.type === "interactive-story"
      ? new PublishMediaOptimizer((child) => this.#running.set(project.id, child))
      : undefined;
    const dispose = async () => {
      await Promise.all(temporaries.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
      await media?.close();
    };
    try {
      if (project.type === "interactive-story" && multiplayer) throw new PublishError("Interactive Stories do not have a multiplayer adapter. Use a Web Game with a server adapter.");
      let source: string;
      let declared: unknown;
      if (project.type === "interactive-story") {
        // A story from before web stories plays once the editor has upgraded it.
        if (!await isWebStory(project.workspacePath)) throw new PublishError(STORY_NEEDS_UPGRADE);
        source = await prepareWebStory(project);
        temporaries.push(source);
      } else {
        const workspacePath = isWebRuntimeProjectType(project.type)
          ? await publishStartupDirectory(project)
          : project.workspacePath;
        declared = (await readOptionalManifest(workspacePath, "multiplayer.json")).multiplayer;
        const dependencies = await readPackageJson(workspacePath);
        if ([...Object.keys(dependencies?.dependencies ?? {}), ...Object.keys(dependencies?.devDependencies ?? {})].some(name => name === "peerjs" || name.startsWith("@peerjs/")))
          throw new PublishError("This game uses PeerJS. OhMyGame multiplayer requires Colyseus and a registered server rules adapter. Migrate the game before publishing.");
        source = await prepareSource(workspacePath, (child) => this.#running.set(project.id, child), project);
      }
      const updates: Record<string, unknown> = {};
      // Games that load the SDK have a manifest; sign-in and cloud saves come with publishing, never local builds.
      let sdk = false;
      if (project.type !== "interactive-story") {
        await assertSupportedNetworking(source);
        const configured = await readMultiplayerConfig(source, multiplayer, declared, localTesting);
        if (configured) {
          await checkMultiplayerDeployment(configured, localTesting);
          if (multiplayer) updates.multiplayer = configured;
        }
        sdk = !localTesting && await hasManifest(source);
        if (sdk && this.#account) updates.account = this.#account;
      }
      const built = source;
      return {
        package: async (gameId?: string) => {
          const manifestUpdates = { ...updates };
          if (sdk && this.#gameServiceUrl && gameId) manifestUpdates.cloud = { serverUrl: this.#gameServiceUrl, gameId } satisfies CloudConfig;
          // The local service's test sign-in and in-memory saves never ship: published games
          // get OhMyGame's services above, or none.
          const manifest = sdk ? await readOptionalManifest(built) : {};
          const local = (["account", "cloud"] as const).filter((key) => !(key in manifestUpdates) && pointsAtThisComputer(manifest[key]));
          let packaged = built;
          if (Object.keys(manifestUpdates).length || local.length) {
            packaged = await mkdtemp(path.join(tmpdir(), "ohmygame-publish-build-"));
            temporaries.push(packaged);
            await cp(built, packaged, { recursive: true });
            const published: Record<string, unknown> = { ...(await readOptionalManifest(built)), ...manifestUpdates };
            for (const key of local) delete published[key];
            await writeFile(path.join(packaged, "manifest.json"), `${JSON.stringify(published, null, 2)}\n`);
          }
          return createZip(packaged, false, cover, maxBytes, false, media);
        },
        dispose,
      };
    } catch (cause) {
      await dispose();
      throw cause;
    } finally {
      this.#running.delete(project.id);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#running.values()].map(terminate));
    this.#running.clear();
  }
}

/** Whether a manifest's account or cloud entry names a service on this computer. */
function pointsAtThisComputer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const address = value.issuer ?? value.serverUrl;
  if (typeof address !== "string") return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(address).hostname);
  } catch {
    return false;
  }
}

async function hasManifest(source: string): Promise<boolean> {
  return access(path.join(source, "manifest.json")).then(() => true, () => false);
}

async function readOptionalManifest(source: string, filename = "manifest.json"): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(source, filename), "utf8"));
    if (!isRecord(value)) throw new Error();
    return value;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new PublishError(`${filename} must contain a JSON object.`);
  }
}

async function readMultiplayerConfig(source: string, requested?: MultiplayerManifestConfig, declared?: unknown, localTesting = false): Promise<MultiplayerManifestConfig | undefined> {
  const manifest = await readOptionalManifest(source);
  if (declared !== undefined && manifest.multiplayer === undefined)
    throw new PublishError("The build dropped the multiplayer manifest. Copy public/manifest.json into the published output.");
  const value = requested ?? manifest.multiplayer;
  if (value === undefined) return undefined;
  const options = { allowLocalhost: localTesting };
  if (!isMultiplayerManifestConfig(value, options)) throw new PublishError("The multiplayer configuration is invalid. Public publishing requires an HTTPS Colyseus backend; loopback URLs are only for local testing.");
  for (const other of [declared, manifest.multiplayer]) {
    if (other !== undefined && (!isMultiplayerManifestConfig(other, options) || !sameMultiplayerConfig(value, other)))
      throw new PublishError("The source, build and requested multiplayer deployments do not match.");
  }
  if (manifest.runtime === "playable-nodes") throw new PublishError("Interactive Stories do not have a multiplayer adapter.");
  return value;
}

/** A published deployment must already exist on the trusted game service. */
async function checkMultiplayerDeployment(config: MultiplayerManifestConfig, localTesting = false): Promise<void> {
  const trustedServerUrl = process.env.MULTIPLAYER_PUBLISH_SERVER_URL?.replace(/\/$/, "");
  const local = localTesting && config.serverUrl.startsWith("http:") && isMultiplayerManifestConfig(config, { allowLocalhost: true });
  if (!local && (!trustedServerUrl || config.serverUrl.replace(/\/$/, "") !== trustedServerUrl)) {
    throw new PublishError("Multiplayer publishing requires a configured game service URL.");
  }
  try {
    const url = new URL(`/v1/games/${encodeURIComponent(config.gameId)}/deployments/${encodeURIComponent(config.deploymentId)}`, config.serverUrl);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    const value: unknown = response.ok ? await response.json() : undefined;
    if (!isMultiplayerManifestConfig(value, { allowLocalhost: local }) || !sameMultiplayerConfig(config, value)) throw new Error("The registered deployment does not match.");
  } catch (cause) {
    throw new PublishError(`Multiplayer deployment check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Catch the known default-stack regression, including games importing PeerJS from a CDN. */
async function assertSupportedNetworking(source: string): Promise<void> {
  for (const file of await filesIn(source)) {
    if (!/\.(?:html|[cm]?js)$/i.test(file)) continue;
    const text = await readFile(path.join(source, file), "utf8");
    if (/\b(?:0\.peerjs\.com|turn\.peerjs\.com)\b|(?:unpkg\.com|cdn\.jsdelivr\.net)[^\s"'`<>]*\bpeerjs\b/i.test(text))
      throw new PublishError("The build includes PeerJS networking. Use the Colyseus SDK and declare its multiplayer deployment before publishing.");
  }
}

async function publishStartupDirectory(project: ProjectState): Promise<string> {
  try {
    return (await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".")).absolutePath;
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * A web story publishes as its own page: the files that play it, checked
 * against the publish rules first, as a static site.
 */
async function prepareWebStory(project: ProjectState): Promise<string> {
  try {
    if (!await buildPlayableProject(project.workspacePath, "publish")) throw new Error("This project has no graph.json.");
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
  let files: string[];
  try {
    files = await publishableWebStoryFiles(project.workspacePath);
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
  const output = await mkdtemp(path.join(tmpdir(), "ohmygame-web-story-build-"));
  try {
    for (const relative of files) {
      const destination = path.join(output, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(project.workspacePath, ...relative.split("/")), destination);
    }
    return output;
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw cause;
  }
}

export async function createPluginArchive(source: string, maxBytes = 25 * 1024 * 1024, preserveExecutable = false): Promise<Buffer> {
  return createZip(source, true, undefined, maxBytes, preserveExecutable);
}

async function prepareSource(workspacePath: string, track: (child: ChildProcess) => void, project?: ProjectState): Promise<string> {
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson) {
    const build = packageJson.scripts?.build;
    if (typeof build !== "string" || !build.trim()) {
      throw new PublishError("Projects with package.json need a non-empty scripts.build command before publishing");
    }
    const { manager: packageManager } = await resolvePackageManager(workspacePath, project?.packageManager);
    if (hasDependencies(packageJson)) {
      await ensureProjectDependencies(workspacePath, packageManager,
        (command, args) => run(command, args, workspacePath, track));
    }
    await run(packageManagerCommand(packageManager), packageManagerRunArguments("build"), workspacePath, track);
    const output = await findBuildOutput(workspacePath);
    if (!output) throw new PublishError("Build completed but did not produce a static index.html in dist, build, or out");
    return output;
  }
  if (await exists(path.join(workspacePath, "index.html"))) return workspacePath;
  throw new PublishError("Project has no build script or static index.html yet");
}

async function createZip(source: string, plugin = false, cover?: Buffer, maxBytes?: number, preserveExecutable = false, media?: PublishMediaOptimizer): Promise<Buffer> {
  const zip = new ZipFile();
  const files = await filesIn(source, "", plugin);
  const zipOptions = {
    mtime: new Date(1980, 0, 2),
    forceDosTimestamp: true,
    // Deflate output differs between zlib builds, so Plugin entries are stored
    // to keep the archive's checksum the same on every runtime.
    ...(plugin ? { mode: 0o100644, compress: false } : {}),
  } as const;
  if (cover !== undefined && files.includes(PUBLISH_GAME_COVER_PATH)) {
    throw new PublishError(`Publish output uses reserved path: ${PUBLISH_GAME_COVER_PATH}`);
  }
  for (const file of files) {
    const original = path.join(source, ...file.split("/"));
    const filename = media ? await media.optimize(original) : original;
    const executable = preserveExecutable && ((await stat(filename)).mode & 0o111) !== 0;
    const options = { ...zipOptions, compress: !plugin && compressArchiveFile(file) };
    zip.addFile(filename, file, executable ? { ...options, mode: 0o100755 } : options);
  }
  if (cover !== undefined) zip.addBuffer(cover, PUBLISH_GAME_COVER_PATH, { ...zipOptions, compress: false });
  const chunks: Buffer[] = [];
  const output = zip.outputStream as Readable;
  const completed = new Promise<Buffer>((resolve, reject) => {
    let bytes = 0;
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        output.destroy(new PublishError(`Publish artifact exceeds ${maxBytes / (1024 * 1024)} MB`, 413));
        return;
      }
      chunks.push(chunk);
    });
    output.once("error", reject);
    // yazl reports a file it cannot stat or read on the ZipFile, possibly once per file, and then never ends the output.
    zip.on("error", reject);
    output.once("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return completed;
}

async function filesIn(root: string, relative = "", plugin = false): Promise<string[]> {
  const files: string[] = [];
  const directory = path.join(root, relative);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored(entry.name, relative, plugin) || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, child, plugin));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function readPackageJson(workspacePath: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PublishError("package.json is not valid JSON");
  }
}

function hasDependencies(packageJson: PackageJson): boolean {
  return Object.keys(packageJson.dependencies ?? {}).length > 0 || Object.keys(packageJson.devDependencies ?? {}).length > 0;
}

async function findBuildOutput(workspacePath: string): Promise<string | undefined> {
  for (const directory of ["dist", "build", "out"]) {
    const candidate = path.join(workspacePath, directory);
    if (await exists(path.join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

async function run(command: string, args: string[], cwd: string, track: (child: ChildProcess) => void): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: { ...projectProcessEnvironment(), BROWSER: "none" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  track(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new PublishError(stderr.trim() || `${command} exited with ${code}`)));
  });
}

function ignored(name: string, relative: string, plugin: boolean): boolean {
  if (name === "node_modules" || name === ".git" || name === ".data" || (!plugin && name === "AGENTS.md")) return true;
  if (!name.startsWith(".")) return false;
  return !(plugin && !relative && PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES.includes(name));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
