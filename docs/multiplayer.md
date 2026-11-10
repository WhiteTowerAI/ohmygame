# Multiplayer game integration

OhMyGame browser multiplayer uses Colyseus rooms over WebSocket. The service
owns game rules, player membership, turn order, state, and command validation.
PeerJS and WebRTC are not part of this integration.

## Local playtests

The game agent calls `multiplayer_setup` with `adapterId: "gomoku"`, `"stones"`,
`"arena"`, `"roam"`, or `"custom"`, and optionally `maxClients` for the room size.
`custom` loads the game's own rules from `server/rules.ts` beside
`multiplayer.json`: turn-based rules from [`defineGame`](#writing-rules-with-definegame)
or realtime rules from [`defineRealtimeGame`](#realtime-rules-with-definerealtimegame),
which also decide the room's mode;
the agent writes that file first, and calls setup again after changing it to
check that it loads. These rules run on a player's browser, locally and once
published: the deployment's `adapterId` is `"host"`; see
[rules on a player's browser](#rules-on-a-players-browser). Local rooms hold 2 to 8 players, narrowed to the seats the
rules support: gomoku is always 2, and the others default to 4. The realtime rules also accept `dropIn`, which roam
turns on by default; see [Drop-in rooms](#drop-in-rooms). Each room size and
policy is its own deployment, such as `local-arena-8p-v1`,
`local-roam-4p-dropin-v1` or `local-host-realtime-4p-dropin-v1`. The daemon starts one shared Colyseus service on
loopback port 43139, or on a free port when another process holds it, and
registers the project's local deployment. This needs no cloud account, public
backend, signaling server, STUN, or TURN.

The service and its registrations end when OhMyGame quits. Before a game that
declares a local deployment previews, playtests, or publishes locally, the
daemon starts the service again and registers the same deployment. If the
service now listens on another port, it rewrites `serverUrl` in
`multiplayer.json` and `public/manifest.json` wherever they still declare the
old deployment. Rooms do not survive the restart.

Setup writes these files under the configured startup directory:

| File                                      | Purpose                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `src/ohmygame/client.js` and declarations | Bundled browser SDK core: `init`, errors, identity, protocol types             |
| `src/ohmygame/multiplayer.js`             | Room client; imports `./client.js`, so the two stay side by side               |
| `src/ohmygame/gomoku.js` and declarations | Gomoku board helpers, written only for `gomoku` games                          |
| `src/ohmygame/README.md`                  | API, identity, room, command, and adapter instructions                         |
| `public/manifest.json`                    | Runtime deployment configuration copied by Vite into the build                 |
| `multiplayer.json`                        | Source declaration used to detect a build that dropped or changed the manifest |

The game must integrate the SDK; setup does not rewrite gameplay. Start with
`await init({ allowLocalhost: true })`: it loads `./manifest.json` relative to
the page directory and validates its `multiplayer` configuration. Enable
`allowLocalhost` only for local testing. `createMultiplayerClient(game, callbacks)`
from `./multiplayer.js` (`@ohmygame/sdk/multiplayer` in a package build) returns the
player's `MultiplayerClient`. The room client lives only in that entry: a game that
imports nothing but `client.js` or `@ohmygame/sdk`, such as a single-player game,
carries no Colyseus code in its build. `multiplayer.js` takes the shared modules from
`client.js` rather than a copy, so `instanceof OhMyGameError` holds for either file. In a game published to OhMyGame,
`game.auth.signIn()` signs the player in with their OhMyGame account and rooms use that
account; see [Game sign-in](game-sign-in.md). Local builds have no sign-in
(`game.auth.available` is false). Without a signed-in player, a deployment that allows
guests joins as one. The service accepts accounts only when it is started with
`OHMYGAME_ACCOUNT_ISSUER`. The guest identity and room recovery both live in `localStorage`, so a
browser is one player in every tab, and can return to its seat after the tab
closes. A second tab is the same player and cannot take a second seat in a room.
While a dropped player's seat waits for them (`reconnectSeconds`), the same
player joining that room again without the saved room, such as from another
device signed in to the same account, takes the seat over; a seat whose
connection is still open stays with it. A full room accepts no joins while a seat
waits, so there only the browser that saved the room gets back in.
Games must keep this default rather than pass per-tab storage to mint extra
players. Test another player in a private window or a different browser.

Use `createRoom`, `joinRoom({ roomCode })`, and `reconnect`. Room invitation codes
contain 16 hexadecimal characters. Render `onSnapshot` data and handle
`onReady`, `onStatus`, `onCommandResult`, and `onError`. Commands submit intent,
not a client-computed board or winner. Stalled connections fail after 15 seconds;
HTTP requests have their own 10-second timeout. The game must display the error
and allow retry instead of keeping an indefinite connection spinner. Every SDK
error is an `OhMyGameError` whose `code` (such as `timeout`, `room_limit`,
`sign_in_required`, or `not_connected`) stays stable while messages may change.
A snapshot the SDK cannot read, such as one from a service with a newer room
protocol, or one for another deployment, is dropped and reported once per
connection as `invalid_response`, so a game with an out-of-date SDK shows an error
instead of an empty room.

Test two independent players creating and joining a room, an accepted command,
an illegal command, a refresh/reconnect, and an unavailable service. The local
backend listens only on loopback: another device cannot access it through
`127.0.0.1`. Rooms are temporary and end when the daemon stops; the deployment
comes back on the next preview, playtest, or local publish, which also reloads a
game's `server/rules.ts` for rooms opened afterwards. Rooms already open keep
the rules they started with. Custom rules run only on this computer: playing
such a game publicly needs a separately deployed server with those rules.

For a game that already has the generated files, a separate backend can run with
a fixed local URL in both manifests:

```sh
npx @ohmygame/server dev /absolute/path/to/game-workspace
# in this repository, which also serves the built-in rules:
bun run multiplayer:local /absolute/path/to/game-workspace
```

`ohmygame-server dev` serves only a game's own rules. `bun run multiplayer:local`
also registers OhMyGame's built-in rules, so it runs games set up with `gomoku`,
`stones`, `arena`, or `roam` too. This command reads `multiplayer.json`, listens on its loopback HTTP port, and
keeps rooms in memory until stopped. A game with its own rules keeps them in
`server/rules.ts` (or `.js`/`.mjs`), written with
[`defineGame`](#writing-rules-with-definegame) or
[`defineRealtimeGame`](#realtime-rules-with-definerealtimegame) and exported as
default, under an `adapterId` of its own; `mode` in `multiplayer.json` must match
the rules. The command bundles that file with what
it imports, so the rules can share code with the page and need no OhMyGame package
installed: `@ohmygame/server` and `@ohmygame/sdk` imports resolve to the module with
`defineGame` and `defineRealtimeGame`.
When the rules or their imports change, it reloads them and restarts the rooms;
an edit that does not load leaves the previous rules running. Serve the game's
normal preview or static build separately. Its guest identities also expire when
the process stops; clear that game's session storage before a new standalone
test session.

## Game rules

Every deployment names its rules with a required `adapterId`, which is immutable
for that deployment. The service plays only the adapters it is given in
`createMultiplayerServer({ adapters })`: `@ohmygame/server` ships none, and an
unknown `adapterId` fails service startup rather than falling back to another
game. Each adapter declares the `mode` it plays, and a deployment of another mode
is rejected.

OhMyGame's built-in rules, `gomoku`, `stones`, `arena`, and `roam`, live in the
private `@ohmygame/games` package (`packages/games/`). `createBuiltInAdapters()`
returns them by ID; the desktop's local service, `bun run multiplayer:local`, and
OhMyGame's hosted service (`bun run start:multiplayer`,
`packages/games/src/server.ts`) register them the same way any operator registers
custom rules.

Each adapter declares the seats its rules support as `players: { min, max }`.
The service rejects a deployment whose `maxClients` falls outside that range, and
the room refuses `start` until at least `min` players are connected. The rules
adapter does not repeat these checks. Stones and arena accept 2 to 32 players,
the protocol's limit; roam starts with one.

The protocol's own commands are `start`, `close`, and `kick`, which manage the
room; every move of a game is an `action` whose payload names it, such as
`{ action: "take", count: 2 }`. The room state carries no game's fields: rules
keep theirs in `state.game`. When the owner removes a player during a match, the
turn passes on, and the match ends without a winner if fewer seats remain than
the rules' `players.min`. Rules written with `defineGame` then run `endIf` with
the remaining players, which may declare a result instead. A finished match
always sets both `winnerPlayerIds` and `winnerPlayerId`.

`stones` is a take-away race written with `defineGame`. `state.game.remaining`
starts at 21; the current player sends `{ action: "take", count }` with a count of
1 to 3, there is no pass, and whoever takes the last stone wins. After the race the
owner sends `restart` for a new pile, which the first seat starts.

Once a match has finished, the owner sends `restart` to play another with the same
seats; before then it is rejected. It works for every game in a room with an owner,
turn-based or realtime, and needs as many connected players as `start`. The room
clears the winners and sets the round up again as at `start`: rules from
`defineGame` or `defineRealtimeGame` run `setup` with the finished match's game, so
a score can carry over. Drop-in rooms have no owner and restart on their own.

`arena` is a race: the first player to reach the centre wins, and in a drop-in
room everyone respawns on a ring around it for the next round. `roam` has no goal
and never ends. Players spawn near the centre of the same 100 × 100 world, walk
at 12 units a second, stop at its edges, and keep their position until they
leave. It suits shared towns, lobbies, and exploration. The service knows nothing
of a game's map, so buildings and obstacles cannot block movement, and
interactions with them are not shared between players.

Realtime games call `sendInput(input)` every frame while input is held, and
`sendAction(action)` once for something that happens once, such as firing; see
[realtime rules](#realtime-rules-with-definerealtimegame). The input
is a plain object in the shape the rules read: `arena` and `roam` take
`{ x, y }`, each axis from -1 to 1, and `{ x: 0, y: 0 }` on release. Any input is
plain JSON of at most 512 characters (`REALTIME_INPUT_MAX_LENGTH`), nested no more
than four levels, and never uses the key `inputId`, which the SDK adds; otherwise
`sendInput` throws `invalid_option`. The SDK sends the latest input at most once per
service tick, which the service reports when the player joins, and keeps resending
it while the game keeps calling. In a room whose rules the service runs it times
those sends to reach the service just before its tick, from when snapshots arrive
and the round trip it measures every two seconds (`ping`, answered with `pong`);
until it knows both, it sends once a tick from the first send. An input that
differs from the last one sent, such as a key just pressed, goes out at once
instead of at the next tick's send, unless a send went out under half a tick
ago; these early sends are limited to four a second (two at once), so an input
that changes every frame still sends about once a tick. The room passes the rules only inputs from the
last five ticks (at least 250 ms), so a player who stops sending stops steering.
A realtime connection may send twice the tick rate in messages a second, and at
least 40; beyond that it is closed with code 4002. The room releases that seat
immediately rather than holding it for reconnection, so the client reports the
closed connection instead of a frozen game. Turn-based connections may send ten
messages a second.

`gomoku` requires turn-based mode and declares exactly two seats. Black is
`state.players[0]`; the service selects `currentPlayerId`. Its `state.game` holds
a flat 15 × 15 board, move history, winning line, and black/white scores. Use
`isGomokuState` from `src/ohmygame/gomoku.js` to validate it. The owner sends `start` after both players join;
players send `action` with `{ action: "move", point: { r, c } }`. The service
rejects out-of-turn, out-of-bounds, occupied, and extra-field moves, calculates
five-in-a-row and draws, and preserves scores across the owner's `restart`,
which is accepted once a match has ended. Running out of time loses the match: the
other colour wins and scores, and `state.game.forfeit` names the colour that ran out
of time (1 black, 2 white).

`createMultiplayerServer({ adapters })` can accept additional trusted rules
adapters keyed by ID. `MultiplayerGameAdapter` is experimental: rules should use
`defineGame` or `defineRealtimeGame`, and the adapter form may change. A realtime
adapter supplies `step(state, inputs, now, dt, actions)`, which the
room calls on every tick of a round, with or without input, where `dt` is the
tick in seconds and `actions` lists the actions since the last tick in arrival
order. It may set `tickMs` (a whole number from 20 to 1000, default 50),
`validateInput(input, playerId)`, which throws to reject an input with that
message, `validateAction(action, playerId)`, without which the room refuses
actions, and `onPlayerLeave` when a seat is given up during a round. Any adapter
may set `onRoundStart(state, now, finished)`, which the room calls after `start`
and `restart` and when a drop-in round begins, with the finished state when there
is one;
`arena` and `roam` move at a fixed number of map units per second times `dt`. Adapters use the common room state envelope, keep custom
serializable state in `state.game`, and validate action payloads on the service.
Rules with hidden information, such as a hand of cards, implement
`viewFor(state, playerId)` to return what that seat may see; `playerId` is
undefined for a connection without a seat. The room sends every connection its
own snapshot as a message, and the HTTP snapshot route applies the same view, so
no shared room state carries another player's data. Without `viewFor`, every
player sees the whole state.
The service operator registers this code; browsers never upload executable
rules. Merely declaring an adapter name or a multiplayer manifest is insufficient.

### Writing rules with `defineGame`

Turn-based rules can be plain functions instead of an adapter.
`defineGame` (from `@ohmygame/server`, or `@ohmygame/sdk/game` for types in the
page) takes `players`, `setup(ctx, previous)` for the game at `start` and
`restart` (`previous` is the finished match's game on a restart), `moves`, and the
optional `endIf(G, ctx)`, `playerView(G, ctx, playerId)`, `turnSeconds`
(default 60), and `timeout(G, ctx)`, which runs when the current player
(`ctx.playerId`) runs out of time and before `endIf`; without it the turn passes to
the next seat. `compileGame(rules)` returns the adapter to register:

```ts
const rules = defineGame({
  players: { min: 3, max: 3 },
  setup: (ctx) => ({ hands: deal(ctx.shuffle(deck), ctx.players), played: [] }),
  moves: {
    play(G, ctx, { cards }: { cards: string[] }) {
      if (!holds(G.hands[ctx.playerId], cards)) throw new Error("You do not hold those cards.");
      // Change G in place or return a new one.
    },
  },
  endIf: (G) => (G.hands[G.lastPlayer]?.length === 0 ? { winners: [G.lastPlayer] } : undefined),
  playerView: (G, _ctx, playerId) => ({ ...G, hands: onlyOwnHand(G.hands, playerId) }),
});
createMultiplayerServer({ adapters: { cards: compileGame(rules) }, ... });
```

A move runs only on the service, once per accepted command; throwing rejects it
with the error message. By default only the current player may make a move, and
the turn then passes to the next seat; `ctx.setCurrentPlayer(id)` chooses
otherwise. `{ run, by: "owner" | "any", afterEnd: true }` permits a move from the
owner or any seat at any time, and after the match ends, which resumes play. Use
`ctx.random()`, `ctx.shuffle()`, and `ctx.now()` rather than `Math.random` or
`Date.now`. `G` must stay plain data. `endIf` returns `{ winners }`; several
winners, such as a team, appear in `state.winnerPlayerIds`, and `winnerPlayerId`
holds a single winner or is empty. In the page,
`createMultiplayerClient<typeof rules>(game)` types `client.moves.play({ cards })`,
which sends `{ action: "play", cards }`. The built-in gomoku and stones rules are
written this way. `legalMoves` is reserved for bots and is not called yet.

### Realtime rules with `defineRealtimeGame`

Realtime games, such as multiplayer snake, run on the room's tick instead of turns.
`defineRealtimeGame` takes `players`, `tickMs` (20 to 1000, default 50),
`setup(ctx, previous)`, `input(value, playerId)`, `tick(G, ctx, inputs, dt, actions)`,
and the optional `action`, `join`, `leave`, `endIf`, and `playerView`. `compileGame`
compiles either kind:

```ts
const rules = defineRealtimeGame({
  players: { min: 1, max: 8 },
  tickMs: 120,
  setup: (ctx) => ({ snakes: spawnAll(ctx.players), food: placeFood(ctx) }),
  input(value) {
    if (!DIRECTIONS.includes(value.dir)) throw new Error("Send { dir }.");
    return { dir: value.dir as Direction };
  },
  action(value) {
    if (value.boost !== true) throw new Error("Send { boost: true }.");
    return { boost: true as const };
  },
  tick(G, ctx, inputs, _dt, actions) {
    for (const { playerId } of actions) if (G.snakes[playerId]) G.snakes[playerId].boostTicks = 5;
    for (const [id, snake] of Object.entries(G.snakes)) {
      if (inputs[id]) snake.dir = turn(snake.dir, inputs[id].dir);
      advance(G, snake, ctx);
    }
  },
  join: (G, ctx, playerId) => { G.snakes[playerId] = spawn(G, ctx); },
  leave: (G, _ctx, playerId) => { delete G.snakes[playerId]; },
  endIf: (G) => (alive(G).length === 1 ? { winners: alive(G) } : undefined),
});
```

- `setup` runs whenever a round starts: at the owner's `start` or `restart`, or
  when a drop-in room starts or restarts a round. `ctx.players` lists the seats and
  `ctx.connected` those with an open connection. `previous` is the finished round's
  game when there is one, so scores can carry over.
- `input` reads an input as the page sent it with `sendInput`, and returns it typed;
  throwing rejects it with the error message. It runs when the input arrives and
  again when `tick` reads it.
- `tick` runs every tick of a round, with or without input. `inputs` holds each
  player's latest input from the last five ticks, keyed by player ID, so state that
  must outlast an input, such as a heading, belongs in `G`.
- Something that happens once, such as firing or jumping, is an action: the page
  calls `sendAction(action)` once per press, `action` reads and checks it when it
  arrives, and `tick` sees it in `actions` exactly once, in arrival order, with the
  player's ID. Actions follow the same size limits as inputs and count toward the
  same message limit. A player may have at most eight
  (`REALTIME_ACTIONS_PER_TICK`) waiting for one tick. Rules without `action` take
  none, and the room refuses them, as it does outside a running round. A round
  start and a player leaving drop waiting actions. `sendAction` returns `false`
  without sending when no room is connected; the service reports a refused action
  through `onError`.
- `join` and `leave` run when a seat is taken or given up during a round, as in a
  drop-in room or when the owner removes a player. `endIf` runs after every tick.
- Every tick that changes the state sends each player what changed since the
  snapshot before (`snapshot.delta`): the paths that changed and their values.
  An array whose length changed, or whose item changes would be longer than it,
  goes whole. The page applies the changes to the snapshot they follow and asks
  for a whole one (`snapshot.request`) when it holds another, as after a missed
  tick; `onSnapshot` always gets whole snapshots. In a room whose rules the
  service runs, each tick also carries `acks`: for each seat in
  `state.players`, the `inputId` of the newest input that tick read, or -1.
- A page that passes those rules to `createMultiplayerClient` (as
  `{ rules }`, rules from `defineRealtimeGame` or a compiled realtime adapter)
  predicts its own player: each input it sends steps the rules at once with that
  input alone, and each snapshot restarts from the service's state and replays
  the inputs after the seat's ack. `client.snapshot` is that guess and
  `client.confirmed` the service's newest. Actions are not predicted, and rules
  with `playerView` are not predicted at all. Where the service read inputs
  differently, such as two arriving in one tick, the next snapshot corrects the
  guess. Prediction runs on the page and costs the service nothing. Rules with `playerView` get a
  whole snapshot each tick, since each seat's differs. `G` should hold game data
  only. Ticks raise no room event (`onEvent`); events report seats taken and
  given up, round starts and finishes. The page draws other players between snapshots,
  for example with `Smoother` (see [drawing between updates](#drawing-between-updates)).

In the page, `createMultiplayerClient<typeof rules>(game)` types `client.sendInput`
to what `input` returns and `client.sendAction` to what `action` returns. In a room
with an owner, a finished round waits for the owner's `restart`; drop-in rooms
start the next round on their own.

## Rules on a player's browser

The game service never runs code a game publishes. A deployment with
`adapterId: "host"` instead asks one player's browser, the room's host, to run
the game's rules from `defineGame` or `defineRealtimeGame`. Every page passes
them: `createMultiplayerClient(game, callbacks, { rules })`; without them the
client throws `not_configured`. Rules run in browsers, so they use neither Node
APIs nor the DOM.

- The service keeps the room: seats, connections, the owner, the phase, the
  sequence, command deduplication, turn deadlines, drop-in rounds, reconnection
  and the saved state. Only closing the room needs no rules.
- The host is the owner while connected, otherwise the first connected seat;
  `snapshot.state.hostPlayerId` names it, and `client.hosting` and `onHost(active)`
  tell the page. A host that drops, leaves or does not answer within five seconds
  (`HOST_REPLY_MS`) hands over to the next connected player, who receives the
  room's state and continues; a request the old host never answered goes to the
  new one.
- Turn-based rooms send the host each change as a request (`host.request`: a
  command, a join or leave during a round, a round start, a turn timeout) with the
  room's state; the host answers with the new state (`host.reply`). Commands are
  applied one at a time, in the order they arrived.
- Realtime rooms run no tick on the service. The host's browser steps the rules at
  their `tickMs`, with the inputs and actions the service forwards to it
  (`host.input`, `host.action`), and sends each changed state (`host.state`). It
  hears of changes it did not make, such as a seat taken, through `host.sync`.
  Rejected inputs and actions reach their player through the host as `onError`.
- During a round the host's own inputs and actions go straight to its loop, and
  its page shows each tick at once; snapshots the service sends back for that
  round are not shown again.
- Other players' inputs and actions wait for the service, about two trips: to the
  host and back.
- The loop's timer runs in a Web Worker, which browsers do not slow down in a
  hidden tab or a covered window. When a worker is not available it uses the
  page's timer and makes up at most five missed ticks per wake-up, so a hidden
  host's game still slows down.
- From each answer the service takes the game, positions, whose turn it is, the
  deadline, the phase and winners among the seats (`mergeHostState`). It keeps its
  own seats, names, connections and owner, never lets the host close the room, and
  keeps any phase it set itself meanwhile. Messages from the host hold at most
  128 KB (`HOST_MESSAGE_MAX_BYTES`).
- With `playerView`, the host sends each seat's view, and the service sends every
  player only theirs. The host itself sees everything.

The host can cheat and sees hidden information, so these rules suit casual
play. Their results never reach a match leaderboard; built-in rules, which the
service runs, rank players on `match.wins` (see
[cloud saves and leaderboards](cloud-saves.md)). A self-hosted service may still
register a game's rules as a server adapter, as `ohmygame-server dev` does; then
the service runs them and players need not pass them.

### Lockstep

A realtime deployment with `adapterId: "lockstep"` runs the rules in every
player's browser instead of one host's. Local playtests use it for realtime rules
from `defineRealtimeGame` without `playerView`; turn-based rules, and rules with
`playerView`, still use a host. Every page runs ahead of the frames it has, so each
player sees their own input at their next tick, however far the service is, and
nobody's background tab slows the others. What a page cannot foresee is another
player's new input, which shows a round trip late and moves their part of the game
when it arrives.

- The deployment names the rules' `tickMs`, since the service never loads them;
  only lockstep deployments have one. The page checks it against its rules and
  throws `invalid_option` when they differ.
- The service keeps the room as for a host, and keeps no game while a round plays.
  Every tick it sends a frame (`lockstep.frame`): its number, each player's input
  the rules read, actions in arrival order, and seat changes since the last frame
  (join, leave, connected), which pages apply before the tick. Late input goes
  into the next frame; the service never waits for a player.
- A round starts with `lockstep.sync`: the room's state with a random `seed`, the
  start time and the last round's game, for `setup(ctx, previous)`. With the seed in
  the state, `ctx.random()` draws a fixed sequence (mulberry32), and `ctx.now()` is
  the start time plus the frame number times `tickMs`, so every page reaches the
  same state. Rules must not use `Math.random`, `Date.now` or anything else
  outside `G`, `ctx`, the inputs and the actions, and should avoid functions such
  as `Math.sin` whose last digits differ between browsers.
- The first connected seat reports a checkpoint every two seconds
  (`lockstep.checkpoint`). A player who arrives or reconnects during a round gets
  the latest checkpoint and every frame since, and runs on from there.
- The page whose rules end the round reports the final state
  (`lockstep.finish`); the first report decides the winners, which the service
  takes among the seats as from a host, and the next round's setup gets its game.
- Pages run ahead (rollback). A page measures its round trip (`ping`,
  answered with `pong`) and tells from when frames arrive which frame the
  service is at. It shows the rules stepped from the newest frame to the frame an
  input sent now would reach the service in, with its own inputs and everyone
  else's last input, at most one second ahead, and redraws when that frame moves
  on. It sends each input as `lockstep.input` for the frame after the one it
  shows; the service counts it in that frame, or in the next one when it arrives
  late, and names it in the frame's `acks`. The service also passes each input on
  to everyone else as soon as it arrives (`lockstep.early`, with the frame it will
  count in), so pages guess ahead with other players' real inputs instead of
  waiting for the frame; what a page cannot know is only what has not reached it
  yet, about a round trip. Each frame that arrives replaces the guess. A page's
  own actions are guessed in the frame its inputs would count in, until a frame
  carries them; one no frame carries within a second was refused and is dropped
  from the guess. Other players' actions and seat changes are not guessed: they
  show when their frame arrives.
- `client.snapshot` and `onSnapshot` give the guess. `client.confirmed` gives the
  newest frame's state, which trails it by about a round trip and is never
  corrected. A game that draws other players from `client.confirmed` and its own
  player from the guess shows nobody jumping, at the cost of other players
  appearing a little behind where they are.
- Pages check inputs and actions with the rules before sending, so `onError`
  still explains a refusal. Results never reach a match leaderboard.

Not yet: pages do not compare their states, so a page whose rules drift from the
others stays wrong until the next round or a reconnection, and the service
believes the first report and the latest checkpoint it gets.

### Owner rooms

A realtime deployment with `adapterId: "owner"` and a `tickMs` has no rules for
the service or the pages to share: each page runs its own player, as in a
single-player game, and the service passes things on. A player's own actions
never wait for the network, other players never jump back, and a collision that
hurts a player is decided on that player's screen. Screens may differ slightly,
and a page can lie about its own player, so owner rooms suit casual and co-op
play; use lockstep where every screen must agree.

- `client.setState(state)` sets the local player's public state, a plain object
  of at most 4096 characters of JSON (`OWNER_STATE_MAX_LENGTH`). It shows at
  once, and goes out at most once a tick with only the top-level keys that
  changed (`owner.state`), timed from when frames arrive and the round trip to
  reach the service just before its tick. Every tick the service sends everyone the states that
  changed since the last one, together, and who left (`owner.frame`). Each change
  carries `seq`, the state's version on its page (every `setState` counts one); frames
  and `owner.sync` pass the newest on, so a page that also gets states straight from
  other pages keeps whichever is newer.
- `snapshot.state.game` is `{ players, shared }`: every player's state by
  playerId, the local one as just set, and the shared data.
- `client.updateShared(changes)` changes shared data (`owner.shared`). Each change
  sets or removes one key and may require the key to hold `expect` (JSON
  equality) or to be absent (`expectAbsent`); the service applies a request's
  changes together or not at all, one request at a time, tells everyone
  (`owner.shared`), then answers the requester (`owner.shared.result`), so the
  promise resolves whether it worked. Up to 256 keys of up to 1024 characters.
- `client.emit(message)` passes a message to every other page at once, which
  gets it through `onMessage(from, message)`. It goes out as `owner.emit`
  `{ id, message }` and arrives as `owner.message` `{ from, id, message }`; the ID is
  unique on the sending page, so a copy that also came straight from it is dropped.
- `p2p.signal` `{ to, data }` carries connection setup from one page to another
  player in the same room, who gets `{ from, data }`; the service passes it on
  unread, at most `P2P_SIGNAL_MAX_LENGTH` (8192) characters of JSON.
- `client.finishRound(winners)` ends the round; the first page to say so decides,
  among the seats. Each round starts with no states and no shared data; a page
  that arrives or reconnects during one gets them all (`owner.sync`).
- Results never reach a match leaderboard.

## Drawing between updates

Other players' positions reach a page at most once a tick: in realtime
snapshots, lockstep's `client.confirmed`, and owner rooms' player states.
`Smoother` from `@ohmygame/sdk/multiplayer` keeps each key's recent updates and
gives the value to draw at the current time; it runs on the page only.
`client.tickMs` is the room's tick, which a `Smoother` takes as `intervalMs`.

| Mode | Draws | Cost |
| --- | --- | --- |
| `interpolate` (default) | `delayMs` in the past (one interval by default), between the two updates around it; when an update is late, along the last movement for at most `maxExtrapolateMs` | Others appear one interval later |
| `extrapolate` | Ahead of the newest update along its movement, at most `maxExtrapolateMs`, eased over `smoothMs` | Overshoots a player who stops or turns |
| `damped` | Eased toward the newest update over `smoothMs` | Trails moving players by about `smoothMs` |

`snapDistance` draws a larger jump, such as a respawn, at once. Fields listed in
`angles` are radians, eased the short way round. Only numeric fields are
smoothed, and `retain(keys)` forgets players who left.

## Drop-in rooms

`roomPolicy: "drop-in"` lets realtime players press Play without creating a
room. The manifest validator rejects it for turn-based games, where a latecomer
has no turn to take. Call `quickPlay({ displayName })` instead of `createRoom`:

- The service puts the player in the fullest open room with a free seat, and
  opens a new room only when every room is full. Simultaneous quick plays share
  the rooms they open rather than each opening one.
- The room has no owner, so `start`, `kick`, and `close` are rejected. A round
  starts once the rules' `players.min` seats are connected, accepts players
  while it runs, and restarts three seconds after it finishes. Phase `lobby`
  means waiting for players.
- A dropped player keeps their seat for `reconnectSeconds`; the seat counts as
  taken, so a full room stays full. When the window ends the seat frees. If
  fewer than `players.min` players remain, the round returns to `lobby`. Local
  drop-in deployments hold seats for 15 seconds; other local rooms for 120.
- Quick play only places a player on arrival, so players can still end up alone
  in separate rooms, for example when one returns to a held seat in their old
  room. A player who stays alone for `mergeCheckMs` (5 seconds by default) moves
  to the busiest open room that has other players and a free seat. Checks are
  jittered; if two lonely players move at once, quick play's creation lock
  still puts them in one room. The move does not report a closed connection,
  but `onReady` gives the player a new `playerId` in the new room. A closed room
  locks at once, so neither quick play nor a moving player is sent to it.
- Every player receives the room's invite code. `joinRoom({ roomCode })` joins
  that room or fails when it is full; it never moves a friend to another room.
- When the service has reached `maxRooms`, matchmaking fails with code
  `MULTIPLAYER_ROOM_LIMIT_CODE` (503). `quickPlay` retries after one and then two
  seconds, then rejects so the game can show the error and a retry button.

Rules place a joining seat with `onPlayerJoin` and set up a round with
`onRoundStart`, which also runs at an owner's `start` and `restart`. Arena uses both to spawn every player 35 units from the centre
goal, spread around the ring. Matchmaking and its room creation lock are
per-process; running more than one service instance needs a shared Colyseus
presence and driver.

## Client addresses

The service limits requests, guest sessions, invitation attempts and WebSocket
upgrades per client address. By default that is the connecting address, and
forwarding headers are ignored, so a client cannot name another address. Behind a
reverse proxy every connection comes from the proxy, so set `clientAddress` (in the
hosted entry, `MULTIPLAYER_CLIENT_IP_HEADER` or `MULTIPLAYER_TRUST_PROXY_HOPS`):

- `clientIpHeader`: a header the ingress overwrites with the connecting address,
  such as `x-real-ip` on Railway. Use it only when clients cannot reach the
  service around that ingress.
- `trustProxyHops`: how many trusted proxies append to `X-Forwarded-For`; the
  client is the address the outermost one saw.

Colyseus reads WebSocket clients' addresses from forwarding headers itself, so
the service rewrites them on every upgrade to the address it trusts
(`packages/server/src/client-address.ts`).

## Publishing

Local debug publishing permits loopback deployments, checks the live local
registration, and creates a temporary local snapshot. It does not upload to a
hosted service. Public publishing requires OhMyGame's game service: the production
one, `https://games.ohmygame.ai`, for a desktop that publishes to the production
cloud, or the one `OHMYGAME_GAME_SERVICE_URL` (or `MULTIPLAYER_PUBLISH_SERVER_URL`)
names, which also overrides the default.

A game set up with `multiplayer_setup` declares its local deployment. Public
publishing registers the same rooms with the game service, as the game's
publisher, once the game has its OhMyGame ID: `POST
/v1/games/:gameId/deployments` with `{ mode, adapterId, maxClients, roomPolicy,
reconnectSeconds }` and the publisher's OhMyGame access token. The service asks
the cloud API who owns the game (`cloudGameOwnerCheck`: `GET
{cloud}/v1/games/:gameId` with that token), names the deployment from its
settings, so publishing the same settings again finds the same deployment and a
change makes a new one, sets `authPolicy` to `guest-or-account`, and opens its
rooms at once. Registered deployments are kept with the rooms and return after a
restart; a game registers at most 50. The published manifest names the
registered deployment. The service takes registrations when created with
`registration`; the hosted entry enables it with `GAME_SERVICE_PUBLIC_URL` (its
own HTTPS origin) and `OHMYGAME_CLOUD_API_URL`. A deployment passed explicitly
in the publish request must instead already be registered and match exactly.
See [the multiplayer service guide](google-playground-multiplayer.md) for public
backend operation; public deployment is independent of local testing.

### Running OhMyGame's game service

`bun run start:multiplayer` (`packages/games/src/server.ts`) runs the hosted
service with the built-in rules. It and `bun run dev:multiplayer` read
`packages/server/.env` when it exists (copy `packages/server/.env.example`);
variables already set, such as Railway's, take precedence. Its settings:

| Variable | Purpose |
| --- | --- |
| `MULTIPLAYER_GUEST_SECRET` | Signs guest tokens; at least 32 random bytes. Required. |
| `MULTIPLAYER_DATABASE_PATH` | The SQLite file for rooms and registered deployments. Keep it on a persistent volume, or turn-based rooms and registrations are lost on redeploy. |
| `PORT` or `MULTIPLAYER_PORT`, `MULTIPLAYER_HOST`, `MULTIPLAYER_MAX_ROOMS`, `MULTIPLAYER_PUBLIC_ADDRESS` | Where it listens, its room limit, and Colyseus's public address. |
| `MULTIPLAYER_CLIENT_IP_HEADER` or `MULTIPLAYER_TRUST_PROXY_HOPS` | The real client behind the ingress; see [client addresses](#client-addresses). |
| `OHMYGAME_ACCOUNT_ISSUER` | The account service whose game tokens sign players in; must equal the cloud's `GAME_SIGN_IN_ISSUER` and the issuer OhMyGame writes into published games. Guests only without it. |
| `OHMYGAME_CLOUD_API_URL` | The cloud API, for which games are published and who owns them. |
| `GAME_SERVICE_PUBLIC_URL` | This service's HTTPS origin; with `OHMYGAME_CLOUD_API_URL`, publishers may register deployments. OhMyGame's `OHMYGAME_GAME_SERVICE_URL` must name the same origin. |
| `GAME_DATA_DATABASE_URL` | Postgres for cloud saves and leaderboards; requires `OHMYGAME_CLOUD_API_URL`. |
| `GAME_DATA_ADMIN_TOKEN` | Enables the operator route that deletes an account's data. |
| `MULTIPLAYER_DEPLOYMENTS_FILE` | Optional: deployments an operator lists by hand, as a JSON array. |

On Railway it is the `multiplayer` service; see
[deploying services from this repository](#deploying-services-from-this-repository).
Keep one replica, mount a volume at the directory of `MULTIPLAYER_DATABASE_PATH`,
and add a Postgres service for `GAME_DATA_DATABASE_URL`.

### Deploying services from this repository

Every service this repository deploys, such as the game service, follows one
layout, so another service is added the same way:

- It lives in its own package under `packages/`.
- The root `package.json` has `build:<service>` and `start:<service>` for it:
  `build:multiplayer` and `start:multiplayer` for the game service.
- On Railway the service uses this repository with the **root directory left at
  the repository root**, since the packages share code and one lockfile. Its
  variables name the two scripts for Railpack, and its settings hold the health
  check and the watch paths:

  | Setting | Game service |
  | --- | --- |
  | `RAILPACK_BUILD_CMD` (variable) | `bun run build:multiplayer` |
  | `RAILPACK_START_CMD` (variable) | `bun run start:multiplayer` |
  | Healthcheck path | `/healthz` |
  | Watch paths | `/packages/games/**`, `/packages/server/**`, `/packages/sdk/**`, `/package.json`, `/bun.lock` |

  Watch paths cover the service's package, the shared packages it uses, the root
  `package.json` and `bun.lock`, so a change elsewhere, such as to the desktop
  app, deploys nothing. Without the start command, Railway falls back to the root
  `start` script, which runs the desktop daemon and fails.
