import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { ProjectState } from "../../shared/contracts.js";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES } from "../../shared/plugins.js";
import { PUBLISH_ARTIFACT_MAX_BYTES, PUBLISH_GAME_COVER_PATH } from "../../shared/publish-v1.js";

interface PackageJson {
  scripts?: { build?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

export class PublishError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class ArtifactBuilder {
  readonly #running = new Map<string, ChildProcess>();

  async create(project: ProjectState, cover?: Buffer): Promise<Buffer> {
    try {
      const source = await prepareSource(project.workspacePath, (child) => this.#running.set(project.id, child));
      return createZip(source, false, cover);
    } finally {
      this.#running.delete(project.id);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#running.values()].map(terminate));
    this.#running.clear();
  }
}

export async function createPluginArchive(source: string): Promise<Buffer> {
  return createZip(source, true);
}

async function prepareSource(workspacePath: string, track: (child: ChildProcess) => void): Promise<string> {
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson) {
    const build = packageJson.scripts?.build;
    if (typeof build !== "string" || !build.trim()) {
      throw new PublishError("Projects with package.json need a non-empty scripts.build command before publishing");
    }
    if (hasDependencies(packageJson) && !await exists(path.join(workspacePath, "node_modules"))) {
      await run(npmCommand(), ["install", "--no-audit", "--no-fund"], workspacePath, track);
    }
    await run(npmCommand(), ["run", "build"], workspacePath, track);
    const output = await findBuildOutput(workspacePath);
    if (!output) throw new PublishError("Build completed but did not produce a static index.html in dist, build, or out");
    return output;
  }
  if (await exists(path.join(workspacePath, "index.html"))) return workspacePath;
  throw new PublishError("Project has no build script or static index.html yet");
}

async function createZip(source: string, plugin = false, cover?: Buffer): Promise<Buffer> {
  const zip = new ZipFile();
  const files = await filesIn(source, "", plugin);
  const zipOptions = { mtime: new Date(1980, 0, 2), forceDosTimestamp: true } as const;
  if (cover !== undefined && files.includes(PUBLISH_GAME_COVER_PATH)) {
    throw new PublishError(`Publish output uses reserved path: ${PUBLISH_GAME_COVER_PATH}`);
  }
  for (const file of files) {
    zip.addFile(path.join(source, ...file.split("/")), file, zipOptions);
  }
  if (cover !== undefined) zip.addBuffer(cover, PUBLISH_GAME_COVER_PATH, zipOptions);
  const chunks: Buffer[] = [];
  const output = zip.outputStream as Readable;
  const completed = new Promise<Buffer>((resolve, reject) => {
    let bytes = 0;
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PUBLISH_ARTIFACT_MAX_BYTES) {
        output.destroy(new PublishError("Publish artifact exceeds 25 MB", 413));
        return;
      }
      chunks.push(chunk);
    });
    output.once("error", reject);
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
    env: { ...process.env, BROWSER: "none" },
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
  if (name === "node_modules" || name === ".git" || name === ".data") return true;
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

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
