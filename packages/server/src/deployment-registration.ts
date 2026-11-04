import { createHash } from "node:crypto";
import { isRecord, type MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";

/**
 * Publishers register their games' multiplayer deployments with the service when they
 * publish, instead of an operator editing the deployment file. A deployment is only room
 * settings, never code: the rules are built in or run on a player's browser.
 */
export interface DeploymentRegistrationOptions {
  /** This service's public HTTPS origin, which deployments name as their serverUrl. */
  publicUrl: string;
  /** Whether the bearer of token owns gameId. See cloudGameOwnerCheck. */
  verifyOwner(gameId: string, token: string): Promise<boolean>;
  /** The most deployments one game may register. Defaults to 50. */
  maxPerGame?: number;
}

/** The settings a publisher chooses; the service fills in the rest. */
export interface DeploymentRequest {
  mode: MultiplayerManifestConfig["mode"];
  adapterId: string;
  maxClients: number;
  roomPolicy: MultiplayerManifestConfig["roomPolicy"];
  reconnectSeconds: number;
}

export function isDeploymentRequest(value: unknown): value is DeploymentRequest {
  if (!isRecord(value)) return false;
  const allowed = new Set(["mode", "adapterId", "maxClients", "roomPolicy", "reconnectSeconds"]);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    typeof value.mode === "string" && typeof value.adapterId === "string" &&
    typeof value.maxClients === "number" && typeof value.roomPolicy === "string" && typeof value.reconnectSeconds === "number";
}

/**
 * The deployment for these settings. Its ID comes from the settings, so registering the
 * same settings again finds the same deployment, and a change makes a new one, as
 * deployments never change once registered.
 */
export function deploymentFor(gameId: string, request: DeploymentRequest, publicUrl: string): MultiplayerManifestConfig {
  const settings = {
    mode: request.mode,
    adapterId: request.adapterId,
    maxClients: request.maxClients,
    roomPolicy: request.roomPolicy,
    reconnectSeconds: request.reconnectSeconds,
    // Published games let players sign in, and let guests play.
    authPolicy: "guest-or-account" as const,
  };
  const deploymentId = `d-${createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 20)}`;
  return {
    enabled: true,
    gameId,
    deploymentId,
    protocolVersion: 1,
    serverUrl: publicUrl,
    ...settings,
  };
}

/**
 * Owners per OhMyGame's cloud API: GET {cloudApiUrl}/v1/games/{id} with the publisher's
 * token answers 200 only for the game's owner.
 */
export function cloudGameOwnerCheck(cloudApiUrl: string, request: typeof fetch = fetch) {
  return async (gameId: string, token: string): Promise<boolean> => {
    const response = await request(new URL(`/v1/games/${encodeURIComponent(gameId)}`, cloudApiUrl), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 200) return true;
    if ([401, 403, 404].includes(response.status)) return false;
    throw new Error(`The cloud API answered ${response.status}.`);
  };
}
