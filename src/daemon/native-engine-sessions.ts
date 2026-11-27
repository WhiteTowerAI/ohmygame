// The daemon owns editor process groups so they can be stopped if their
// extension host crashes. Only live sessions keep a project host awake.
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import type { NativeEngineStart } from "../shared/extension-host-protocol.js";
import { registerProjectProcess, terminateProjectProcess } from "./process-lifecycle.js";
import { projectProcessEnvironment } from "./project-process.js";

// Each host instance identifies one generation, even when a replacement uses the same scope.
type Owner = { hold(): () => void };

interface Engine {
  owner: Owner;
  project: string;
  plugin: string;
  id: number;
  label: string;
  stop(): Promise<void>;
}

export class OpenEditorError extends Error {
  constructor(readonly editor: string) {
    super(`Save your work and close ${editor} before removing this project.`);
  }
}

export class NativeEngineSessions {
  readonly #active = new Set<Engine>();
  readonly #removals = new Set<(project: string) => boolean>();
  #shuttingDown = false;

  async guardRemoval(folder: string): Promise<() => void> {
    const root = await realpath(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return path.resolve(folder);
      throw error;
    });
    // A builder workspace includes its draft's playground. Both disappear on removal.
    const contains = (project: string) => {
      const relative = path.relative(root, project);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    for (const engine of this.#active) {
      if (contains(engine.project)) throw new OpenEditorError(engine.label);
    }
    this.#removals.add(contains);
    return () => { this.#removals.delete(contains); };
  }

  prepareShutdown(): string | undefined {
    const editor = this.#active.values().next().value;
    if (editor) return editor.label;
    this.#shuttingDown = true;
  }

  cancelShutdown() {
    this.#shuttingDown = false;
  }

  async start(owner: Owner, project: string, plugin: string, id: number, options: NativeEngineStart) {
    if (this.#shuttingDown || [...this.#removals].some((contains) => contains(project)))
      throw new Error("The project is closing");
    for (const engine of this.#active) {
      if (engine.project === project && engine.plugin === plugin)
        throw new Error(`${engine.label} is already running for this plugin`);
    }
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd ?? project,
      env: projectProcessEnvironment(),
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    registerProjectProcess(child);
    const release = owner.hold();
    let stopping: Promise<void> | undefined;
    const engine: Engine = {
      owner, project, plugin, id,
      label: options.label || "A native engine",
      stop() {
        stopping ??= terminateProjectProcess(child).catch((error) => {
          stopping = undefined;
          throw error;
        });
        return stopping;
      },
    };
    // Reserve synchronously so two overlapping starts cannot open two editors.
    this.#active.add(engine);
    const remove = () => {
      if (this.#active.delete(engine)) release();
    };
    child.once("close", remove);
    try {
      await once(child, "spawn");
    } catch (error) {
      remove();
      throw error;
    }
  }

  async stop(owner?: Owner, plugin?: string, id?: number) {
    const stops = [];
    for (const engine of this.#active) {
      if (owner && engine.owner !== owner) continue;
      if (plugin !== undefined && engine.plugin !== plugin) continue;
      if (id !== undefined && engine.id !== id) continue;
      stops.push(engine.stop());
    }
    await Promise.all(stops);
  }
}
