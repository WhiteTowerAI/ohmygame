# Changelog

Changes to `@ohmygame/game-sdk` that games and their developers can notice. A
maintainer adds a section, `## [version] - YYYY-MM-DD`, when preparing a
release; publishing checks that the section for the package's version exists.
See [publishing the SDK](../../docs/maintaining.md#publishing-the-sdk).

## [0.0.1] - 2026-11-19

The first release of the browser SDK for OhMyGame games, published as
`@ohmygame/game-sdk`.

### Added

- `init()` reads the game's `manifest.json` and returns everything below;
  `allowLocalhost` lets a local playtest use OhMyGame's local game service.
- Sign-in with OhMyGame accounts in published games (`game.auth`); players are
  guests until they sign in. `game.auth.signOut()` signs the player out in
  every tab, and `game.auth.onAuthChange()` tells the game whenever the player
  signs in or out, here or in another tab, is renamed, or their session ends.
  Signing in brings the saves and scores the player made as a guest in that
  browser to their account; saves the account already has stay with the guest.
  Sign-in from a game in a frame, such as on its game page, completes through
  a popup, and a blocked popup reports `cancelled` asking to allow pop-ups.
- Saves kept in the browser and synced to the game service, including saves
  made offline (`game.storage`).
- Leaderboards on the game service (`game.leaderboard`).
- Multiplayer rooms from `@ohmygame/game-sdk/multiplayer`: create, join by
  invite code, quick play, public rooms and reconnect, with commands, realtime
  inputs and actions. Joining agrees on a protocol version with the service;
  when they share none, the error's code is `protocol_unsupported` and its
  message says which side to update. `createMultiplayerClient` fetches the
  player's token and connects early, so the first join is quick.
- Realtime rooms: a changed input, such as a key just pressed, goes out at
  once, and regular input reaches the service just before its tick. Passing
  the rules the service runs shows the player's own moves at once, before the
  tick. `Smoother` draws other players smoothly between updates, and
  `client.tickMs` tells how often they arrive.
- Lockstep rooms: realtime rules without `playerView` run in every player's
  browser from the same inputs, with no host. `client.confirmed` is the newest
  state the service confirmed, for drawing other players without jumps.
- Owner rooms, where each page runs its own player: `setState`,
  `updateShared`, `emit` and `onMessage`, and `finishRound`. The `p2p` option
  also sends states and messages straight between pages over WebRTC where a
  connection opens, and `client.peers` shows each connection; in a deployment
  that isn't an owner one, `p2p` is ignored with a warning.
- `emit` and `onMessage` in every kind of room, for emotes, quick phrases or
  ready checks, before a match starts too. Messages are not kept and never
  reach the rules; a player sends at most `ROOM_MESSAGES_PER_SECOND` (5) a
  second, past which `emit` throws `rate_limited`.
- Custom rules with `defineGame` and `defineRealtimeGame` from
  `@ohmygame/game-sdk/game`, run in the room host's browser; the host's own
  input reaches the rules directly, and its ticks keep running while its page
  is in a background tab.
- `simulateRoom` from `@ohmygame/game-sdk/testing` plays a game's own rules in
  memory, with a clock the test moves and seeded random numbers, to test moves,
  turns, results, timeouts, ticks and what each player sees.
- In OhMyGame's playtests, each page's multiplayer client shows the agent its
  player, connection and room, unless the game offers its own snapshot.
- Errors as `OhMyGameError` with a stable `code`.

([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879,
[#785](https://github.com/WhiteTowerAI/ohmygame/pull/785) by @xinyang6879,
[#796](https://github.com/WhiteTowerAI/ohmygame/pull/796) by @dogxii,
[#922](https://github.com/WhiteTowerAI/ohmygame/pull/922) by @xinyang6879,
[#923](https://github.com/WhiteTowerAI/ohmygame/pull/923) by @xinyang6879,
[#932](https://github.com/WhiteTowerAI/ohmygame/pull/932) by @xinyang6879,
[#936](https://github.com/WhiteTowerAI/ohmygame/pull/936) by @xinyang6879)
