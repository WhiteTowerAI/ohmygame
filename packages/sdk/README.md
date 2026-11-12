# @ohmygame/sdk

Browser SDK for games made with [OhMyGame](https://github.com/WhiteTowerAI/ohmygame):
OhMyGame account sign-in, cloud saves, leaderboards, and multiplayer rooms.

```sh
npm install @ohmygame/sdk
```

## What it does

- **Sign-in**: OhMyGame accounts, and a guest until the player signs in (`game.auth`)
- **Cloud saves**: kept in the browser first, synced to the game service (`game.storage`)
- **Leaderboards**: a best score per player and board, public for signed-in players (`game.leaderboard`)
- **Multiplayer rooms** (`@ohmygame/sdk/multiplayer`): invite codes, quick play and
  reconnect; built-in or custom rules (`@ohmygame/sdk/game`); room messages for
  emotes and chat (`emit`); smooth drawing of other players (`Smoother`)

## Usage

`init()` reads the game's `manifest.json` (beside the page by default), which
OhMyGame writes when it sets up or publishes a game. Every feature starts from what
it returns.

```ts
import { init, isOhMyGameError } from "@ohmygame/sdk";

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
import { init } from "@ohmygame/sdk";
import { createMultiplayerClient } from "@ohmygame/sdk/multiplayer";

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
| `@ohmygame/sdk`                  | `init`, saves, leaderboards, sign-in, errors           |
| `@ohmygame/sdk/multiplayer`      | `createMultiplayerClient`, the room client, `Smoother` |
| `@ohmygame/sdk/game`             | `defineGame` and `defineRealtimeGame` for rules        |
| `@ohmygame/sdk/protocol`         | Multiplayer manifest and room protocol types           |
| `@ohmygame/sdk/account-protocol` | Account settings and player types                      |
| `@ohmygame/sdk/cloud-protocol`   | Save and leaderboard limits and types                  |
| `@ohmygame/sdk/rules`            | The rules runtime the game service runs                |
| `@ohmygame/sdk/host`             | Rules run in the room host's browser                   |

See the repository's [multiplayer](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/multiplayer.md),
[cloud saves](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/cloud-saves.md),
and [game sign-in](https://github.com/WhiteTowerAI/ohmygame/blob/main/docs/game-sign-in.md)
guides for details. Coding agents should read [AGENT_GUIDE.md](AGENT_GUIDE.md):
the rules, modes, limits and checklist for writing a game with this SDK.

## License

Apache-2.0
