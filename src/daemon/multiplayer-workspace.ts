import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import {
  isMultiplayerManifestConfig,
  type MultiplayerManifestConfig,
} from "../shared/multiplayer-protocol.js";
import { resolveStartupDirectory } from "./projects.js";
import { multiplayerSdkResources } from "./multiplayer-sdk.js";

export async function installMultiplayerWorkspace(
  project: Pick<ProjectState, "workspacePath" | "startupDirectory">,
  config: MultiplayerManifestConfig,
) {
  if (!isMultiplayerManifestConfig(config, { allowLocalhost: true }))
    throw new Error("Invalid multiplayer deployment.");
  const { absolutePath: root } = await resolveStartupDirectory(
    project.workspacePath,
    project.startupDirectory ?? ".",
  );
  let resources: Record<string, string>;
  try {
    resources = await multiplayerSdkResources();
  } catch {
    throw new Error(
      "The multiplayer SDK is missing. Run bun run build:host and restart the app.",
    );
  }
  let manifest: Record<string, unknown> = {};
  const manifestPath = path.join(root, "public", "manifest.json");
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.runtime === "playable-nodes"
  )
    throw new Error(
      "This project does not have a supported Web Game manifest.",
    );
  const sdkPath = path.join(root, "src", "ohmygame");
  await mkdir(sdkPath, { recursive: true });
  for (const [name, contents] of Object.entries(resources)) {
    if (!/^[a-z-]+\.(?:js|d\.ts)$/.test(name) || typeof contents !== "string")
      throw new Error("Invalid bundled multiplayer SDK.");
    await writeFile(path.join(sdkPath, name), contents);
  }
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, version: 1, multiplayer: config }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "multiplayer.json"),
    `${JSON.stringify({ multiplayer: config }, null, 2)}\n`,
  );
  const guidePath = path.join(sdkPath, "README.md");
  await writeFile(guidePath, MULTIPLAYER_WORKSPACE_GUIDE);
  return {
    manifest: config,
    sdkPath: path.relative(root, sdkPath),
    manifestPath: path.relative(root, manifestPath),
    guidePath: path.relative(root, guidePath),
  };
}

const MULTIPLAYER_WORKSPACE_GUIDE = `# OhMyGame multiplayer

Use the Colyseus client in ./client.js. Do not replace it with PeerJS, WebRTC, public signaling servers, or browser-authoritative state.

Load the deployment from public/manifest.json at runtime, relative to the page's directory (new URL("./manifest.json", document.baseURI)). Validate it with isMultiplayerManifestConfig(config, { allowLocalhost: true }) only for local playtests. Construct new MultiplayerClient({ manifest: config, allowLocalhost: true, identityStorage: sessionStorage }, callbacks). Session-scoped guest identity lets two tabs play as different guests. Keep room recovery in sessionStorage too. Production account-required games must supply accessToken from the configured Supabase session.

Callbacks: onStatus(status), onReady(playerId, inviteCode), onSnapshot(snapshot), onCommandResult(result), onError(error). Display errors and connecting/reconnecting/closed states. A connected transport does not mean another player has joined. Use snapshot.state.players and snapshot.state.phase. The SDK times out a stalled connection after 15 seconds.

Await createRoom({ displayName }) or joinRoom({ roomCode, displayName }); await reconnect() to restore a saved room. Room codes are 16 hexadecimal characters, not six. Call sendCommand("start") as the owner after two players join. Commands are acknowledged by onCommandResult; show rejections. Render only authoritative snapshots; never optimistically place a stone or send a whole board. Use leave() when leaving the room, dispose() on page unload. The server can restore a disconnected player while its seat is reserved.

For adapterId gomoku, maxClients is 2. snapshot.state.game is validated by isGomokuState. Its board is a flat 15x15 array (0 empty, 1 black, 2 white); history and winningLine are { r, c } arrays, and blackWins/whiteWins are server scores. state.players[0] is black, state.currentPlayerId owns the next move. Send sendCommand("action", { action: "move", point: { r, c } }) for a move. Only the owner may send sendCommand("action", { action: "reset" }). Start, moves, turn timeouts, wins, reset, identity, and reconnect are server-owned. stones accepts take/pass; arena accepts bounded sendInput(x, y). These are explicit adapters, not universal rules for arbitrary games.

Local setup starts a loopback Colyseus backend owned by the running OhMyGame daemon. No cloud deployment is needed. Rooms are temporary and end when the daemon stops; rerun multiplayer_setup after restarting it to refresh the local service URL. Public publishing requires a separately hosted backend, an immutable registered deployment and its matching server rules. Missing service/rules must produce an explicit setup error; do not silently choose another networking stack.
`;
