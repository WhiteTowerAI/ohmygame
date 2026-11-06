import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { createMultiplayerServer, GameAdapter } from "@ohmygame/server";
import { LOCKSTEP_ADAPTER_ID, MULTIPLAYER_MAX_CLIENTS, OWNER_ADAPTER_ID, sameMultiplayerConfig, type MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { describePlayerRange } from "@ohmygame/server/adapters";
import { checkTickMs, createRoomAdapter, tickMsOf } from "@ohmygame/sdk/rules";
import { BUILT_IN_ADAPTER_IDS, createBuiltInAdapters, type BuiltInAdapterId } from "@ohmygame/games";
import { HOST_ADAPTER_ID } from "@ohmygame/sdk/host";

/**
 * custom: the game's own rules in server/rules.ts, from defineGame or defineRealtimeGame.
 * They run in the players' browsers, as once the game is published, and the service keeps
 * only the room. Realtime rules that show everyone the whole state run in every browser in
 * lockstep (adapterId "lockstep"); other rules run on one player's, the host's ("host").
 * owner: no rules file; each page runs its own player and the service passes states on.
 */
export type LocalGameAdapterId = BuiltInAdapterId | "custom" | "owner";
export interface LocalMultiplayerOptions {
  maxClients?: number;
  /** Players join a running round without creating a room. Realtime rules only; roam defaults to it. */
  dropIn?: boolean;
  /**
   * Custom realtime rules without playerView run in lockstep unless this is false, as for
   * a game set up before lockstep existed, which keeps its host until it is set up again.
   */
  lockstep?: boolean;
  /** owner only: how often, in milliseconds, players' states go out. Defaults to 100. */
  tickMs?: number;
}

/** Generated games stay small until larger rooms have rules and load tests. */
export const LOCAL_MULTIPLAYER_MIN_CLIENTS = 2;
export const LOCAL_MULTIPLAYER_MAX_CLIENTS = 8;
const LOCAL_MULTIPLAYER_DEFAULT_CLIENTS = 4;
/** A fixed address keeps the URL written into a game valid after OhMyGame restarts. */
export const LOCAL_MULTIPLAYER_PORT = 43139;
const LOCAL_ADAPTER_IDS: readonly string[] = [...BUILT_IN_ADAPTER_IDS, HOST_ADAPTER_ID, LOCKSTEP_ADAPTER_ID, OWNER_ADAPTER_ID];
/** Owner rooms pass states on this often unless the game asks otherwise. */
const OWNER_DEFAULT_TICK_MS = 100;
/** The built-in rules the local service registers; custom rules come with each deployment. */
const BUILT_IN_ADAPTERS = createBuiltInAdapters();

/** The preferred port when it is free, otherwise any port, such as when a second OhMyGame holds it. */
async function availablePort(preferred: number): Promise<number> {
  if (preferred === 0) return 0;
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(0));
    probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolve(preferred)));
  });
}

/** The local cap narrowed to the seats the rules support, so gomoku is always 2. */
function localPlayerRange({ players }: GameAdapter) {
  return {
    min: Math.max(LOCAL_MULTIPLAYER_MIN_CLIENTS, players.min),
    max: Math.min(LOCAL_MULTIPLAYER_MAX_CLIENTS, players.max),
  };
}

/**
 * Where a local game signs players in and keeps saves and leaderboards: the local service's
 * test accounts and in-memory store, written to manifest.json as "account" and "cloud".
 */
export interface LocalGameServices {
  account: { issuer: string };
  cloud: { serverUrl: string; gameId: string };
}

/** One daemon-owned service for local playtests. No public registration endpoint. */
export class LocalMultiplayerRuntime {
  private service?: ReturnType<typeof createMultiplayerServer>;
  private starting?: Promise<void>;

  constructor(private readonly preferredPort = LOCAL_MULTIPLAYER_PORT) {}

