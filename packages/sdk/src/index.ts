import { OhMyGameError } from "./errors.js";
import { type IdentityProvider } from "./identity.js";
import {
  MultiplayerClient,
  type MultiplayerClientCallbacks,
  type MultiplayerClientOptions,
} from "./multiplayer-client.js";
import {
  isMultiplayerManifestConfig,
  isRecord,
  type MultiplayerManifestConfig,
} from "./multiplayer-protocol.js";

export { isOhMyGameError, OhMyGameError, type OhMyGameErrorCode } from "./errors.js";
export { GuestIdentity, type GuestIdentityOptions, type IdentityProvider } from "./identity.js";
export {
  defineGame,
  type ClientMoves,
  type GameContext,
  type GameDefinition,
  type GameResult,
  type MoveContext,
  type MoveDefinition,
  type MoveFunction,
  type MoveOptions,
} from "./define-game.js";

export interface InitOptions {
  /**
   * The game's manifest, or where to load it. Defaults to manifest.json beside the
   * page, which OhMyGame writes and publishing checks.
   */
  manifest?: { multiplayer?: unknown } | string | URL;
  /** The signed-in player. Without one, deployments that allow guests use a guest. */
  identity?: IdentityProvider;
  /** Opt in only for loopback development, never for a published deployment. */
  allowLocalhost?: boolean;
}

export type MultiplayerOptions = Omit<MultiplayerClientOptions, "manifest" | "identity" | "allowLocalhost">;

export interface OhMyGame {
  /** The game's multiplayer deployment, or undefined for a single-player game. */
  readonly multiplayer?: MultiplayerManifestConfig;
  /** A client for one player's room connection. Throws not_configured without a deployment. */
  createMultiplayerClient<Game = unknown>(callbacks?: MultiplayerClientCallbacks, options?: MultiplayerOptions): MultiplayerClient<Game>;
}

/** Reads the game's configuration once; every SDK feature starts from what it returns. */
export async function init(options: InitOptions = {}): Promise<OhMyGame> {
  const manifest = typeof options.manifest === "object" && !(options.manifest instanceof URL)
    ? options.manifest
    : await loadManifest(options.manifest);
  const declared = manifest.multiplayer;
  if (declared !== undefined && !isMultiplayerManifestConfig(declared, { allowLocalhost: options.allowLocalhost }))
    throw new OhMyGameError(
      "not_configured",
      options.allowLocalhost || !isMultiplayerManifestConfig(declared, { allowLocalhost: true })
        ? "The multiplayer deployment in manifest.json is invalid."
        : "This multiplayer deployment runs on this computer only. Pass allowLocalhost: true for local playtests.",
    );
  const multiplayer = declared as MultiplayerManifestConfig | undefined;
  return {
    multiplayer,
    createMultiplayerClient<Game>(callbacks?: MultiplayerClientCallbacks, clientOptions: MultiplayerOptions = {}) {
      if (!multiplayer)
        throw new OhMyGameError("not_configured", "This game has no multiplayer deployment in manifest.json.");
      return new MultiplayerClient<Game>(
        { ...clientOptions, manifest: multiplayer, identity: options.identity, allowLocalhost: options.allowLocalhost },
        callbacks,
      );
    },
  };
}

async function loadManifest(location?: string | URL): Promise<{ multiplayer?: unknown }> {
  const url = location === undefined
    ? new URL("./manifest.json", typeof document === "undefined" ? undefined : document.baseURI)
    : new URL(location, typeof document === "undefined" ? undefined : document.baseURI);
  let value: unknown;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`manifest.json returned ${response.status}.`);
    value = await response.json();
  } catch (cause) {
    throw new OhMyGameError("not_configured", `Could not load ${url.pathname}. Copy public/manifest.json into the build output.`, { cause });
  }
  if (!isRecord(value)) throw new OhMyGameError("not_configured", "manifest.json must contain a JSON object.");
  return value;
}
