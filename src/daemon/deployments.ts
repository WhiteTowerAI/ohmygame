import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Deployment, ProjectState } from "../shared/contracts.js";

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

export class DeploymentManager {
  readonly #deploymentsDirectory: string;
  readonly #publishing = new Set<string>();
  readonly #running = new Map<string, ChildProcess>();

  constructor(
    dataDirectory: string,
    private readonly playOrigin: string,
  ) {
    this.#deploymentsDirectory = path.join(dataDirectory, "deployments");
  }

  async load(): Promise<void> {
    await mkdir(this.#deploymentsDirectory, { recursive: true });
  }

  async create(project: ProjectState): Promise<Deployment> {
    if (this.#publishing.has(project.id)) throw new PublishError("Project is already being published");
    this.#publishing.add(project.id);

    try {
      const source = await prepareSource(project.workspacePath, (child) => this.#running.set(project.id, child));
      const id = randomUUID();
      const temporary = path.join(this.#deploymentsDirectory, `.${id}.tmp`);
      const destination = path.join(this.#deploymentsDirectory, id);
      const createdAt = new Date().toISOString();
      const deployment: Deployment = {
        id,
        projectId: project.id,
        playUrl: playUrlFor(this.playOrigin, id),
        createdAt,
      };
      await mkdir(path.join(temporary, "files"), { recursive: true });
      try {
        await copyDirectory(source, path.join(temporary, "files"));
        await rename(temporary, destination);
        return deployment;
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    } finally {
      this.#publishing.delete(project.id);
      this.#running.delete(project.id);
    }
  }

  async remove(deploymentId: string): Promise<void> {
    if (!isDeploymentId(deploymentId)) return;
    await rm(path.join(this.#deploymentsDirectory, deploymentId), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    await Promise.all([...this.#running.values()].map(terminate));
    this.#publishing.clear();
    this.#running.clear();
  }
}

export function deploymentFilesPath(dataDirectory: string, deploymentId: string): string | undefined {
  if (!isDeploymentId(deploymentId)) return undefined;
  return path.join(dataDirectory, "deployments", deploymentId, "files");
}

export function playUrlFor(playOrigin: string, deploymentId: string): string {
  if (!isDeploymentId(deploymentId)) throw new Error("Invalid deployment ID");
  const origin = new URL(playOrigin);
  origin.hostname = `${deploymentId}.${origin.hostname}`;
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return origin.toString();
}

async function prepareSource(workspacePath: string, track: (child: ChildProcess) => void): Promise<string> {
  const packageJson = await readPackageJson(workspacePath);
  const build = packageJson?.scripts?.build;
  if (packageJson && typeof build === "string" && build.trim()) {
    if (hasDependencies(packageJson) && !await exists(path.join(workspacePath, "node_modules"))) {
      await run("npm", ["install", "--no-audit", "--no-fund"], workspacePath, track);
    }
    await run("npm", ["run", "build"], workspacePath, track);
    const output = await findBuildOutput(workspacePath);
    if (!output) {
      throw new PublishError("Build completed but did not produce a static index.html in dist, build, or out");
    }
    return output;
  }

  if (await exists(path.join(workspacePath, "index.html"))) return workspacePath;
  throw new PublishError("Project has no build script or static index.html yet");
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

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (ignored(entry.name) || entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

function ignored(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
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
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function isDeploymentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
