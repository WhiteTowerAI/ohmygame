// Multiplayer lives in its own entry, @ohmygame/sdk/multiplayer, so a game that does not
// import it carries no room client: nothing here may import multiplayer-client.
import { browserAccountEnvironment, OhMyGameAccount, type AccountEnvironment, type GameAuth } from "./account.js";
import { isGameAccountConfig } from "./account-protocol.js";
import { OhMyGameError } from "./errors.js";
import { type IdentityProvider } from "./identity.js";
import {
  isMultiplayerManifestConfig,
  isRecord,
  type MultiplayerManifestConfig,
} from "./multiplayer-protocol.js";

export { isOhMyGameError, OhMyGameError, type OhMyGameErrorCode } from "./errors.js";
export type { GameAuth } from "./account.js";
export {
  gameTokenAudience,
  isGameAccountConfig,
  type GameAccountConfig,
  type OhMyGamePlayer,
} from "./account-protocol.js";
export { GuestIdentity, type GuestIdentityOptions, type IdentityProvider } from "./identity.js";
export {
  defineGame,
  defineRealtimeGame,
  type ClientInput,
  type ClientMoves,
  type RealtimeGameContext,
  type RealtimeGameDefinition,
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
  manifest?: { multiplayer?: unknown; account?: unknown } | string | URL;
  /**
   * Who the player is for game services, in place of the OhMyGame account in game.auth.
   * Without either, deployments that allow guests use a guest.
   */
  identity?: IdentityProvider;
  /** Opt in only for loopback development, never for a published deployment. */
  allowLocalhost?: boolean;
  /** @internal Browser stand-ins for tests. */
  accountEnvironment?: AccountEnvironment;
}

/**
 * The game's configuration, which every SDK feature starts from. For rooms, pass it to
 * createMultiplayerClient from @ohmygame/sdk/multiplayer.
 */
export interface OhMyGame {
  /** The game's multiplayer deployment, or undefined for a single-player game. */
  readonly multiplayer?: MultiplayerManifestConfig;
  /** The player's OhMyGame account. Sign-in is available in games published to OhMyGame. */
  readonly auth: GameAuth;
  /** @internal The player identity from init, for the SDK's own modules. */
  readonly identity?: IdentityProvider;
  /** @internal Whether init allowed a loopback deployment. */
  readonly allowLocalhost?: boolean;
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
  const account = manifest.account;
  if (account !== undefined && !isGameAccountConfig(account, { allowLocalhost: options.allowLocalhost }))
    throw new OhMyGameError("not_configured", "The account settings in manifest.json are invalid.");
  const auth = new OhMyGameAccount(account, options.accountEnvironment ?? browserAccountEnvironment());
  // In the sign-in popup, init hands the result back and the window closes; the game must not start there.
  if ((await auth.start()) === "popup") return new Promise<OhMyGame>(() => {});
  return {
    multiplayer: declared as MultiplayerManifestConfig | undefined,
    auth,
    identity: options.identity ?? (auth.available ? auth : undefined),
    allowLocalhost: options.allowLocalhost,
  };
}

async function loadManifest(location?: string | URL): Promise<{ multiplayer?: unknown; account?: unknown }> {
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
