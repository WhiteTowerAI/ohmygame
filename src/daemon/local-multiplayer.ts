import { randomBytes } from "node:crypto";
import type { createMultiplayerServer } from "../multiplayer-server/service.js";
import type { MultiplayerManifestConfig } from "../shared/multiplayer-protocol.js";
import { createBuiltInAdapter, describePlayerRange, type BuiltInAdapterId } from "../multiplayer-server/adapters.js";

export type LocalGameAdapterId = BuiltInAdapterId;
export interface LocalMultiplayerOptions {
  maxClients?: number;
  /** Players join a running round without creating a room. Realtime rules only; roam defaults to it. */
  dropIn?: boolean;
}

/** Generated games stay small until larger rooms have rules and load tests. */
export const LOCAL_MULTIPLAYER_MIN_CLIENTS = 2;
export const LOCAL_MULTIPLAYER_MAX_CLIENTS = 8;
const LOCAL_MULTIPLAYER_DEFAULT_CLIENTS = 4;

/** The local cap narrowed to the seats the rules support, so gomoku is always 2. */
function localPlayerRange(adapterId: LocalGameAdapterId) {
  const { players } = createBuiltInAdapter(adapterId);
  return {
    min: Math.max(LOCAL_MULTIPLAYER_MIN_CLIENTS, players.min),
    max: Math.min(LOCAL_MULTIPLAYER_MAX_CLIENTS, players.max),
  };
}

/** One daemon-owned service for local playtests. No public registration endpoint. */
export class LocalMultiplayerRuntime {
  private service?: ReturnType<typeof createMultiplayerServer>;
  private starting?: Promise<void>;

  async configure(
    gameId: string,
    adapterId: LocalGameAdapterId,
    options: LocalMultiplayerOptions = {},
  ): Promise<MultiplayerManifestConfig> {
    const mode = adapterId === "arena" || adapterId === "roam" ? "realtime" : "turn-based";
    // Roaming is a shared place to wander, so players drop in unless the game asks for private rooms.
    const dropIn = options.dropIn ?? adapterId === "roam";
    if (dropIn && mode !== "realtime")
      throw new Error("Drop-in rooms need realtime rules. Use arena or roam, or rooms with invitations for turn-based games.");
    const range = localPlayerRange(adapterId);
    const maxClients = options.maxClients ?? Math.min(Math.max(LOCAL_MULTIPLAYER_DEFAULT_CLIENTS, range.min), range.max);
    if (!Number.isInteger(maxClients) || maxClients < range.min || maxClients > range.max)
      throw new Error(`Local ${adapterId} rooms hold ${describePlayerRange(range)} players.`);
    if (!this.starting) {
      this.starting = (async () => {
        const { createMultiplayerServer } =
          await import("../multiplayer-server/service.js");
        this.service = createMultiplayerServer({
          deployments: [],
          auth: { guestSecret: randomBytes(32).toString("hex") },
          databasePath: ":memory:",
          host: "127.0.0.1",
          port: 0,
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
    this.service!.registerLocalDeployment(config);
    return config;
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    await this.service?.stop();
    this.service = undefined;
    this.starting = undefined;
  }
}
