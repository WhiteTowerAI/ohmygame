# @ohmygame/sdk — guide for coding agents

This guide is for an agent writing or changing a browser game that uses
`@ohmygame/sdk`. It says what to call, in what order, and what not to do. Type
signatures are in the package's `.d.ts` files; the repository's
[multiplayer](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/multiplayer.md),
[cloud saves](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/cloud-saves.md)
and [game sign-in](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/game-sign-in.md)
guides describe the service side.

## Rules that always apply

- Call `init()` once at startup. Every feature comes from the object it returns.
- `init()` reads `manifest.json` beside the page. OhMyGame writes that file when
  it sets up or publishes a game. **Never edit `multiplayer`, `account` or
  `cloud` in it by hand**: publishing replaces them and checks that the build and
  the registered deployment match. Ship `public/manifest.json` in the build output.
- Pass `allowLocalhost: true` to `init()` only in local playtests, never in a
  published build.
- The SDK runs in browsers (and WebViews). It does not run in Node, mini-program
  or native runtimes.
- Every error the SDK throws or reports is an `OhMyGameError`. Branch on
  `error.code` (see [errors](#errors)); messages are for people and may change.
- Rules code (`defineGame`, `defineRealtimeGame`) uses neither the DOM nor Node
  APIs, and never `Math.random` or `Date.now`: use `ctx.random()`, `ctx.shuffle()`
  and `ctx.now()`.

## Entries

| Import                           | Use it for                                            |
| -------------------------------- | ----------------------------------------------------- |
| `@ohmygame/sdk`                  | `init`, `auth`, `storage`, `leaderboard`, errors      |
| `@ohmygame/sdk/multiplayer`      | `createMultiplayerClient` and the room client         |
| `@ohmygame/sdk/game`             | `defineGame`, `defineRealtimeGame` for a game's rules |
| `@ohmygame/sdk/protocol`         | Manifest, snapshot and room types and limits          |
| `@ohmygame/sdk/cloud-protocol`   | Save and leaderboard limits and types                 |
| `@ohmygame/sdk/account-protocol` | Account settings and player types                     |
| `@ohmygame/sdk/rules`, `/host`   | Runtime internals; games do not import them           |

A single-player game imports only `@ohmygame/sdk`, so it carries no room client.

## Startup

```ts
import { init, isOhMyGameError } from "@ohmygame/sdk";

const game = await init(); // { auth, storage, leaderboard, multiplayer?, cloud? }
```

`init()` throws `not_configured` when `manifest.json` is missing or invalid. In
the sign-in popup window, `init()` never resolves: the window hands the result
back and closes, so do not start the game before `init()` resolves.

## Sign-in: `game.auth`

| Member       | Behaviour                                                               |
| ------------ | ----------------------------------------------------------------------- |
| `available`  | `true` in games published to OhMyGame; `false` in local builds          |
| `player`     | `{ id, name }` when signed in, else `undefined` (the player is a guest) |
| `signIn()`   | Opens OhMyGame sign-in (popup, or a redirect where popups are blocked)  |
| `getToken()` | The current game token, or `undefined` for a guest                      |

```ts
if (game.auth.available && !game.auth.player) {
  try {
    await game.auth.signIn();
  } catch (error) {
    if (!isOhMyGameError(error, "cancelled")) throw error;
  }
}
```

Call `signIn()` from a click handler so the popup is not blocked. It throws
`unsupported` in a local build. Players who do not sign in play as guests; that
is the default, and guests can use saves, leaderboards and rooms that allow them.

## Saves: `game.storage`

Every write lands in the browser first and then on the game service when the
manifest has `cloud`. Offline writes are sent later automatically.

| Call              | Notes                                                         |
| ----------------- | ------------------------------------------------------------- |
| `get<T>(key)`     | Service copy when reachable; an unsent local write wins       |
| `set(key, value)` | Plain JSON only                                               |
| `remove(key)`     |                                                               |
| `keys()`          |                                                               |
| `sync()`          | Sends offline writes now; the SDK also does this on reconnect |
| `cloud`           | `false` when saves stay in this browser                       |

Limits: keys are letters, digits, `.`, `-`, `_`; at most `SAVE_MAX_KEYS` (32)
keys per player and `SAVE_MAX_BYTES` (64 KB of JSON) per save. Beyond them
`set` rejects with `quota_exceeded`. Keep one save per concern (`"progress"`,
`"settings"`), not one key per item.

## Leaderboards: `game.leaderboard`

```ts
if (game.leaderboard.available) {
  const result = await game.leaderboard.submit("high-score", 1200); // { score, rank, public, improved, at }
  const top = await game.leaderboard.top("high-score", { limit: 10 });
  const me = await game.leaderboard.me("high-score");
}
```

- `available` is `false` without a game service; every call then rejects with
  `not_configured`.
- A board's order is fixed by its first score: `"desc"` (default, higher wins)
  or `"asc"` (lower wins, for times): `submit("speedrun", ms, { order: "asc" })`.
  Naming the other order later rejects with `conflict`.
- Only signed-in players appear in `top()`. A guest's score is kept for them;
  `me()` returns `public: false` and the rank it would have.
- `submit` rejects with `rate_limited` after 10 scores a minute
  (`SCORE_SUBMITS_PER_MINUTE`). Submit at the end of a run, not every frame.
- Boards named `match.*` are written by the service; games cannot submit to them.

## Multiplayer

### Pick a mode

The manifest's `multiplayer.adapterId` decides who runs the rules. OhMyGame's
`multiplayer_setup` tool writes it; the game code must match it.

| `adapterId`                         | Who runs the game                           | Use for                                                   | Pass `rules`? |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------------- | ------------- |
| `gomoku`, `stones`, `arena`, `roam` | The service (built-in rules)                | Those exact games; results rank on `match.wins`           | No            |
| `host`                              | One player's browser, the room host         | Turn-based games, hidden information (`playerView`)       | Yes           |
| `lockstep`                          | Every browser, the same deterministic rules | Realtime games where every screen must agree              | Yes           |
| `owner`                             | Each page runs its own player               | Casual or co-op realtime games, physics, low-latency feel | No            |

`mode` is `"turn-based"` or `"realtime"`. `roomPolicy` is `"invite-or-public"`,
`"public"`, `"invite-only"`, or `"drop-in"` (realtime only: no owner, players
join a running round with `quickPlay`). `lockstep` and `owner` deployments carry
a `tickMs` that must equal the rules' `tickMs`.

Only built-in rules count toward leaderboards. `host`, `lockstep` and `owner`
run in players' browsers, so a player can cheat; use them for casual play.

### Client lifecycle

```ts
import { init } from "@ohmygame/sdk";
import { createMultiplayerClient } from "@ohmygame/sdk/multiplayer";
import rules from "../server/rules"; // only for host and lockstep

const game = await init();
const client = createMultiplayerClient(
  game,
  {
    onStatus: (status) => {}, // idle | connecting | connected | reconnecting | closed | error
    onReady: (playerId, inviteCode) => {},
    onSnapshot: (snapshot) => render(snapshot),
    onCommandResult: (result) => {}, // { commandId, accepted, error? }
    onHost: (hosting) => {}, // host mode: this page started or stopped running the rules
    onMessage: (from, message) => {}, // owner mode: another page's emit()
    onError: (error) => showError(error),
  },
  { rules },
);

if (!(await client.reconnect())) await client.createRoom({ displayName });
```

| Call                                                                 | Notes                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `createRoom({ displayName })`                                        | Not in drop-in rooms                                               |
| `joinRoom({ roomCode })`                                             | Join by invite code; fails when full                               |
| `quickPlay({ displayName })`                                         | Drop-in only: fullest open room, or a new one; retries room limits |
| `reconnect()`                                                        | Back to the seat saved in this browser; `false` when there is none |
| `publicRooms()`                                                      | Open public rooms                                                  |
| `leave()`, `dispose()`                                               | Leave the room; dispose also stops the client for good             |
| `sendCommand(type, payload?)`                                        | `start`, `restart`, `close`, `kick` (owner only), or `action`      |
| `status`, `playerId`, `roomCode`, `snapshot`, `hosting`, `confirmed` | Current values                                                     |

Try `reconnect()` first on page load: one browser is one player across tabs
and refreshes. Starting: the room owner sends `client.sendCommand("start")` once
`players.min` players are connected; after a match ends, `sendCommand("restart")`.
Drop-in rooms start and restart on their own.

### Snapshot

```ts
snapshot.state = {
  phase: "lobby" | "playing" | "finished" | "closed",
  ownerId, currentPlayerId, turnDeadline,
  winnerPlayerId, winnerPlayerIds,     // empty winners after a finish means a draw
  players: [{ playerId, displayName, connected, x, y }],
  hostPlayerId?,                       // host mode
  game?,                               // the rules' G, or that player's playerView
};
```

Render from `snapshot.state`; never keep a second copy of the game state that
the page changes itself (owner mode's `setState` is the exception).

### Turn-based rules (`host`)

```ts
// server/rules.ts
import { defineGame } from "@ohmygame/sdk/game";

export default defineGame({
  players: { min: 2, max: 4 },
  setup: (ctx, previous) => ({ remaining: 21, scores: previous?.scores ?? {} }),
  moves: {
    take: (G, ctx, { count }: { count: number }) => {
      if (count < 1 || count > 3) throw new Error("Take 1 to 3."); // message reaches the player
      G.remaining -= count;
    },
  },
  endIf: (G, ctx) =>
    G.remaining <= 0 ? { winners: [ctx.currentPlayer] } : undefined,
  turnSeconds: 60,
});
```

On the page: `client.moves.take({ count: 2 })`, typed from the rules. A move
passes the turn unless it calls `ctx.setCurrentPlayer`. Move options
`by: "owner" | "any"` allow moves outside the current player's turn. Add
`playerView(G, ctx, playerId)` to hide information such as hands; the service
then sends each player only their view.

### Realtime rules (`host` or `lockstep`)

```ts
import { defineRealtimeGame } from "@ohmygame/sdk/game";

export default defineRealtimeGame({
  players: { min: 1, max: 8 },
  tickMs: 100, // 20 to 1000; must match the manifest
  setup: (ctx) => ({
    snakes: Object.fromEntries(ctx.players.map((id) => [id, spawn(ctx)])),
  }),
  input: (value) => ({ dir: parseDir(value.dir) }), // throw to reject
  action: (value) => ({ boost: value.boost === true }),
  join: (G, ctx, playerId) => {
    G.snakes[playerId] = spawn(ctx);
  }, // seats taken mid-round
  leave: (G, ctx, playerId) => {
    delete G.snakes[playerId];
  },
  tick: (G, ctx, inputs, dt, actions) => {
    /* advance by dt seconds */
  },
  endIf: (G, ctx) => undefined,
});
```

- `client.sendInput(input)`: what the player holds now. Safe to call every
  frame; the SDK sends the latest at most once a tick. A player who stops
  sending drops out of `inputs` after five ticks, so keep anything lasting (a
  heading) in `G`.
- `client.sendAction(action)`: something done once (fire, jump). Call once per
  press. Returns `false` when no room is connected; actions are never queued.
- Inputs and actions are plain JSON of at most 512 characters, without the key
  `inputId`. Too many messages close the connection (code 4002).

**Lockstep determinism.** Every page runs the same rules from the same seed and
must reach the same state:

- Use only `G`, `ctx`, `inputs`, `actions` and `dt`. No `Math.random`,
  `Date.now`, `performance.now`, DOM, or module-level mutable state.
- Avoid `Math.sin`, `Math.cos`, `Math.exp` and similar, whose last digits differ
  between browsers; prefer integers and grid positions.
- Iterate in a fixed order (`ctx.players`), not over object keys built in
  arrival order from outside the rules.

**Lockstep display.** The page runs ahead of the service so the player's own
input shows at once. `client.snapshot` is that guess, and other players in it
may jump when a frame corrects it. `client.confirmed` is the newest frame from
the service, a round trip behind but never corrected. To avoid jumps, draw the
local player from `client.snapshot` and other players from `client.confirmed`.
Collisions between players are then decided slightly later than they appear.

### Owner rooms (`owner`)

No shared rules. Each page simulates its own player like a single-player game.

```ts
client.setState({ x, y, dir }); // this player's public state, ≤ 4096 chars of JSON
const { players, shared } = client.snapshot.state.game; // players by playerId
const took = await client.updateShared([
  // all changes apply, or none
  { key: "food:3", expect: { x: 4, y: 7 } }, // remove only if it still holds this value
]);
client.emit({ hit: otherId }); // others receive it via onMessage
client.finishRound([winnerId]); // the first page to report decides
```

- Call `setState` whenever the player changes; only changed top-level keys are
  sent, at most once a tick. Split rarely-changing data into its own key.
- `updateShared` resolves `true` when applied, `false` when a condition failed,
  the round ended, or no answer came in 5 seconds. Use `expect` or
  `expectAbsent` for anything two players could take at once.
- Shared data: up to 256 keys, each value up to 1024 characters.
- Each page decides what happens to its own player (for example, its own death
  on a collision it sees). Screens may differ slightly.
- Every round starts with empty states and shared data; the round's first page
  seeds shared data (for example with `expectAbsent`).

## Errors

| Code                 | Typical cause and response                                              |
| -------------------- | ----------------------------------------------------------------------- |
| `not_configured`     | No `manifest.json`, or no `multiplayer`/`cloud` in it                   |
| `invalid_option`     | Bad argument, input too large, rules `tickMs` ≠ manifest `tickMs`       |
| `sign_in_required`   | Deployment is `account-required`; call `auth.signIn()`                  |
| `not_connected`      | Call made before the room is connected                                  |
| `busy`               | Another join is in progress, or 32 commands are pending                 |
| `unsupported`        | Not allowed by this room policy or build (for example `signIn` locally) |
| `timeout`, `offline` | Show a retry                                                            |
| `room_limit`         | Service full; retry later                                               |
| `request_failed`     | The service refused, such as an expired invite code                     |
| `quota_exceeded`     | Too many saves, or a save too large                                     |
| `rate_limited`       | Too many requests; wait a minute                                        |
| `conflict`           | Data changed meanwhile, or leaderboard order mismatch                   |
| `connection_closed`  | Room closed or connection dropped; offer to rejoin                      |
| `cancelled`          | The player closed sign-in, or a newer call replaced this one            |
| `invalid_response`   | The service answered something unexpected                               |

## Local and published

- **In OhMyGame**: `game_sdk_setup` adds saves and leaderboards and
  `multiplayer_setup` adds rooms; both write `manifest.json` for the local game
  service. Publishing rewrites it for the online service. Do not copy production
  URLs into it to "test online"; publish instead.
- **Outside OhMyGame**: run the open-source service from this repository's
  `packages/server` yourself (`ohmygame-server dev <game-directory>`, or
  `createMultiplayerServer` in your own code) and write `manifest.json` for it. OhMyGame accounts and OhMyGame's hosted
  service are available only to games published on OhMyGame.

## Checklist before finishing a change

- [ ] `init()` runs once, before anything else, and its errors are shown.
- [ ] `manifest.json` is copied to the build output and was not edited by hand.
- [ ] Rules use `ctx.random`/`ctx.now` and, for lockstep, are deterministic.
- [ ] The page passes `rules` for `host` and `lockstep`, not for built-in or `owner`.
- [ ] `sendInput` is called every frame while input is held; `sendAction` once per press.
- [ ] The page handles `onError`, `connection_closed`, and tries `reconnect()` on load.
- [ ] Scores are submitted at the end of a run, not every frame.
