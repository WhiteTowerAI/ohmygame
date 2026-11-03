import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { createMultiplayerServer, GameAdapter } from "@ohmygame/server";
import { sameMultiplayerConfig, type MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { createBuiltInAdapter, describePlayerRange, type BuiltInAdapterId } from "@ohmygame/server/adapters";

/** custom: the game's own turn-based rules in server/rules.ts, written with defineGame. */
export type LocalGameAdapterId = BuiltInAdapterId | "custom";
export interface LocalMultiplayerOptions {
  maxClients?: number;
  /** Players join a running round without creating a room. Realtime rules only; roam defaults to it. */
  dropIn?: boolean;
}

/** Generated games stay small until larger rooms have rules and load tests. */
export const LOCAL_MULTIPLAYER_MIN_CLIENTS = 2;
export const LOCAL_MULTIPLAYER_MAX_CLIENTS = 8;
const LOCAL_MULTIPLAYER_DEFAULT_CLIENTS = 4;
/** A fixed address keeps the URL written into a game valid after OhMyGame restarts. */
export const LOCAL_MULTIPLAYER_PORT = 43139;
const LOCAL_ADAPTER_IDS: readonly string[] = ["gomoku", "stones", "arena", "roam", "custom"] satisfies LocalGameAdapterId[];

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

/** One daemon-owned service for local playtests. No public registration endpoint. */
export class LocalMultiplayerRuntime {
  private service?: ReturnType<typeof createMultiplayerServer>;
  private starting?: Promise<void>;

  constructor(private readonly preferredPort = LOCAL_MULTIPLAYER_PORT) {}

  /** rulesFile is the game's server/rules.ts, which custom needs and loads afresh each time. */
  async configure(
    gameId: string,
    adapterId: LocalGameAdapterId,
    options: LocalMultiplayerOptions = {},
    rulesFile?: string,
  ): Promise<MultiplayerManifestConfig> {
    const mode = adapterId === "arena" || adapterId === "roam" ? "realtime" : "turn-based";
    let rules: GameAdapter | undefined;
    if (adapterId === "custom") {
      if (!rulesFile)
        throw new Error("Write server/rules.ts first: turn-based rules from defineGame, exported as default.");
      const { loadGameRules } = await import("@ohmygame/server");
      rules = await loadGameRules(rulesFile);
    }
    // Roaming is a shared place to wander, so players drop in unless the game asks for private rooms.
    const dropIn = options.dropIn ?? adapterId === "roam";
    if (dropIn && mode !== "realtime")
      throw new Error("Drop-in rooms need realtime rules. Use arena or roam, or rooms with invitations for turn-based games.");
    const range = localPlayerRange(rules ?? createBuiltInAdapter(adapterId as BuiltInAdapterId));
    if (range.min > range.max)
      throw new Error(`These rules need ${describePlayerRange(rules!.players)} players; local rooms hold ${LOCAL_MULTIPLAYER_MIN_CLIENTS} to ${LOCAL_MULTIPLAYER_MAX_CLIENTS}.`);
    const maxClients = options.maxClients ?? Math.min(Math.max(LOCAL_MULTIPLAYER_DEFAULT_CLIENTS, range.min), range.max);
    if (!Number.isInteger(maxClients) || maxClients < range.min || maxClients > range.max)
      throw new Error(`Local ${adapterId} rooms hold ${describePlayerRange(range)} players.`);
    if (!this.starting) {
      this.starting = (async () => {
        const { createMultiplayerServer } =
          await import("@ohmygame/server");
        this.service = createMultiplayerServer({
          deployments: [],
          auth: { guestSecret: randomBytes(32).toString("hex") },
          databasePath: ":memory:",
          host: "127.0.0.1",
          port: await availablePort(this.preferredPort),
          allowLocalhost: true,
          logger: false,
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
    const config: MultiplayerManifestConfig = {
      enabled: true,
      mode,
      gameId,
      // Deployments are immutable, so each room size and policy is its own deployment.
      deploymentId: `local-${adapterId}-${maxClients}p${dropIn ? "-dropin" : ""}-v1`,
      protocolVersion: 1,
      serverUrl: `http://127.0.0.1:${this.service!.port}`,
      authPolicy: "anonymous",
      roomPolicy: dropIn ? "drop-in" : "invite-or-public",
      maxClients,
      // A wandering player who closed the tab need not hold a seat for long; turn-based seats wait.
      reconnectSeconds: dropIn ? 15 : 120,
      adapterId,
    };
    this.service!.registerLocalDeployment(config, rules);
    return config;
  }

  /**
   * Registers a game's local deployment again after OhMyGame restarted, at the
   * address the service has now, with its own rules reloaded from rulesFile.
   * Anything other than a deployment this runtime wrote for the game is left alone.
   */
  async restore(gameId: string, config: MultiplayerManifestConfig, rulesFile?: string): Promise<MultiplayerManifestConfig | undefined> {
    if (config.gameId !== gameId || !config.deploymentId.startsWith("local-") || !LOCAL_ADAPTER_IDS.includes(config.adapterId ?? "")) return undefined;
    const restored = await this.configure(gameId, config.adapterId as LocalGameAdapterId, {
      maxClients: config.maxClients,
      dropIn: config.roomPolicy === "drop-in",
    }, rulesFile);
    return sameMultiplayerConfig({ ...config, serverUrl: restored.serverUrl }, restored) ? restored : undefined;
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    await this.service?.stop();
    this.service = undefined;
    this.starting = undefined;
  }
}
