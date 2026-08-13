import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { ProjectState } from "../../shared/contracts.js";
import { PUBLISH_ARTIFACT_MAX_BYTES } from "../../shared/publish-v1.js";

interface PackageJson {
  scripts?: { build?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

const ZIP_TIMESTAMP = new Date("1980-01-02T00:00:00.000Z");

export class PublishError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class ArtifactBuilder {
  readonly #running = new Map<string, ChildProcess>();

  async create(project: ProjectState): Promise<Buffer> {
    try {
      const source = await prepareSource(project.workspacePath, (child) => this.#running.set(project.id, child));
      return createZip(source);
    } finally {
      this.#running.delete(project.id);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#running.values()].map(terminate));
    this.#running.clear();
  }
}

async function prepareSource(workspacePath: string, track: (child: ChildProcess) => void): Promise<string> {
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson) {
    const build = packageJson.scripts?.build;
    if (typeof build !== "string" || !build.trim()) {
      throw new PublishError("Projects with package.json need a non-empty scripts.build command before publishing");
    }
    if (hasDependencies(packageJson) && !await exists(path.join(workspacePath, "node_modules"))) {
      await run("npm", ["install", "--no-audit", "--no-fund"], workspacePath, track);
    }
    await run("npm", ["run", "build"], workspacePath, track);
    const output = await findBuildOutput(workspacePath);
    if (!output) throw new PublishError("Build completed but did not produce a static index.html in dist, build, or out");
    return output;
  }
  if (await exists(path.join(workspacePath, "index.html"))) return workspacePath;
  throw new PublishError("Project has no build script or static index.html yet");
}

async function createZip(source: string): Promise<Buffer> {
  const zip = new ZipFile();
  for (const file of await filesIn(source)) {
    zip.addFile(path.join(source, ...file.split("/")), file, { mtime: ZIP_TIMESTAMP });
  }
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

async function filesIn(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  const directory = path.join(root, relative);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored(entry.name) || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, child));
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
