import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";

export class SnapshotManager {
  constructor(private readonly events: RuntimeEventBus) {}

  async capture(project: ProjectState): Promise<void> {
    const { pending, snapshots } = snapshotPaths(project);
    const temporary = path.join(snapshots, `pending.${process.pid}.tmp`);
    await rm(temporary, { recursive: true, force: true });
    await rm(pending, { recursive: true, force: true });
    await mkdir(snapshots, { recursive: true });
    await cp(project.workspacePath, temporary, { recursive: true, filter: excludeDependencies });
    await rename(temporary, pending);
  }

  async finalize(project: ProjectState): Promise<void> {
    const { pending, previous, retired } = snapshotPaths(project);
    if (!await exists(pending)) return;
    if (await directoryDigest(pending) === await directoryDigest(project.workspacePath)) {
      await rm(pending, { recursive: true, force: true });
      return;
    }
    await rm(retired, { recursive: true, force: true });
    if (await exists(previous)) await rename(previous, retired);
    try {
      await rename(pending, previous);
    } catch (error) {
      if (await exists(retired)) await rename(retired, previous);
      throw error;
    }
    await rm(retired, { recursive: true, force: true });
    project.canUndo = true;
    this.events.publish(project.id, "workspace.snapshot.created", {});
  }

  async recover(project: ProjectState): Promise<void> {
    const { previous, retired } = snapshotPaths(project);
    if (await exists(retired)) {
      if (await exists(previous)) await rm(retired, { recursive: true, force: true });
      else await rename(retired, previous);
    }
    await this.finalize(project);
    project.canUndo = await exists(previous);
  }

  async restore(project: ProjectState): Promise<void> {
    const { previous } = snapshotPaths(project);
    const projectDirectory = path.dirname(project.workspacePath);
    const staging = path.join(projectDirectory, `workspace.restore.${process.pid}.tmp`);
    const oldWorkspace = path.join(projectDirectory, `workspace.previous.${process.pid}.tmp`);
    await rm(staging, { recursive: true, force: true });
    await rm(oldWorkspace, { recursive: true, force: true });
    await cp(previous, staging, { recursive: true });
    await cp(path.join(project.workspacePath, "node_modules"), path.join(staging, "node_modules"), {
      recursive: true,
      force: false,
      errorOnExist: false,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(project.workspacePath, oldWorkspace);
    try {
      await rename(staging, project.workspacePath);
    } catch (error) {
      await rename(oldWorkspace, project.workspacePath);
      throw error;
    }
    await rm(oldWorkspace, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    project.canUndo = false;
    this.events.publish(project.id, "workspace.restored", {});
  }
}

function snapshotPaths(project: ProjectState) {
  const snapshots = path.join(path.dirname(project.workspacePath), "snapshots");
  return {
    snapshots,
    pending: path.join(snapshots, "pending"),
    previous: path.join(snapshots, "previous"),
    retired: path.join(snapshots, "previous.retired"),
  };
}

async function directoryDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  await addDirectory(hash, directory, "");
  return hash.digest("hex");
}

async function addDirectory(hash: ReturnType<typeof createHash>, directory: string, relative: string): Promise<void> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const childRelative = path.join(relative, entry.name);
    hash.update(`${entry.isDirectory() ? "d" : "f"}:${childRelative}\0`);
    if (entry.isDirectory()) await addDirectory(hash, directory, childRelative);
    else if (entry.isFile()) hash.update(await readFile(path.join(directory, childRelative)));
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await readdir(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function excludeDependencies(source: string): boolean {
  return path.basename(source) !== "node_modules";
}
