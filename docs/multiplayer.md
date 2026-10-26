# Multiplayer game integration

OhMyGame browser multiplayer uses Colyseus rooms over WebSocket. The service
owns game rules, player membership, turn order, state, and command validation.
PeerJS and WebRTC are not part of this integration.

## Local playtests

The game agent calls `multiplayer_setup` with `adapterId: "gomoku"`, `"stones"`,
or `"arena"`. The daemon starts one shared Colyseus service on a free loopback
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
testing. Use `sessionStorage` for guest identity when testing two tabs as different
players. The default shared `localStorage` identity represents the same player
in every tab and intentionally cannot control two seats.

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

`gomoku` requires turn-based mode and exactly two seats. Black is
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
The service operator registers this code; browsers never upload executable
rules. Realtime adapters must supply a simulation `step` and currently receive
bounded two-axis inputs; other input formats need a protocol extension. Merely
declaring an adapter name or a multiplayer manifest is insufficient.

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
