# Multiplayer game integration

OhMyGame browser multiplayer uses Colyseus rooms over WebSocket. The service
owns game rules, player membership, turn order, state, and command validation.
PeerJS and WebRTC are not part of this integration.

## Local playtests

The game agent calls `multiplayer_setup` with `adapterId: "gomoku"`, `"stones"`,
`"arena"`, `"roam"`, or `"custom"`, and optionally `maxClients` for the room size.
`custom` loads the game's own turn-based rules from `server/rules.ts` beside
`multiplayer.json` (see [Writing rules with `defineGame`](#writing-rules-with-definegame));
the agent writes that file first, and calls setup again after changing it to
check that it loads. Local rooms hold 2 to 8 players, narrowed to the seats the
rules support: gomoku is always 2, and the others default to 4. The realtime rules also accept `dropIn`, which roam
turns on by default; see [Drop-in rooms](#drop-in-rooms). Each room size and
policy is its own deployment, such as `local-arena-8p-v1` or
`local-roam-4p-dropin-v1`. The daemon starts one shared Colyseus service on
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
| `src/ohmygame/client.js` and declarations | Bundled browser SDK; no game package dependency is required                    |
| `src/ohmygame/gomoku.js` and declarations | Gomoku board helpers, written only for `gomoku` games                          |
| `src/ohmygame/README.md`                  | API, identity, room, command, and adapter instructions                         |
| `public/manifest.json`                    | Runtime deployment configuration copied by Vite into the build                 |
| `multiplayer.json`                        | Source declaration used to detect a build that dropped or changed the manifest |

The game must integrate the SDK; setup does not rewrite gameplay. Start with
`await init({ allowLocalhost: true })`: it loads `./manifest.json` relative to
the page directory and validates its `multiplayer` configuration. Enable
`allowLocalhost` only for local testing. `createMultiplayerClient(callbacks)`
returns the player's `MultiplayerClient`. An account-required game passes an
`identity` with `getToken()` to `init`; without a token, a deployment that allows
guests joins as one. The guest identity and room recovery both live in `localStorage`, so a
browser is one player in every tab, and can return to its seat after the tab
closes. A second tab is the same player and cannot take a second seat in a room.
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
keeps rooms in memory until stopped. A game with its own turn-based rules keeps
them in `server/rules.ts` (or `.js`/`.mjs`), written with
[`defineGame`](#writing-rules-with-definegame) and exported as default, under an
`adapterId` of its own. The command bundles that file with what
it imports, so the rules can share code with the page and need no OhMyGame package
installed: `@ohmygame/server` and `@ohmygame/sdk` imports resolve to `defineGame`.
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
owner sends `{ action: "reset" }` for a new pile, which the first seat starts.

`arena` is a race: the first player to reach the centre wins, and in a drop-in
room everyone respawns on a ring around it for the next round. `roam` has no goal
and never ends. Players spawn near the centre of the same 100 × 100 world, walk
at 12 units a second, stop at its edges, and keep their position until they
leave. It suits shared towns, lobbies, and exploration. The service knows nothing
of a game's map, so buildings and obstacles cannot block movement, and
interactions with them are not shared between players.

Realtime games call `sendInput(input)` every frame while input is held. The input
is a plain object in the shape the rules read: `arena` and `roam` take
`{ x, y }`, each axis from -1 to 1, and `{ x: 0, y: 0 }` on release. Any input is
plain JSON of at most 512 characters (`REALTIME_INPUT_MAX_LENGTH`), nested no more
than four levels, and never uses the key `inputId`, which the SDK adds; otherwise
`sendInput` throws `invalid_option`. The SDK sends the latest input at most once per
service tick, which the service reports when the player joins, and keeps resending
it while the game keeps calling. The room passes the rules only inputs from the
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
five-in-a-row and draws, and preserves scores across the owner's
`{ action: "reset" }`. A turn timeout skips the player without placing a stone.

`createMultiplayerServer({ adapters })` can accept additional trusted rules
adapters keyed by ID. `MultiplayerGameAdapter` is experimental: turn-based rules
should use `defineGame`, and the adapter form may change before realtime rules
have one. A realtime adapter supplies `step(state, inputs, now, dt)`, which the
room calls on every tick of a round, with or without input, where `dt` is the
tick in seconds. It may set `tickMs` (a whole number from 20 to 1000, default 50)
and `validateInput(input)`, which throws to reject an input with that message;
`arena` and `roam` move at a fixed number of map units per second times `dt`. Adapters use the common room state envelope, keep custom
serializable state in `state.game`, and validate action payloads on the service.
Rules with hidden information, such as a hand of cards, implement
`viewFor(state, playerId)` to return what that seat may see; `playerId` is
undefined for a connection without a seat. The room sends every connection its
own snapshot as a message, and the HTTP snapshot route applies the same view, so
no shared room state carries another player's data. Without `viewFor`, every
player sees the whole state.
The service operator registers this code; browsers never upload executable
rules. Realtime adapters must supply a simulation `step` and currently receive
bounded two-axis inputs; other input formats need a protocol extension. Merely
declaring an adapter name or a multiplayer manifest is insufficient.

### Writing rules with `defineGame`

Turn-based rules can be plain functions instead of an adapter.
`defineGame` (from `@ohmygame/server`, or `@ohmygame/sdk/game` for types in the
page) takes `players`, `setup(ctx)` for the game at `start`, `moves`, and the
optional `endIf(G, ctx)`, `playerView(G, ctx, playerId)`, and `turnSeconds`
(default 60). `compileGame(rules)` returns the adapter to register:

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
`createMultiplayerClient<typeof rules>()` types `client.moves.play({ cards })`,
which sends `{ action: "play", cards }`. The built-in gomoku and stones rules are
written this way. `legalMoves` is reserved for bots and is not called yet.

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

Rules place a joining seat with `onPlayerJoin` and reset a round with
`onRoundStart`. Arena uses both to spawn every player 35 units from the centre
goal, spread around the ring. Matchmaking and its room creation lock are
per-process; running more than one service instance needs a shared Colyseus
presence and driver.

## Publishing

Local debug publishing permits loopback deployments, checks the live local
registration, and creates a temporary local snapshot. It does not upload to a
hosted service. Public publishing requires an HTTPS backend configured through
`MULTIPLAYER_PUBLISH_SERVER_URL` and an exactly matching registered deployment.
See [the multiplayer service guide](google-playground-multiplayer.md) for public
backend operation; public deployment is independent of local testing.

Publishing rejects a missing build manifest when `multiplayer.json` declares
multiplayer, mismatches between source/build/request configurations, and known
PeerJS dependencies or public PeerJS/CDN markers in the build. These checks
catch the observed default-stack regression; they do not infer every networking
implementation or prove that a game uses its declared rules. Verify gameplay
with two clients before delivery. Single-player games require no multiplayer
manifest or backend.
