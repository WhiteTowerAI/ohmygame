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
import type { LocalGameServices } from "./local-multiplayer.js";

/** Whether a URL is on this computer, as the local service's addresses are. */
function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}
/**
 * The manifest with the local service's sign-in, saves and leaderboards. A game that names
 * services of its own, off this computer, keeps them.
 */
function withLocalServices(manifest: Record<string, unknown>, services?: LocalGameServices): Record<string, unknown> {
  if (!services) return manifest;
  const next = { ...manifest };
  const account = manifest.account as { issuer?: unknown } | undefined;
  const cloud = manifest.cloud as { serverUrl?: unknown } | undefined;
  if (account === undefined || isLoopbackUrl(account?.issuer)) next.account = services.account;
  if (cloud === undefined || isLoopbackUrl(cloud?.serverUrl)) next.cloud = services.cloud;
  return next;
}

/**
 * Points a game's local sign-in, saves and leaderboards at the local service's current
 * address, after OhMyGame restarted. Only a game that already uses local ones changes.
 */
export async function moveLocalGameServices(
  project: Pick<ProjectState, "workspacePath" | "startupDirectory">,
  services: () => Promise<LocalGameServices>,
): Promise<void> {
  const { absolutePath: root } = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
  const file = path.join(root, "public", "manifest.json");
  const manifest = await readJsonObject(file);
  const account = manifest?.account as { issuer?: unknown } | undefined;
  const cloud = manifest?.cloud as { serverUrl?: unknown } | undefined;
  if (!manifest || (!isLoopbackUrl(account?.issuer) && !isLoopbackUrl(cloud?.serverUrl))) return;
  const current = await services();
  const next = { ...manifest };
  if (isLoopbackUrl(account?.issuer)) next.account = current.account;
  if (isLoopbackUrl(cloud?.serverUrl)) next.cloud = { ...current.cloud, gameId: (cloud as { gameId?: string }).gameId ?? current.cloud.gameId };
  if (JSON.stringify(next) !== JSON.stringify(manifest)) await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}

