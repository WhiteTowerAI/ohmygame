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

Load the deployment from public/manifest.json at runtime, relative to the page's directory (new URL("./manifest.json", document.baseURI)). Validate it with isMultiplayerManifestConfig(config, { allowLocalhost: true }) only for local playtests. Construct new MultiplayerClient({ manifest: config, allowLocalhost: true }, callbacks) and keep its default storage. The guest identity and room recovery live in localStorage, so one browser is one player in every tab and can return to its seat after closing the tab. Do not pass sessionStorage or another per-tab store to create extra players. A second tab of the same browser is the same player and cannot take a second seat in the room; test another player in a private window or a different browser. Production account-required games must supply accessToken from the configured Supabase session.

Callbacks: onStatus(status), onReady(playerId, inviteCode), onSnapshot(snapshot), onCommandResult(result), onError(error). Display errors and connecting/reconnecting/closed states. A connected transport does not mean another player has joined. Use snapshot.state.players and snapshot.state.phase. The SDK times out a stalled connection after 15 seconds.

Await createRoom({ displayName }) or joinRoom({ roomCode, displayName }); await reconnect() to restore a saved room. Room codes are 16 hexadecimal characters, not six. Call sendCommand("start") as the owner after two players join. Commands are acknowledged by onCommandResult; show rejections. Render only authoritative snapshots; never optimistically place a stone or send a whole board. Use leave() when leaving the room, dispose() on page unload.

When manifest.roomPolicy is "drop-in" (arena set up with dropIn), show a single Play button that awaits quickPlay({ displayName }). The service puts the player in the fullest room with a free seat, or opens a new room when every room is full, and they may join a round in progress. There is no room owner: do not show start, kick or close controls. A round starts by itself once enough players are connected, with snapshot.state.phase "lobby" meaning waiting for players, and restarts a few seconds after it finishes. Every player receives an inviteCode in onReady; offer it as an invite link that friends open with joinRoom({ roomCode }). An invited room that is full rejects the join instead of moving the friend elsewhere, so show that error. When the service is at its room limit, quickPlay retries briefly and then rejects; show the message and a retry button. A player left alone in a drop-in room for a few seconds is moved by the SDK into the busiest room that has others and a free seat, so separated players meet. The move reconnects without a closed status, but onReady reports a new playerId and the next snapshot is the new room: always look up the local player by the latest onReady id, never cache it from the first join. Show the room ID and the number of connected players so testers can tell whether two windows share a room. A closed tab holds its seat for manifest.reconnectSeconds before it frees. The server can restore a disconnected player while its seat is reserved.

manifest.maxClients is the room size chosen at setup: 2 to 8 players, always 2 for gomoku. Read it from the manifest rather than hard-coding a player count, and lay out seats, spawns and scoreboards for that many players. For adapterId gomoku, maxClients is 2. snapshot.state.game is validated by isGomokuState. Its board is a flat 15x15 array (0 empty, 1 black, 2 white); history and winningLine are { r, c } arrays, and blackWins/whiteWins are server scores. state.players[0] is black, state.currentPlayerId owns the next move. Send sendCommand("action", { action: "move", point: { r, c } }) for a move. Only the owner may send sendCommand("action", { action: "reset" }). Start, moves, turn timeouts, wins, reset, identity, and reconnect are server-owned. stones accepts take/pass. arena and roam move each player with sendInput(x, y), a direction from -1 to 1 on each axis; call it every frame while input is held and with (0, 0) on release. The SDK sends at most one input per server tick, so per-frame calls are safe; do not add your own timers or send inputs another way. Positions are server-owned in a 100 by 100 world: scale state.players[].x and .y to your map, and interpolate between snapshots for smooth movement. arena is a race: reaching the centre ends the round and everyone respawns on a ring. roam has no goal and never ends: players spawn near the centre, walk at a fixed speed (about eight seconds across the world), and keep their position until they leave, which suits towns, lobbies and exploration. With roam, a single player can start; obstacles, buildings and interactions the server does not know about are visual only and cannot block movement. These are explicit adapters, not universal rules for arbitrary games.

Local setup starts a loopback Colyseus backend owned by the running OhMyGame daemon. No cloud deployment is needed. Rooms are temporary and end when the daemon stops; rerun multiplayer_setup after restarting it to refresh the local service URL. Public publishing requires a separately hosted backend, an immutable registered deployment and its matching server rules. Missing service/rules must produce an explicit setup error; do not silently choose another networking stack.
`;
