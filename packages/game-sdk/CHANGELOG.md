# Changelog

Changes to `@ohmygame/game-sdk` that games and their developers can notice. A
maintainer adds a section, `## [version] - YYYY-MM-DD`, when preparing a
release; publishing checks that the section for the package's version exists.
See [publishing the SDK](../../docs/maintaining.md#publishing-the-sdk).
This package starts at `0.0.1` under the new package name.

## [0.0.3] - 2026-11-18

### Added

- `game.auth.signOut()` signs the player out of the game in every tab, and
  they play as a guest again; `game.auth.onAuthChange()` tells the game
  whenever the player signs in or out, here or in another tab, is renamed, or
  their session ends.
  ([#922](https://github.com/WhiteTowerAI/ohmygame/pull/922) by @xinyang6879)
- Signing in brings the saves and scores the player made as a guest in that
  browser to their account. Saves the account already has stay with the guest.
  ([#923](https://github.com/WhiteTowerAI/ohmygame/pull/923) by @xinyang6879)
- `emit` and `onMessage` work in every kind of room, for emotes, quick phrases
  or ready checks, before a match starts too. Messages are not kept and never
  reach the rules; a player may send at most `ROOM_MESSAGES_PER_SECOND` (5) a
  second, past which `emit` throws `rate_limited`.
  ([#785](https://github.com/WhiteTowerAI/ohmygame/pull/785) by @xinyang6879)
- `simulateRoom` from `@ohmygame/sdk/testing` plays a game's own rules in
  memory, with a clock the test moves and seeded random numbers, to test moves,
  turns, results, timeouts, ticks and what each player sees.
  ([#936](https://github.com/WhiteTowerAI/ohmygame/pull/936) by @xinyang6879)
- In OhMyGame's playtests, each page's multiplayer client shows the agent its
  player, connection and room, unless the game offers its own snapshot.
  ([#932](https://github.com/WhiteTowerAI/ohmygame/pull/932) by @xinyang6879)

### Changed

- Joining a room agrees on a protocol version with the service. When they share
  none, the error's code is `protocol_unsupported` and its message says which
  side to update.
- `p2p` in a deployment that isn't an owner one is ignored with a warning, and
  the game connects through the service, instead of failing to connect.
  ([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879)

### Fixed

- Sign-in from a game in a frame, such as on its game page, completes through
  the popup, and a blocked popup reports `cancelled` asking to allow pop-ups.
  ([#796](https://github.com/WhiteTowerAI/ohmygame/pull/796) by @dogxii)

## [0.0.2] - 2026-11-10

### Added

- Lockstep rooms: realtime rules without `playerView` run in every player's
  browser from the same inputs, with no host. `client.confirmed` is the newest
  state the service confirmed, for drawing other players without jumps.
- Owner rooms, where each page runs its own player: `setState`,
  `updateShared`, `emit` and `onMessage`, and `finishRound`. The `p2p` option
  also sends states and messages straight between pages over WebRTC where a
  connection opens, and `client.peers` shows each connection.
- `Smoother` draws other players smoothly between updates, and `client.tickMs`
  tells how often those updates arrive.
- Passing the rules the service runs to a realtime room shows the player's own
  moves at once, before the service's tick.
  ([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879)

### Changed

- A changed realtime input, such as a key just pressed, goes out at once, and
  regular input reaches the service just before its tick.
- The room host's own input reaches the rules directly, and its ticks keep
  running while its page is in a background tab.
- `createMultiplayerClient` fetches the player's token and connects to the
  service early, so the first join is quicker.
  ([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879)

## [0.0.1] - 2026-11-05

### Added

- The first release of the browser SDK for OhMyGame games. `init()` reads the
  game's `manifest.json` and returns everything below; `allowLocalhost` lets a
  local playtest use OhMyGame's local game service.
- Sign-in with OhMyGame accounts in published games (`game.auth`); players are
  guests until they sign in.
- Saves kept in the browser and synced to the game service, including saves
  made offline (`game.storage`).
- Leaderboards on the game service (`game.leaderboard`).
- Multiplayer rooms from `@ohmygame/game-sdk/multiplayer`: create, join by invite
  code, quick play, public rooms and reconnect, with commands, realtime inputs
  and actions.
- Custom rules with `defineGame` and `defineRealtimeGame` from
  `@ohmygame/game-sdk/game`, run in the room host's browser.
- Errors as `OhMyGameError` with a stable `code`.
  ([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879)