export async function installMultiplayerWorkspace(
  project: Pick<ProjectState, "workspacePath" | "startupDirectory">,
  config: MultiplayerManifestConfig,
  services?: LocalGameServices,
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
    `${JSON.stringify(withLocalServices({ ...manifest, version: 1, multiplayer: config }, services), null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "multiplayer.json"),
    `${JSON.stringify({ multiplayer: config }, null, 2)}\n`,
  );
  const guidePath = path.join(sdkPath, "README.md");
  await writeFile(guidePath, `${MULTIPLAYER_WORKSPACE_GUIDE}\n${CLOUD_SAVES_GUIDE}`);
  return {
    manifest: config,
    sdkPath: path.relative(root, sdkPath),
    manifestPath: path.relative(root, manifestPath),
    guidePath: path.relative(root, guidePath),
  };
}

/**
 * Writes the browser SDK and its guide into a Web Game for saves, leaderboards and sign-in,
 * and makes sure the game has a manifest for init() to load. A game set up for multiplayer
 * keeps its multiplayer deployment and guide.
 */
export async function installGameSdk(project: Pick<ProjectState, "workspacePath" | "startupDirectory">, services?: LocalGameServices) {
  const { absolutePath: root } = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
  let sdk: Record<string, string>;
  try {
    ({ sdk } = await multiplayerSdkResources());
  } catch {
    throw new Error("The OhMyGame SDK is missing. Run bun run build:host and restart the app.");
  }
  const manifestPath = path.join(root, "public", "manifest.json");
  const existing = await readFile(manifestPath, "utf8").then(
    (text) => JSON.parse(text) as unknown,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return {};
      throw cause;
    },
  );
  if (!existing || typeof existing !== "object" || Array.isArray(existing) || (existing as Record<string, unknown>).runtime === "playable-nodes")
    throw new Error("This project does not have a supported Web Game manifest.");
  const sdkPath = path.join(root, "src", "ohmygame");
  await mkdir(sdkPath, { recursive: true });
  for (const [name, contents] of Object.entries(sdk)) {
    if (!/^[a-z-]+\.(?:js|d\.ts)$/.test(name) || typeof contents !== "string") throw new Error("Invalid bundled SDK.");
    await writeFile(path.join(sdkPath, name), contents);
  }
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(withLocalServices({ version: 1, ...existing }, services), null, 2)}\n`);
  const multiplayer = await readWorkspaceMultiplayer(project);
  const guidePath = path.join(sdkPath, "README.md");
  await writeFile(guidePath, multiplayer ? `${MULTIPLAYER_WORKSPACE_GUIDE}\n${CLOUD_SAVES_GUIDE}` : `${SDK_WORKSPACE_GUIDE}\n${CLOUD_SAVES_GUIDE}`);
  return {
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

Use the Colyseus client in ./multiplayer.js, with init and the shared types from ./client.js. Do not replace it with PeerJS, your own WebRTC, public signaling servers, or browser-authoritative state. The one direct path between pages is the SDK's own p2p option for owner rooms, described below, which keeps the Colyseus service in the room.

Start with const game = await init({ allowLocalhost: true }) from ./client.js. It loads manifest.json beside the page (new URL("./manifest.json", document.baseURI)), so copy public/manifest.json into the build output, and it validates the deployment. Pass allowLocalhost: true as written, never import.meta.env.DEV or another build flag: local publishing plays the production build against the same local service, and public publishing already rejects a loopback deployment. Create the room connection with createMultiplayerClient(game, callbacks) from ./multiplayer.js and keep its default storage. multiplayer.js imports ./client.js, so keep both files together; a page that never imports multiplayer.js carries no room client. Keep create, join and play controls disabled until init and createMultiplayerClient have finished, and show init's error in the page if it fails. The guest identity and room recovery live in localStorage, so one browser is one player in every tab and can return to its seat after closing the tab. Do not pass sessionStorage or another per-tab store to create extra players. A second tab of the same browser is the same player and cannot take a second seat in the room; test another player in a private window or a different browser. Players sign in with their OhMyGame account: game.auth.signIn() signs the player in, game.auth.player is { id, name }, and rooms then use that account instead of a guest. Locally, OhMyGame's local service stands in with test accounts: any name signs in, and the same name is the same player in every browser. Offer sign-in only when game.auth.available is true.

Every SDK error is an OhMyGameError with a stable code, such as timeout, room_limit, sign_in_required or not_connected. Show error.message to the player and branch on error.code, never on the message text.

Callbacks: onStatus(status), onReady(playerId, inviteCode), onSnapshot(snapshot), onCommandResult(result), onError(error). Display errors and connecting/reconnecting/closed states. An error with code invalid_response means the service sent a room update this SDK cannot read, usually because the game's src/ohmygame files are older than the service: call multiplayer_setup again to update them. A connected transport does not mean another player has joined. Use snapshot.state.players and snapshot.state.phase. The SDK times out a stalled connection after 15 seconds.

Await createRoom({ displayName }) or joinRoom({ roomCode, displayName }); await reconnect() to restore a saved room. Room codes are 16 hexadecimal characters, not six. Call sendCommand("start") as the owner after two players join. Once a match has finished, the owner may call sendCommand("restart") to play again with the same seats: offer a Play again button to the owner only, shown when snapshot.state.phase is "finished". Commands are acknowledged by onCommandResult; show rejections. Render only authoritative snapshots; never optimistically place a stone or send a whole board. Use leave() when leaving the room, dispose() on page unload.

When manifest.roomPolicy is "drop-in" (arena set up with dropIn), show a single Play button that awaits quickPlay({ displayName }). The service puts the player in the fullest room with a free seat, or opens a new room when every room is full, and they may join a round in progress. There is no room owner: do not show start, kick or close controls. A round starts by itself once enough players are connected, with snapshot.state.phase "lobby" meaning waiting for players, and restarts a few seconds after it finishes. Every player receives an inviteCode in onReady; offer it as an invite link that friends open with joinRoom({ roomCode }). An invited room that is full rejects the join instead of moving the friend elsewhere, so show that error. When the service is at its room limit, quickPlay retries briefly and then rejects; show the message and a retry button. A player left alone in a drop-in room for a few seconds is moved by the SDK into the busiest room that has others and a free seat, so separated players meet. The move reconnects without a closed status, but onReady reports a new playerId and the next snapshot is the new room: always look up the local player by the latest onReady id, never cache it from the first join. Show the room ID and the number of connected players so testers can tell whether two windows share a room. A closed tab holds its seat for manifest.reconnectSeconds before it frees. The server can restore a disconnected player while its seat is reserved.

manifest.maxClients is the room size chosen at setup: 2 to 8 players, always 2 for gomoku. Read it from the manifest rather than hard-coding a player count, and lay out seats, spawns and scoreboards for that many players. For adapterId gomoku, maxClients is 2. snapshot.state.game is validated by isGomokuState from ./gomoku.js, which setup writes beside client.js for gomoku games together with GOMOKU_SIZE and the board types. Its board is a flat 15x15 array (0 empty, 1 black, 2 white); history and winningLine are { r, c } arrays, and blackWins/whiteWins are server scores. A player who runs out of time loses: the match finishes, the other colour scores, and game.forfeit is the colour that ran out of time (1 black, 2 white); show that as the reason. state.players[0] is black, state.currentPlayerId owns the next move. Send sendCommand("action", { action: "move", point: { r, c } }) for a move. After a match ends the owner may send sendCommand("restart") for a new board; the scores carry over. Start, moves, turn timeouts, wins, restart, identity, and reconnect are server-owned. For adapterId stones, snapshot.state.game.remaining is the pile, 21 at the start. Send sendCommand("action", { action: "take", count }) with count 1, 2 or 3 on your turn; there is no pass. Whoever takes the last stone wins, and after the race the owner may send sendCommand("restart") for a new pile. arena and roam move each player with sendInput({ x, y }), a direction from -1 to 1 on each axis and no other keys; call it every frame while input is held and with { x: 0, y: 0 } on release. The SDK sends at most one input per server tick, so per-frame calls are safe; do not add your own timers or send inputs another way. Positions are server-owned in a 100 by 100 world: scale state.players[].x and .y to your map, and interpolate between snapshots for smooth movement. arena is a race: reaching the centre ends the round, everyone who reaches it in the same tick wins together (state.winnerPlayerIds), and everyone respawns on a ring. roam has no goal and never ends: players spawn near the centre, walk at a fixed speed (about eight seconds across the world), and keep their position until they leave, which suits towns, lobbies and exploration. With roam, a single player can start; obstacles, buildings and interactions the server does not know about are visual only and cannot block movement. These are explicit adapters, not universal rules for arbitrary games. In a published game, gomoku, stones and arena count each player's wins on the leaderboard match.wins, which the service writes itself: show it with game.leaderboard.top("match.wins") and game.leaderboard.me("match.wins") when game.leaderboard.available is true, and never submit to it.

## Custom rules (adapterId custom)

A game that none of the built-in rules fits defines its own rules in server/rules.ts, beside multiplayer.json: defineGame for a turn-based game such as a card game, chess or a board game with hidden hands, defineRealtimeGame (below) for a realtime game such as multiplayer snake. Write the file before calling multiplayer_setup with adapterId custom, and call multiplayer_setup again after changing it: it loads the rules and reports any error, and sets the deployment's mode from them.

Turn-based rules, and realtime rules with playerView, run on one player's browser, the room's host, both locally and once the game is published; the manifest's adapterId is "host". The service keeps the room: seats, phase, turn order, reconnection and the saved state, and sends each player only what playerView lets them see. The host is the room owner while connected, otherwise the first connected player; when the host leaves or stops answering, another player takes over and play continues. So the page must import the rules and pass them: import rules from "../server/rules"; const client = createMultiplayerClient(game, callbacks, { rules }). Every player passes them, since any of them may host. Rules run in the browser, so server/rules.ts must not use Node APIs or the DOM, and must not depend on the page's own state. The host could cheat and sees all hidden information, such as every hand: custom rules suit casual play between friends. Never submit their match results to game.leaderboard; only built-in rules rank multiplayer players. client.hosting and the onHost(active) callback tell the page when it hosts, and snapshot.state.hostPlayerId names the host. A realtime host's browser runs the ticks: a host in a background tab slows the game, so suggest that players keep the game in front.

Realtime rules without playerView run in lockstep instead: the manifest's adapterId is "lockstep" and its tickMs is the rules' tickMs. Nobody hosts. The service numbers frames of everyone's input every tick and sends them to every player, and every player's browser steps the same rules from the same start, so each player sees their own input after one trip to the service and back, and everyone sees the same game. The page still passes { rules }, sends with sendInput and sendAction, and draws snapshot.state as it arrives; client.hosting stays false. That state runs ahead of the service, so the player's own input shows at once, but another player's new input arrives a round trip late and moves their part of the game when it does. To keep other players from jumping, draw the local player from snapshot.state and every other player from client.confirmed.state, the newest state the service confirmed, which is never corrected; move them smoothly between its updates, one tick's step over tickMs. Every browser must reach exactly the same state, so the rules must be deterministic: draw random numbers only with ctx.random() and read the time only with ctx.now(), never Math.random or Date.now; keep positions on whole numbers or a grid where the game allows it, and avoid Math.sin, Math.cos, Math.pow and similar functions, whose last digits can differ between browsers; never depend on anything outside G, ctx, the inputs and the actions. Call multiplayer_setup again after changing tickMs or adding or removing playerView, since either changes the deployment.

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

- setup(ctx, previous) runs when the owner sends start, and again when the owner sends restart after a match ends; previous is then the finished match's G, so a score can carry over. ctx.players lists the seated player IDs in join order. G must be plain JSON data.
- A move throws an Error to reject an illegal play; its message reaches the player. By default only ctx.currentPlayer may move, and the turn then passes to the next seat; call ctx.setCurrentPlayer(id) to choose who acts next, for example the winner of a bid. { run, by: "owner" | "any", afterEnd: true } allows a move from the owner or any seat, at any time, and after the match ended (accepting it resumes play). A new match is the room's restart command, not a move.
- Use ctx.random(), ctx.shuffle(items) and ctx.now(), never Math.random or Date.now: only the service deals and decides.
- endIf returns { winners: [playerIds] }, several for a team, or { winners: [], draw: true }. snapshot.state.winnerPlayerIds lists them.
- playerView hides what a player may not see, such as other players' hands; return counts instead. playerId is undefined for a spectator.
- A turn not taken within turnSeconds (default 60) passes to the next seat. To make running out of time cost something, add timeout(G, ctx): it runs with ctx.playerId the player who ran out of time, and endIf runs after it, so setting a flag in G that endIf reads makes them lose.
- server/rules.ts may import the game's own modules for shared logic such as card comparison, but nothing that touches the DOM or Node.

In the page, pass the rules, which also types the moves: import rules from "../server/rules"; const client = createMultiplayerClient(game, callbacks, { rules }); then client.moves.play({ cards }) sends the move and returns its command ID for onCommandResult. Render snapshot.state.game, which is playerView's result for this player.

### Realtime rules (defineRealtimeGame)

A realtime game, such as multiplayer snake, runs on the service's tick: every tickMs the service calls tick with each player's latest input and sends every player the new state. multiplayer_setup picks realtime mode from the rules; pass dropIn: true for a game players join while it runs.

    import { defineRealtimeGame } from "../src/ohmygame/define-game.js";
    type Dir = "up" | "down" | "left" | "right";
    export default defineRealtimeGame({
      players: { min: 1, max: 8 },
      tickMs: 120,
      setup: (ctx) => ({ food: placeFood(ctx), snakes: Object.fromEntries(ctx.players.map((id, i) => [id, spawn(i)])) }),
      input(value) {
        if (!["up", "down", "left", "right"].includes(value.dir as string)) throw new Error("Send { dir }.");
        return { dir: value.dir as Dir };
      },
      action(value) {
        if (value.boost !== true) throw new Error("Send { boost: true }.");
        return { boost: true as const };
      },
      tick(G, ctx, inputs, _dt, actions) {
        for (const { playerId } of actions) if (G.snakes[playerId]) G.snakes[playerId].boostTicks = 5; // once per press
        for (const [id, snake] of Object.entries(G.snakes)) {
          if (inputs[id]) snake.dir = turn(snake.dir, inputs[id].dir); // the heading lives in G
          // Move, grow on food, kill on collision; use ctx.random() for new food.
        }
      },
      join: (G, ctx, playerId) => { G.snakes[playerId] = spawn(ctx.players.length - 1); },
      leave: (G, _ctx, playerId) => { delete G.snakes[playerId]; },
      endIf: (G) => (alive(G).length <= 1 && Object.keys(G.snakes).length > 1 ? { winners: alive(G) } : undefined),
    });

- setup(ctx, previous) runs when a round starts: when the owner sends start or restart, or when a drop-in room starts or restarts a round. previous is the finished round's G when there is one, so scores can carry over. ctx.players lists the seats and ctx.connected those with an open connection.
- input(value, playerId) reads one input as the page sent it and returns it typed; throw an Error to reject it. The page calls client.sendInput({ dir }) whenever the player acts, as often as every frame; the SDK sends the latest input once per tick.
- tick(G, ctx, inputs, dt, actions) gets each player's latest input in inputs, keyed by playerId. An input counts for five ticks and then drops out, so keep anything that must persist, such as a heading, in G. dt is the tick in seconds.
- Something that happens once, such as firing, jumping or boosting, is an action, never part of the input: the page calls client.sendAction({ boost: true }) once per press, not every frame. action(value, playerId) reads and checks it like input; tick sees each action exactly once in actions, as { playerId, action } in arrival order. Rules without action take no actions. sendAction returns false when no room is connected.
- join and leave run when a seat is taken or given up while a round is running, as in drop-in rooms; endIf runs after every tick. A drop-in room starts the next round a few seconds after one ends; in a room with an owner, the round waits for the owner's restart.
- tickMs is 20 to 1000 (default 50). Grid games like snake usually use 80 to 150. The whole state goes to every player each tick, so keep G small: positions and scores, not rendering data. Interpolate between snapshots in the page for smooth motion.
- Use ctx.random(), ctx.shuffle(items) and ctx.now() as in turn-based rules.

In the page, const client = createMultiplayerClient(game, callbacks, { rules }) runs the rules when this player hosts, and types client.sendInput to the rules' input and client.sendAction to the rules' action.

## Owner rooms (adapterId owner)

For realtime casual and co-op games where each page can run its own player, such as a platformer for two, snake or a party game, set up with adapterId owner. There is no server/rules.ts: the page runs the whole game, its own player exactly as in a single-player game, and the service passes things on. Nothing a player does ever waits for the network, other players never jump, and nobody dies of something their screen did not show; in return each screen may differ slightly, so do not use it where results must be the same on every screen.

- createMultiplayerClient(game, callbacks) takes no rules. Join with quickPlay or a room as usual; a round plays while snapshot.state.phase is "playing".
- Run the local player's movement, physics and collisions in the page every frame, with Math.random, Date.now and any physics library as needed. Call client.setState({ ... }) whenever the local player's public state changes, such as position, heading, animation and score: a small plain object of JSON, at most 4096 characters. It goes out at most once per manifest.tickMs, only the top-level keys that changed, so keep a large part that rarely changes, such as a name or colour, in its own key, and send compact data, such as a snake's head and length rather than its whole body. Set it again at the start of each round.
- snapshot.state.game.players holds every player's latest state by playerId: the local player's as just set, the others' as they last arrived. Draw other players from it and move them smoothly toward each new state over manifest.tickMs instead of jumping. A snake's body can be rebuilt from the heads that arrived.
- Decide collisions that hurt the local player from what this screen shows, in the page. For an event both sides must agree on, such as a head-on crash, send client.emit({ crash: otherPlayerId }) and apply it in the onMessage(from, message) callback on the other page, so it counts when either side sees it.
- Things every player shares and only one may take, such as food, pickups, doors and switches, live in snapshot.state.game.shared, which client.updateShared(changes) changes. Each change is { key, value } to set or { key } to remove, and may require expect: the value it holds now, or expectAbsent: true. All changes in one call apply or none, so two players cannot take the same thing: eat food with await client.updateShared([{ key: "food:7", expect: { x, y } }, { key: "food:9", value: newFood, expectAbsent: true }]), and grow only if it resolves true. The first player to see an empty shared area sets it up the same way, with expectAbsent. Keys are up to 100 characters, values up to 1024 characters of JSON, at most 256 keys.
- When the round is decided, such as someone reaching the target score, call client.finishRound([winnerId, ...]); the first page to do so ends it for everyone. A drop-in room starts the next round a few seconds later, with every state and shared value cleared.
- A page can lie about its own player, so owner rooms suit casual play between friends. Never submit their results to game.leaderboard.
- For a fast-paced owner game, such as snake, a shooter or an action game, pass { p2p: true } in createMultiplayerClient's options: createMultiplayerClient(game, callbacks, { p2p: true }). Where two players' browsers can connect directly over WebRTC (usually when both have IPv6, as on most mobile networks), states and emit messages also go straight between them, about five times faster than through the service; everything still goes through the Colyseus service, which reaches the players who cannot connect, so the game code stays the same either way. It is built into the SDK: do not add WebRTC, PeerJS or STUN/TURN settings of your own, and multiplayer_setup has no option for it. Players learn each other's network addresses, so leave it off for slow or turn-like games. client.peers shows each other player as "connecting", "open" or "failed"; a small "direct" badge per player is optional.

Local setup starts a loopback Colyseus backend owned by the running OhMyGame daemon. No cloud deployment is needed. Rooms are temporary and end when the daemon stops; the deployment comes back on the next preview, playtest or local publish. Public publishing requires a separately hosted backend, an immutable registered deployment and its matching server rules. Missing service/rules must produce an explicit setup error; do not silently choose another networking stack.
`;

const SDK_WORKSPACE_GUIDE = `# OhMyGame SDK

Start with const game = await init({ allowLocalhost: true }) from ./client.js. It loads manifest.json beside the page (new URL("./manifest.json", document.baseURI)), so copy public/manifest.json into the build output; Vite does this for files in public/. Show init's error in the page if it fails. A page that never imports ./multiplayer.js carries no multiplayer code.

Pass allowLocalhost: true as written: locally the manifest names OhMyGame's local service, and publishing replaces it with OhMyGame's own services, so the same code runs in both.

Players sign in with their OhMyGame account: game.auth.signIn() signs the player in and game.auth.player is { id, name }. In a game published to OhMyGame that is the real account. In local previews, playtests and local publishing, OhMyGame's local service stands in: signIn() opens a local test sign-in page where any name signs in, and the same name is the same test player in every browser, so a second browser can test another device. Offer sign-in only when game.auth.available is true.

Every SDK error is an OhMyGameError with a stable code, such as offline, quota_exceeded, rate_limited or not_configured. Show error.message to the player and branch on error.code, never on the message text.
`;

const CLOUD_SAVES_GUIDE = `## Saves and leaderboards

game.storage keeps the player's progress. Await game.storage.set(key, value) with plain JSON (at most 64 KB a save, 32 keys a player; keys are letters, digits, dot, dash and underscore), game.storage.get(key), which resolves undefined when nothing is saved, game.storage.remove(key) and game.storage.keys(). Saves always land in this browser first, then on the game service (game.storage.cloud is true), so a signed-in player finds them on another device; a save made offline is sent when the browser is back online. Locally that service is OhMyGame's local one, which keeps saves in memory until OhMyGame quits; a published game uses OhMyGame's game service. Without a game service (game.storage.cloud is false) saves stay in the browser. The same code works everywhere, so never branch on cloud to decide whether to save. Save at natural points such as a finished level, not every frame. When a player who played as a guest signs in, a save the account does not have yet moves into it on the next get. Suggest signing in to keep progress across devices when game.auth.available is true and game.auth.player is undefined.

game.leaderboard works wherever the game has a game service (game.leaderboard.available is true), locally too; otherwise every call rejects with code not_configured, so hide leaderboards when available is false. Locally, http://127.0.0.1:<port>/dev/games/<gameId> on the local service (the manifest's cloud.serverUrl and cloud.gameId) shows every leaderboard entry and who has saves. Submit once at the end of a run with await game.leaderboard.submit(board, score), which resolves with the player's best { score, rank, public, improved }; pass { order: "asc" } for boards where lower is better, such as times; a board keeps the order of its first score. Show await game.leaderboard.top(board, { limit }) as [{ rank, playerId, name, score }] and await game.leaderboard.me(board) for the player's own rank. Only signed-in players appear on the public board: a guest's score is kept for them, with public false and the rank it would have. A player may submit 10 scores a minute; more reject with rate_limited.
`;
