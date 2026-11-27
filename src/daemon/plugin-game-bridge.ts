import { projectTypePlugin } from "../shared/project-file.js";
import type { PluginGameRequest } from "../shared/extension-host-protocol.js";
import {
  ACT_TOGETHER_MAX_PLAYERS,
  ACT_TOGETHER_MIN_PLAYERS,
  GAME_USE_OPERATIONS,
  MAX_CAPTURE_FRAME,
  supportsGameUseOperation,
  type GameRuntimeAdapter,
  type GameUseOpenTarget,
  type GameUseOperation,
} from "../shared/playtest.js";
import { OwnedPlaytestDriver } from "./owned-playtest.js";
import { checkedActions, previewUrl } from "./playtest-tools.js";

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
  /** Puts a finished recording in the project's media, returning its path there. */
  keepRecording?: (assetId: string) => Promise<string>;
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
    const operation = request?.operation;
    // Reloading and the network are the web runtime's, which runs no plugin.
    const webOnly = operation === "reload" || operation === "network" || (operation === "open" && (request.networkControl === true || request.path !== undefined));
    if (webOnly ? !!game.provider : !GAME_USE_OPERATIONS.includes(operation as GameUseOperation) || !supportsGameUseOperation(game.runtime.capabilities, operation as GameUseOperation))
      throw new Error(`This project's game can't ${operation === "open" ? (request.networkControl === true ? "control the network" : "open a path") : operation === "network" ? "control the network" : String(operation)}`);
    const owner = await this.#owner(caller, game.runtime);
    if (request.operation === "open") {
      if (request.path !== undefined && (typeof request.path !== "string" || request.path.length > 1_000)) throw new Error("path is a string of at most 1000 characters");
      let target = await game.target(signal);
      if (request.path && target.runtime === "web") target = { ...target, url: previewUrl(target.url, request.path) };
      const result = await owner.driver.request({
        operation: "open",
        target,
        ...(request.viewport ? { viewport: request.viewport } : target.runtime === "plugin" ? {} : { viewport: { width: 1280, height: 720 } }),
        ...(request.networkControl === true ? { networkControl: true } : {}),
      }, signal);
      if (result.operation !== "open") throw new Error("Unexpected game response");
      if (signal.aborted) {
        await owner.driver.request({ operation: "close", sessionId: result.snapshot.sessionId }).catch(() => {});
        signal.throwIfAborted();
      }
      return result.snapshot;
    }
    if (request.operation === "actTogether") {
      const players = Array.isArray(request.players) ? request.players : [];
      const sessionIds = players.map((player) => player?.session);
      if (players.length < ACT_TOGETHER_MIN_PLAYERS || players.length > ACT_TOGETHER_MAX_PLAYERS || new Set(sessionIds).size !== players.length || sessionIds.some((id) => typeof id !== "string" || !id || id.length > MAX_SESSION_ID))
        throw new Error(`actTogether takes ${ACT_TOGETHER_MIN_PLAYERS} to ${ACT_TOGETHER_MAX_PLAYERS} different sessions`);
      const checked = players.map((player) => ({ sessionId: player.session, actions: checkedActions(game.runtime, player.actions) }));
      return this.#serial(owner, sessionIds, async () => {
        const result = await owner.driver.request({ operation: "actTogether", players: checked }, signal);
        return result.operation === "actTogether" ? result.snapshots : null;
      });
    }
    const sessionId = request.session;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > MAX_SESSION_ID) throw new Error("session is required");
    return this.#serial(owner, [sessionId], async () => {
      switch (request.operation) {
        case "reload": {
          const result = await owner.driver.request({ operation: "reload", sessionId }, signal);
          return result.operation === "reload" ? result.snapshot : null;
        }
        case "network": {
          if (typeof request.online !== "boolean") throw new Error("online must be true or false");
          const result = await owner.driver.request({ operation: "network", sessionId, online: request.online }, signal);
          return result.operation === "network" ? result.snapshot : null;
        }
        case "inspect":
        case "capture":
        case "recordStop":
        case "close": {
          const result = await owner.driver.request({ operation: request.operation, sessionId }, signal);
          if (result.operation === "inspect") return result.snapshot;
          if (result.operation === "capture") return result.capture;
          if (result.operation === "recordStop") return game.keepRecording ? { ...result.recording, path: await game.keepRecording(result.recording.assetId) } : result.recording;
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

  /** Runs a task after every earlier request of each of its sessions. */
  #serial<T>(owner: Owner, sessionIds: string[], task: () => Promise<T>): Promise<T> {
    const before = Promise.allSettled(sessionIds.map((sessionId) => owner.queues.get(sessionId) ?? Promise.resolve()));
    const run = before.then(task);
    const settled = run.catch(() => {});
    for (const sessionId of sessionIds) owner.queues.set(sessionId, settled);
    void settled.then(() => {
      for (const sessionId of sessionIds) if (owner.queues.get(sessionId) === settled) owner.queues.delete(sessionId);
    });
    return run;
  }
}
