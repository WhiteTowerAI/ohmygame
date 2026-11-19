# @ohmygame/game-sdk

Browser SDK for games made with [OhMyGame](https://github.com/WhiteTowerAI/ohmygame):
OhMyGame account sign-in, cloud saves, leaderboards, and multiplayer rooms.

```sh
npm install @ohmygame/game-sdk
```

## What it does

- **Sign-in**: OhMyGame accounts, and a guest until the player signs in (`game.auth`)
- **Cloud saves**: kept in the browser first, synced to the game service (`game.storage`)
- **Leaderboards**: a best score per player and board, public for signed-in players (`game.leaderboard`)
- **Multiplayer rooms** (`@ohmygame/game-sdk/multiplayer`): invite codes, quick play and
  reconnect; built-in or custom rules (`@ohmygame/game-sdk/game`); room messages for
  emotes and chat (`emit`, not saved); smooth drawing of other players (`Smoother`)

## Usage

`init()` reads the game's `manifest.json` (beside the page by default), which
OhMyGame writes when it sets up or publishes a game. Every feature starts from what
it returns.

```ts
import { init, isOhMyGameError } from "@ohmygame/game-sdk";

const game = await init();

// Saves stay in this browser, and sync to the game service when the game has one.
await game.storage.set("progress", { level: 3 });

// Leaderboards need the game service.
if (game.leaderboard.available) await game.leaderboard.submit("high-score", 1200);

// Sign-in is available in games published to OhMyGame.
if (game.auth.available && !game.auth.player) await game.auth.signIn();
```

Multiplayer lives in its own entry, so a single-player game carries no room client:

```ts
import { init } from "@ohmygame/game-sdk";
import { createMultiplayerClient } from "@ohmygame/game-sdk/multiplayer";

const game = await init();
const client = createMultiplayerClient(game, {
  onSnapshot: (snapshot) => render(snapshot),
  onMessage: (from, message) => showEmote(from, message), // another player's emit()
  onError: (error) => showError(error),
});
await client.createRoom();

// A one-off message to the room's other players, in any kind of room.
client.emit({ emote: "wave" });
```

Pass `allowLocalhost: true` to `init()` only for local playtests, never in a
published game. Every SDK error is an `OhMyGameError` whose `code` stays stable
while messages may change.

## Entries

| Import                           | Contents                                               |
| -------------------------------- | ------------------------------------------------------ |
| `@ohmygame/game-sdk`                  | `init`, saves, leaderboards, sign-in, errors           |
| `@ohmygame/game-sdk/multiplayer`      | `createMultiplayerClient`, the room client, `Smoother` |
| `@ohmygame/game-sdk/game`             | `defineGame` and `defineRealtimeGame` for rules        |
| `@ohmygame/game-sdk/protocol`         | Multiplayer manifest and room protocol types           |
| `@ohmygame/game-sdk/account-protocol` | Account settings and player types                      |
| `@ohmygame/game-sdk/cloud-protocol`   | Save and leaderboard limits and types                  |
| `@ohmygame/game-sdk/rules`            | The rules runtime the game service runs                |
| `@ohmygame/game-sdk/host`             | Rules run in the room host's browser                   |
| `@ohmygame/game-sdk/testing`          | `simulateRoom`, to test a game's rules in memory       |

See the repository's [multiplayer](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/multiplayer.md),
[cloud saves](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/cloud-saves.md),
and [game sign-in](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/game-sign-in.md)
guides for details. Coding agents should read [AGENT_GUIDE.md](AGENT_GUIDE.md):
the rules, modes, limits and checklist for writing a game with this SDK.

## License

Apache-2.0
