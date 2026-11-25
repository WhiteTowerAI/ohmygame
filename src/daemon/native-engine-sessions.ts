// The daemon owns editor process groups so they can be stopped if their
// extension host crashes. Only live sessions keep a project host awake.
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { NativeEngineStart } from "../shared/extension-host-protocol.js";
import { registerProjectProcess, terminateProjectProcess } from "./process-lifecycle.js";
import { projectProcessEnvironment } from "./project-process.js";

interface Engine {
  id: number;
  label: string;
  stop(): Promise<void>;
}

export class NativeEngineSessions {
  readonly #active = new Map<string, Engine>();

  constructor(private readonly hold: () => () => void) {}

  get openEditor(): string | undefined {
    return this.#active.values().next().value?.label;
  }

  async start(plugin: string, id: number, options: NativeEngineStart, project: string) {
    const active = this.#active.get(plugin);
    if (active) throw new Error(`${active.label} is already running for this plugin`);
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd ?? project,
      env: projectProcessEnvironment(),
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    registerProjectProcess(child);
    const release = this.hold();
    let stopping: Promise<void> | undefined;
    const engine = {
      id,
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
    this.#active.set(plugin, engine);
    const remove = () => {
      if (this.#active.get(plugin) === engine) this.#active.delete(plugin);
      release();
    };
    child.once("close", remove);
    try {
      await once(child, "spawn");
    } catch (error) {
      remove();
      throw error;
    }
  }

  async stop(plugin: string, id?: number) {
    const engine = this.#active.get(plugin);
    if (engine && (id === undefined || engine.id === id)) await engine.stop();
  }

  async close() {
    await Promise.all([...this.#active.values()].map((engine) => engine.stop()));
  }
}
