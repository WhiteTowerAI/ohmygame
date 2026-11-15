# Changelog

Changes to `@ohmygame/sdk` that games and their developers can notice. A
maintainer adds a section, `## [version] - YYYY-MM-DD`, when preparing a
release; publishing checks that the section for the package's version exists.
See [publishing the SDK](../../docs/maintaining.md#publishing-the-sdk).
Earlier versions, `0.0.0-stage` and `0.1.0` (published by mistake and
deprecated; it holds the same code as 0.0.1), are listed only on npm.

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
- Multiplayer rooms from `@ohmygame/sdk/multiplayer`: create, join by invite
  code, quick play, public rooms and reconnect, with commands, realtime inputs
  and actions.
- Custom rules with `defineGame` and `defineRealtimeGame` from
  `@ohmygame/sdk/game`, run in the room host's browser.
- Errors as `OhMyGameError` with a stable `code`.
  ([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879)
