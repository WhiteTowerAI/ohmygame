import { randomBytes } from "node:crypto";
import type { createMultiplayerServer } from "../multiplayer-server/service.js";
import type { MultiplayerManifestConfig } from "../shared/multiplayer-protocol.js";

export type LocalGameAdapterId = "gomoku" | "stones" | "arena";

/** One daemon-owned service for local playtests. No public registration endpoint. */
export class LocalMultiplayerRuntime {
  private service?: ReturnType<typeof createMultiplayerServer>;
  private starting?: Promise<void>;

  async configure(
    gameId: string,
    adapterId: LocalGameAdapterId,
  ): Promise<MultiplayerManifestConfig> {
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
      mode: adapterId === "arena" ? "realtime" : "turn-based",
      gameId,
      deploymentId: `local-${adapterId}-v1`,
      protocolVersion: 1,
      serverUrl: `http://127.0.0.1:${this.service!.port}`,
      authPolicy: "anonymous",
      roomPolicy: "invite-or-public",
      maxClients: adapterId === "gomoku" ? 2 : 4,
      reconnectSeconds: 120,
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
