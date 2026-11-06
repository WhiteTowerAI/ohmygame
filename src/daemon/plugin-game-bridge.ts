import { projectTypePlugin } from "../shared/project-file.js";
import type { PluginGameRequest } from "../shared/extension-host-protocol.js";
import {
  GAME_USE_OPERATIONS,
  MAX_CAPTURE_FRAME,
  supportsGameUseOperation,
  type GameRuntimeAdapter,
  type GameUseOpenTarget,
  type GameUseOperation,
} from "../shared/playtest.js";
import { OwnedPlaytestDriver } from "./owned-playtest.js";
import { checkedActions } from "./playtest-tools.js";

// A plugin's `context.game`: the project's game as the agent's game_use
// plays it, through the same runtime and so within the same limits. Each
// plugin's sessions are its own, per start of the project's host, and end
// when the host stops or unloads the plugin. Native code is trusted; the
// `game` capability is the person's say, not a wall.

/** The game of a project, as the agent's game_use gets it. */
export interface ProjectGame {
  runtime: GameRuntimeAdapter;
  target(signal?: AbortSignal): Promise<GameUseOpenTarget>;
  /** For a native type's game, the type, `publisher/name:type`, whose plugin runs it. */
  provider?: string;
}

export interface PluginGameCaller {
  /** The project folder the host serves. */
  folder: string;
  plugin: string;
  /** Which start of the project's host the plugin runs in. */
  generation: number;
}

interface Owner {
  runtime: GameRuntimeAdapter;
  driver: OwnedPlaytestDriver;
  /** Each session's requests, one at a time. */
  queues: Map<string, Promise<unknown>>;
}

const MAX_SESSION_ID = 200;
const key = (folder: string, plugin: string, generation: number) => JSON.stringify([folder, plugin, generation]);

export class PluginGameBridge {
  readonly #owners = new Map<string, Owner>();

  constructor(private readonly game: (folder: string) => Promise<ProjectGame | undefined>) {}

  async handle(caller: PluginGameCaller, request: PluginGameRequest, signal: AbortSignal): Promise<unknown> {
    const game = await this.game(caller.folder);
    if (!game?.runtime.available) throw new Error("This project has no game to play here");
    // Its own game would come back to it through its gameUse hook.
    if (game.provider && projectTypePlugin(game.provider) === caller.plugin)
      throw new Error(`${caller.plugin} runs this project's game itself`);
    const operation = request?.operation as GameUseOperation;
    if (!GAME_USE_OPERATIONS.includes(operation) || !supportsGameUseOperation(game.runtime.capabilities, operation))
      throw new Error(`This project's game can't ${String(operation)}`);
    const owner = await this.#owner(caller, game.runtime);
    if (request.operation === "open") {
      const target = await game.target(signal);
      const result = await owner.driver.request({
        operation: "open",
        target,
        ...(request.viewport ? { viewport: request.viewport } : target.runtime === "plugin" ? {} : { viewport: { width: 1280, height: 720 } }),
      }, signal);
      if (result.operation !== "open") throw new Error("Unexpected game response");
      if (signal.aborted) {
        await owner.driver.request({ operation: "close", sessionId: result.snapshot.sessionId }).catch(() => {});
        signal.throwIfAborted();
      }
      return result.snapshot;
    }
    const sessionId = request.session;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > MAX_SESSION_ID) throw new Error("session is required");
    return this.#serial(owner, sessionId, async () => {
      switch (request.operation) {
        case "inspect":
        case "capture":
        case "recordStop":
        case "close": {
          const result = await owner.driver.request({ operation: request.operation, sessionId }, signal);
          if (result.operation === "inspect") return result.snapshot;
          if (result.operation === "capture") return result.capture;
          if (result.operation === "recordStop") return result.recording;
          return null;
        }
        case "act": {
          const result = await owner.driver.request({ operation: "act", sessionId, actions: checkedActions(game.runtime, request.actions) }, signal);
          return result.operation === "act" ? result.snapshot : null;
        }
        case "captureFrame": {
          if (!Number.isInteger(request.frame) || request.frame < 1 || request.frame > MAX_CAPTURE_FRAME) throw new Error("frame must be a whole number from 1");
          const result = await owner.driver.request({ operation: "captureFrame", sessionId, frame: request.frame }, signal);
          return result.operation === "captureFrame" ? result.capture : null;
        }
        case "recordStart": {
          const result = await owner.driver.request({ operation: "recordStart", sessionId, title: `${caller.plugin} playtest` }, signal);
          return result.operation === "recordStart" ? { maxSeconds: result.maxSeconds } : null;
        }
      }
    });
  }

  /** The sessions a host that stopped opened, or those of a plugin it unloaded, close. */
  release({ folder, generation, plugin }: { folder: string; generation: number; plugin?: string }): void {
    for (const [ownerKey, owner] of this.#owners) {
      const [ownerFolder, ownerPlugin, ownerGeneration] = JSON.parse(ownerKey) as [string, string, number];
      if (ownerFolder !== folder || ownerGeneration !== generation || (plugin && ownerPlugin !== plugin)) continue;
      this.#owners.delete(ownerKey);
      void owner.driver.cleanup();
    }
  }

  async close(): Promise<void> {
    const owners = [...this.#owners.values()];
    this.#owners.clear();
    await Promise.allSettled(owners.map((owner) => owner.driver.cleanup()));
  }

  async #owner(caller: PluginGameCaller, runtime: GameRuntimeAdapter): Promise<Owner> {
    const ownerKey = key(caller.folder, caller.plugin, caller.generation);
    const existing = this.#owners.get(ownerKey);
    if (existing?.runtime === runtime) return existing;
    // The project's game runtime was made again; what was open in the old one is closed.
    if (existing) await existing.driver.cleanup();
    const owner: Owner = { runtime, driver: new OwnedPlaytestDriver(runtime), queues: new Map() };
    this.#owners.set(ownerKey, owner);
    return owner;
  }

  #serial<T>(owner: Owner, sessionId: string, task: () => Promise<T>): Promise<T> {
    const run = (owner.queues.get(sessionId) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => {});
    owner.queues.set(sessionId, settled);
    void settled.then(() => {
      if (owner.queues.get(sessionId) === settled) owner.queues.delete(sessionId);
    });
    return run;
  }
}
