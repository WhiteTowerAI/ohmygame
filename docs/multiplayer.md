# Multiplayer game integration

OhMyGame browser multiplayer uses Colyseus rooms over WebSocket. The service
owns game rules, player membership, turn order, state, and command validation.
PeerJS and WebRTC are not part of this integration.

## Local playtests

The game agent calls `multiplayer_setup` with `adapterId: "gomoku"`, `"stones"`,
`"arena"`, or `"roam"`, and optionally `maxClients` for the room size. Local rooms
hold 2 to 8 players, narrowed to the seats the rules support: gomoku is always 2,
and the others default to 4. The realtime rules also accept `dropIn`, which roam
turns on by default; see [Drop-in rooms](#drop-in-rooms). Each room size and
policy is its own deployment, such as `local-arena-8p-v1` or
`local-roam-4p-dropin-v1`. The daemon starts one shared Colyseus service on a free loopback
port and registers the project's local deployment. This needs no cloud account,
public backend, signaling server, STUN, or TURN.

Setup writes these files under the configured startup directory:

| File                                      | Purpose                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `src/ohmygame/client.js` and declarations | Bundled browser SDK; no game package dependency is required                    |
| `src/ohmygame/README.md`                  | API, identity, room, command, and adapter instructions                         |
| `public/manifest.json`                    | Runtime deployment configuration copied by Vite into the build                 |
| `multiplayer.json`                        | Source declaration used to detect a build that dropped or changed the manifest |

The game must integrate the SDK; setup does not rewrite gameplay. Load
`./manifest.json` relative to the page directory and construct `MultiplayerClient`
with its `multiplayer` configuration. Explicitly enable `allowLocalhost` for local
testing. The guest identity and room recovery both live in `localStorage`, so a
browser is one player in every tab, and can return to its seat after the tab
closes. A second tab is the same player and cannot take a second seat in a room.
Games must keep this default rather than pass per-tab storage to mint extra
players. Test another player in a private window or a different browser.

Use `createRoom`, `joinRoom({ roomCode })`, and `reconnect`. Room invitation codes
contain 16 hexadecimal characters. Render `onSnapshot` data and handle
`onReady`, `onStatus`, `onCommandResult`, and `onError`. Commands submit intent,
not a client-computed board or winner. Stalled connections fail after 15 seconds;
HTTP requests have their own 10-second timeout. The game must display the error
and allow retry instead of keeping an indefinite connection spinner.

Test two independent players creating and joining a room, an accepted command,
an illegal command, a refresh/reconnect, and an unavailable service. The local
backend listens only on loopback: another device cannot access it through
`127.0.0.1`. Rooms are temporary and end when the daemon stops. Run setup again
after a daemon restart to update the service URL.

For a game that already has the generated files, a repository developer can
also run a separate backend with a fixed local URL in both manifests:

```sh
bun run multiplayer:local /absolute/path/to/game-workspace
```

This command reads `multiplayer.json`, listens on its loopback HTTP port, and
keeps rooms in memory until stopped. Serve the game's normal preview or static
build separately. Its guest identities also expire when the process stops;
clear that game's session storage before a new standalone test session.

## Game rules

The registered `adapterId` is immutable for a deployment. Omitting it preserves
the existing reference defaults: `stones` for turn-based games and `arena` for
realtime games. Unknown adapters fail service startup, rather than falling back
to a different game.

Each adapter declares the seats its rules support as `players: { min, max }`.
The service rejects a deployment whose `maxClients` falls outside that range, and
the room refuses `start` until at least `min` players are connected. The rules
adapter does not repeat these checks. Stones and arena accept 2 to 32 players,
the protocol's limit; roam starts with one.

`arena` is a race: the first player to reach the centre wins, and in a drop-in
room everyone respawns on a ring around it for the next round. `roam` has no goal
and never ends. Players spawn near the centre of the same 100 × 100 world, walk
at 12 units a second, stop at its edges, and keep their position until they
leave. It suits shared towns, lobbies, and exploration. The service knows nothing
of a game's map, so buildings and obstacles cannot block movement, and
interactions with them are not shared between players.

Realtime games call `sendInput(x, y)` every frame while input is held, with each
axis from -1 to 1, and `sendInput(0, 0)` on release. The SDK sends the latest
input at most once per 50 ms service tick and keeps resending it while the game
keeps calling, because the service discards an input older than 250 ms. A
connection that sends more than 40 messages a second is closed with code 4002;
the room releases its seat immediately rather than holding it for reconnection,
so the client reports the closed connection instead of a frozen game.

`gomoku` requires turn-based mode and declares exactly two seats. Black is
`state.players[0]`; the service selects `currentPlayerId`. Its `state.game` holds
a flat 15 × 15 board, move history, winning line, and black/white scores. Use
`isGomokuState` to validate it. The owner sends `start` after both players join;
players send `action` with `{ action: "move", point: { r, c } }`. The service
rejects out-of-turn, out-of-bounds, occupied, and extra-field moves, calculates
five-in-a-row and draws, and preserves scores across the owner's
`{ action: "reset" }`. A turn timeout skips the player without placing a stone.

`createMultiplayerServer({ adapters })` can accept additional trusted rules
adapters keyed by ID. Adapters use the common room state envelope, keep custom
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