  /** rulesFile is the game's server/rules.ts, which custom needs: it is loaded to check it and to read its mode and seats. */
  async configure(
    gameId: string,
    adapterId: LocalGameAdapterId,
    options: LocalMultiplayerOptions = {},
    rulesFile?: string,
  ): Promise<MultiplayerManifestConfig> {
    let rules: GameAdapter | undefined;
    if (adapterId === "custom") {
      if (!rulesFile)
        throw new Error("Write server/rules.ts first: defineGame for turn-based rules or defineRealtimeGame for realtime rules, exported as default.");
      const { loadGameRules } = await import("@ohmygame/server");
      rules = await loadGameRules(rulesFile);
    }
    // An owner room has no rules: any number of seats, realtime, at the game's tick.
    const owned: GameAdapter | undefined = adapterId === "owner"
      ? { ...createRoomAdapter("realtime", { min: 1, max: MULTIPLAYER_MAX_CLIENTS }), owner: true, tickMs: options.tickMs ?? OWNER_DEFAULT_TICK_MS }
      : undefined;
    if (owned) checkTickMs(owned.tickMs!);
    const adapter = rules ?? owned ?? BUILT_IN_ADAPTERS[adapterId as BuiltInAdapterId];
    if (!adapter) throw new Error(`Unknown rules: ${adapterId}.`);
    const { mode } = adapter;
    // Roaming is a shared place to wander, so players drop in unless the game asks for private rooms.
    const dropIn = options.dropIn ?? adapterId === "roam";
    if (dropIn && mode !== "realtime")
      throw new Error("Drop-in rooms need realtime rules: arena, roam or custom rules from defineRealtimeGame. Turn-based games use rooms with invitations.");
    const range = localPlayerRange(adapter);
    if (range.min > range.max)
      throw new Error(`These rules need ${describePlayerRange(adapter.players)} players; local rooms hold ${LOCAL_MULTIPLAYER_MIN_CLIENTS} to ${LOCAL_MULTIPLAYER_MAX_CLIENTS}.`);
    const maxClients = options.maxClients ?? Math.min(Math.max(LOCAL_MULTIPLAYER_DEFAULT_CLIENTS, range.min), range.max);
    if (!Number.isInteger(maxClients) || maxClients < range.min || maxClients > range.max)
      throw new Error(`Local ${adapterId} rooms hold ${describePlayerRange(range)} players.`);
    await this.ensureService();
    // Every browser can run realtime rules in step when nobody's view is private.
    const lockstep = adapterId === "custom" && mode === "realtime" && !adapter.playerView && options.lockstep !== false;
    const tickMs = lockstep || owned ? tickMsOf(adapter) : undefined;
    const config: MultiplayerManifestConfig = {
      enabled: true,
      mode,
      gameId,
      // Deployments are immutable, so each room size and policy is its own deployment.
      // Custom rules may switch between turn-based and realtime, which needs another deployment.
      deploymentId: `local-${lockstep ? `lockstep-${tickMs}ms` : owned ? `owner-${tickMs}ms` : adapterId === "custom" ? `host-${mode}` : adapterId}-${maxClients}p${dropIn ? "-dropin" : ""}-v1`,
      protocolVersion: 1,
      serverUrl: `http://127.0.0.1:${this.service!.port}`,
      authPolicy: "anonymous",
      roomPolicy: dropIn ? "drop-in" : "invite-or-public",
      maxClients,
      // A wandering player who closed the tab need not hold a seat for long; turn-based seats wait.
      reconnectSeconds: dropIn ? 15 : 120,
      // The game's own rules run in the players' browsers; the service never loads them.
      adapterId: lockstep ? LOCKSTEP_ADAPTER_ID : owned ? OWNER_ADAPTER_ID : adapterId === "custom" ? HOST_ADAPTER_ID : adapterId,
      ...(tickMs === undefined ? {} : { tickMs }),
    };
    this.service!.registerLocalDeployment(config);
    return config;
  }

  /**
   * Registers a game's local deployment again after OhMyGame restarted, at the
   * address the service has now, with its own rules reloaded from rulesFile.
   * Anything other than a deployment this runtime wrote for the game is left alone.
   */
  async restore(gameId: string, config: MultiplayerManifestConfig, rulesFile?: string): Promise<MultiplayerManifestConfig | undefined> {
    if (config.gameId !== gameId || !config.deploymentId.startsWith("local-") || !LOCAL_ADAPTER_IDS.includes(config.adapterId ?? "")) return undefined;
    const adapterId = config.adapterId === HOST_ADAPTER_ID || config.adapterId === LOCKSTEP_ADAPTER_ID ? "custom" : (config.adapterId as LocalGameAdapterId);
    const restored = await this.configure(gameId, adapterId, {
      maxClients: config.maxClients,
      dropIn: config.roomPolicy === "drop-in",
      // A deployment keeps how it runs the rules; setting the game up again may change it.
      lockstep: config.adapterId === LOCKSTEP_ADAPTER_ID,
      ...(config.adapterId === OWNER_ADAPTER_ID && config.tickMs !== undefined ? { tickMs: config.tickMs } : {}),
    }, rulesFile);
    return sameMultiplayerConfig({ ...config, serverUrl: restored.serverUrl }, restored) ? restored : undefined;
  }

  /**
   * The local service's test accounts, saves and leaderboards for a game, starting the
   * service if needed. They last until OhMyGame quits, like rooms.
   */
  async gameServices(gameId: string): Promise<LocalGameServices> {
    const base = await this.ensureService();
    return { account: { issuer: base }, cloud: { serverUrl: `${base}/`, gameId } };
  }

  /** Starts the shared local service once; resolves with its address. */
  private async ensureService(): Promise<string> {
    if (!this.starting) {
      this.starting = (async () => {
        const { createMultiplayerServer, MemoryGameDataStore } = await import("@ohmygame/server");
        this.service = createMultiplayerServer({
          deployments: [],
          adapters: BUILT_IN_ADAPTERS,
          auth: { guestSecret: randomBytes(32).toString("hex") },
          databasePath: ":memory:",
          host: "127.0.0.1",
          port: await availablePort(this.preferredPort),
          allowLocalhost: true,
          logger: false,
          // Local games sign in test players and keep saves and scores here, in memory.
          gameData: { store: new MemoryGameDataStore() },
          localAccounts: true,
        });
        await this.service.start();
      })().catch(async (cause) => {
        await this.service?.stop();
        this.service = undefined;
        this.starting = undefined;
        throw cause;
      });
    }
    await this.starting;
    return `http://127.0.0.1:${this.service!.port}`;
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    await this.service?.stop();
    this.service = undefined;
    this.starting = undefined;
  }
}
