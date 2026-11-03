import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import {
  isMultiplayerManifestConfig,
  sameMultiplayerConfig,
  type MultiplayerManifestConfig,
} from "@ohmygame/sdk/protocol";
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
    const { sdk, games } = await multiplayerSdkResources();
    resources = { ...sdk, ...(Object.hasOwn(games, config.adapterId) ? games[config.adapterId] : {}) };
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

/** The files that carry a game's deployment: the source declaration and the manifest the page loads. */
async function multiplayerFiles(project: Pick<ProjectState, "workspacePath" | "startupDirectory">) {
  const { absolutePath: root } = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
  return [path.join(root, "multiplayer.json"), path.join(root, "public", "manifest.json")];
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The local deployment declared in multiplayer.json, if the game has one. */
export async function readWorkspaceMultiplayer(
  project: Pick<ProjectState, "workspacePath" | "startupDirectory">,
): Promise<MultiplayerManifestConfig | undefined> {
  const [declaration] = await multiplayerFiles(project);
  const config = (await readJsonObject(declaration!))?.multiplayer;
  return isMultiplayerManifestConfig(config, { allowLocalhost: true }) ? config : undefined;
}

/** Points the game at the local service's current address, in each file that still declares `previous`. */
export async function moveWorkspaceMultiplayer(
  project: Pick<ProjectState, "workspacePath" | "startupDirectory">,
  previous: MultiplayerManifestConfig,
  config: MultiplayerManifestConfig,
): Promise<void> {
  for (const file of await multiplayerFiles(project)) {
    const value = await readJsonObject(file);
    const declared = value?.multiplayer;
    if (!isMultiplayerManifestConfig(declared, { allowLocalhost: true }) || !sameMultiplayerConfig(declared, previous)) continue;
    await writeFile(file, `${JSON.stringify({ ...value, multiplayer: config }, null, 2)}\n`);
  }
}

const MULTIPLAYER_WORKSPACE_GUIDE = `# OhMyGame multiplayer

Use the Colyseus client in ./multiplayer.js, with init and the shared types from ./client.js. Do not replace it with PeerJS, WebRTC, public signaling servers, or browser-authoritative state.

Start with const game = await init({ allowLocalhost: true }) from ./client.js. It loads manifest.json beside the page (new URL("./manifest.json", document.baseURI)), so copy public/manifest.json into the build output, and it validates the deployment. Pass allowLocalhost: true as written, never import.meta.env.DEV or another build flag: local publishing plays the production build against the same local service, and public publishing already rejects a loopback deployment. Create the room connection with createMultiplayerClient(game, callbacks) from ./multiplayer.js and keep its default storage. multiplayer.js imports ./client.js, so keep both files together; a page that never imports multiplayer.js carries no room client. Keep create, join and play controls disabled until init and createMultiplayerClient have finished, and show init's error in the page if it fails. The guest identity and room recovery live in localStorage, so one browser is one player in every tab and can return to its seat after closing the tab. Do not pass sessionStorage or another per-tab store to create extra players. A second tab of the same browser is the same player and cannot take a second seat in the room; test another player in a private window or a different browser. Production account-required games pass identity: { getToken } to init with the signed-in player's token.

Every SDK error is an OhMyGameError with a stable code, such as timeout, room_limit, sign_in_required or not_connected. Show error.message to the player and branch on error.code, never on the message text.

Callbacks: onStatus(status), onReady(playerId, inviteCode), onSnapshot(snapshot), onCommandResult(result), onError(error). Display errors and connecting/reconnecting/closed states. A connected transport does not mean another player has joined. Use snapshot.state.players and snapshot.state.phase. The SDK times out a stalled connection after 15 seconds.

Await createRoom({ displayName }) or joinRoom({ roomCode, displayName }); await reconnect() to restore a saved room. Room codes are 16 hexadecimal characters, not six. Call sendCommand("start") as the owner after two players join. Commands are acknowledged by onCommandResult; show rejections. Render only authoritative snapshots; never optimistically place a stone or send a whole board. Use leave() when leaving the room, dispose() on page unload.

When manifest.roomPolicy is "drop-in" (arena set up with dropIn), show a single Play button that awaits quickPlay({ displayName }). The service puts the player in the fullest room with a free seat, or opens a new room when every room is full, and they may join a round in progress. There is no room owner: do not show start, kick or close controls. A round starts by itself once enough players are connected, with snapshot.state.phase "lobby" meaning waiting for players, and restarts a few seconds after it finishes. Every player receives an inviteCode in onReady; offer it as an invite link that friends open with joinRoom({ roomCode }). An invited room that is full rejects the join instead of moving the friend elsewhere, so show that error. When the service is at its room limit, quickPlay retries briefly and then rejects; show the message and a retry button. A player left alone in a drop-in room for a few seconds is moved by the SDK into the busiest room that has others and a free seat, so separated players meet. The move reconnects without a closed status, but onReady reports a new playerId and the next snapshot is the new room: always look up the local player by the latest onReady id, never cache it from the first join. Show the room ID and the number of connected players so testers can tell whether two windows share a room. A closed tab holds its seat for manifest.reconnectSeconds before it frees. The server can restore a disconnected player while its seat is reserved.

manifest.maxClients is the room size chosen at setup: 2 to 8 players, always 2 for gomoku. Read it from the manifest rather than hard-coding a player count, and lay out seats, spawns and scoreboards for that many players. For adapterId gomoku, maxClients is 2. snapshot.state.game is validated by isGomokuState from ./gomoku.js, which setup writes beside client.js for gomoku games together with GOMOKU_SIZE and the board types. Its board is a flat 15x15 array (0 empty, 1 black, 2 white); history and winningLine are { r, c } arrays, and blackWins/whiteWins are server scores. state.players[0] is black, state.currentPlayerId owns the next move. Send sendCommand("action", { action: "move", point: { r, c } }) for a move. Only the owner may send sendCommand("action", { action: "reset" }). Start, moves, turn timeouts, wins, reset, identity, and reconnect are server-owned. For adapterId stones, snapshot.state.game.remaining is the pile, 21 at the start. Send sendCommand("action", { action: "take", count }) with count 1, 2 or 3 on your turn; there is no pass. Whoever takes the last stone wins, and after the race the owner may send sendCommand("action", { action: "reset" }) for a new pile. arena and roam move each player with sendInput({ x, y }), a direction from -1 to 1 on each axis and no other keys; call it every frame while input is held and with { x: 0, y: 0 } on release. The SDK sends at most one input per server tick, so per-frame calls are safe; do not add your own timers or send inputs another way. Positions are server-owned in a 100 by 100 world: scale state.players[].x and .y to your map, and interpolate between snapshots for smooth movement. arena is a race: reaching the centre ends the round and everyone respawns on a ring. roam has no goal and never ends: players spawn near the centre, walk at a fixed speed (about eight seconds across the world), and keep their position until they leave, which suits towns, lobbies and exploration. With roam, a single player can start; obstacles, buildings and interactions the server does not know about are visual only and cannot block movement. These are explicit adapters, not universal rules for arbitrary games.

## Custom rules (adapterId custom)

A turn-based game that none of the built-in rules fits, such as a card game, chess or a board game with hidden hands, defines its own rules in server/rules.ts, beside multiplayer.json. Write the file before calling multiplayer_setup with adapterId custom, and call multiplayer_setup again after changing it: it loads the rules and reports any error. OhMyGame also reloads the file before each preview, playtest and local publish.

    import { defineGame } from "../src/ohmygame/define-game.js";
    export default defineGame({
      players: { min: 3, max: 3 },
      setup: (ctx) => ({ hands: deal(ctx.shuffle(DECK), ctx.players), turnCount: 0 }),
      moves: {
        play(G, ctx, { cards }: { cards: string[] }) {
          if (!canPlay(G, ctx.playerId, cards)) throw new Error("Those cards cannot be played now.");
          // Change G in place or return a new one.
        },
        pass: (G, ctx) => { /* ... */ },
      },
      endIf: (G) => (finished(G) ? { winners: winnersOf(G) } : undefined),
      playerView: (G, _ctx, playerId) => ({ ...G, hands: onlyOwnHand(G.hands, playerId) }),
    });

- setup(ctx) runs when the owner sends start; ctx.players lists the seated player IDs in join order. G must be plain JSON data.
- A move throws an Error to reject an illegal play; its message reaches the player. By default only ctx.currentPlayer may move, and the turn then passes to the next seat; call ctx.setCurrentPlayer(id) to choose who acts next, for example the winner of a bid. { run, by: "owner" | "any", afterEnd: true } allows a move from the owner or any seat, at any time, and after the match ended (accepting it resumes play), for example a rematch.
- Use ctx.random(), ctx.shuffle(items) and ctx.now(), never Math.random or Date.now: only the service deals and decides.
- endIf returns { winners: [playerIds] }, several for a team, or { winners: [], draw: true }. snapshot.state.winnerPlayerIds lists them.
- playerView hides what a player may not see, such as other players' hands; return counts instead. playerId is undefined for a spectator.
- A turn not taken within turnSeconds (default 60) passes to the next seat.
- server/rules.ts may import the game's own modules for shared logic such as card comparison, but nothing that touches the DOM.

In the page, type the moves from the rules: import type rules from "../server/rules"; const client = createMultiplayerClient<typeof rules>(game, callbacks); then client.moves.play({ cards }) sends the move and returns its command ID for onCommandResult. Render snapshot.state.game, which is playerView's result for this player. Custom rules are turn-based only; a realtime game other than racing or free movement is not supported yet.

Local setup starts a loopback Colyseus backend owned by the running OhMyGame daemon. No cloud deployment is needed. Rooms are temporary and end when the daemon stops; the deployment comes back on the next preview, playtest or local publish. Public publishing requires a separately hosted backend, an immutable registered deployment and its matching server rules. Missing service/rules must produce an explicit setup error; do not silently choose another networking stack.
`;
