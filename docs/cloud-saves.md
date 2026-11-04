# Cloud saves and leaderboards

Games keep a player's progress with `game.storage` and rank scores with
`game.leaderboard`, both from `init()` in the browser SDK
(`packages/sdk/src/cloud.ts`). The game service keeps them
(`packages/server/src/game-data-routes.ts`) behind a replaceable store.

## Where saves live

Every save lands in the browser's `localStorage` first. When the game's
`manifest.json` names a game service, saves also go there:

```json
{ "cloud": { "serverUrl": "https://games.ohmygame.example/", "gameId": "<OhMyGame game ID>" } }
```

- Publishing to OhMyGame writes `cloud` for builds that have a `manifest.json`,
  with the game's OhMyGame ID and the game service from `OHMYGAME_GAME_SERVICE_URL`
  (or `MULTIPLAYER_PUBLISH_SERVER_URL`), HTTPS only. Publishing creates or finds the
  game record before it builds, so the build can name it; a build that fails leaves
  the record unpublished, and the next attempt reuses it.
- Local previews and local publishing never write it: saves stay in the browser,
  `game.storage.cloud` is `false`, and `game.leaderboard.available` is `false`.

The browser keeps saves apart per player: the signed-in account, a custom
identity from `init({ identity })`, or the guest. A save made while the service
cannot be reached stays marked as unsent; the next read or write of it, a call to
`game.storage.sync()`, or the browser's `online` event sends it, and an unsent save
wins over the service's copy. A save the service refuses, for a quota, is removed
from the browser and rejects with the service's code. When a signed-in player reads
a key their account does not have, a save they made under it as a guest in this
browser moves into the account. Concurrent writes from two devices keep the last
one; the service's `ifVersion` lets a game refuse that, though `game.storage` does
not use it yet.

## Players

Requests carry a game token from [game sign-in](game-sign-in.md), which names one
game, or else a guest token from the same service's `POST /v1/guests`. A guest
renewing with their previous token, up to 30 days after it expired, stays the same
guest, so their saves and scores remain. Leaderboards show an account's ID
(`playerId`) and the display name from its game token.

## Routes

All routes take `Authorization: Bearer <token>` and answer errors as
`{ "error": "<message>", "code": "<code>" }`. Names of saves and leaderboards are 1
to 64 letters, digits, dots, dashes or underscores.

| Route                                                   | Answer                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /v1/games/:gameId/saves`                           | `[{ key, version, updatedAt, bytes }]`                            |
| `GET /v1/games/:gameId/saves/:key`                      | `{ key, value, version, updatedAt }`, or 404                      |
| `PUT /v1/games/:gameId/saves/:key` `{ value, ifVersion? }` | The saved record. `ifVersion: 0` writes only a new key.        |
| `DELETE /v1/games/:gameId/saves/:key`                   | 204                                                               |
| `POST /v1/games/:gameId/leaderboards/:board/scores` `{ score, order? }` | `{ score, at, rank, public, improved }`, the player's best |
| `GET /v1/games/:gameId/leaderboards/:board?limit&offset` | `[{ rank, playerId, name, score, at }]`, public entries only     |
| `GET /v1/games/:gameId/leaderboards/:board/me`          | `{ score, at, rank, public }`, or 404 before a first score        |
| `DELETE /v1/admin/accounts/:accountId`                  | 204. Needs the operator token; removes the account's data everywhere. |

A board keeps each player's best score, in the order of its first score:
`"desc"` (the default) ranks higher scores first and `"asc"` lower ones, such as
times. A later score may leave `order` out; naming the other order answers
`conflict`. Ties go to the earlier score. Only accounts appear on a public board.
A guest's score is kept for them only, with `public: false` and the rank it would
take among accounts.

Boards named `match.…` belong to the service: it counts results of rules it runs
itself, and a player's submission to one answers 403 `not_authorized`. When a match
of rules with a `matchBoard` finishes in a room of a service that keeps game data,
each winner's count on that board goes up by one, publicly for accounts and
privately for guests. The built-in gomoku, stones and arena rules count wins on
`match.wins`; roam has no winners. Rules a game runs itself, on its host's browser
(see [multiplayer](multiplayer.md)), cannot write to a match board, since their
results could be forged.

| Limit                                  | Value | Error            |
| -------------------------------------- | ----- | ---------------- |
| Saves per player in a game             | 32    | `quota_exceeded` |
| Size of a save's JSON                  | 64 KB | `quota_exceeded` |
| Scores per player in a game, a minute  | 10    | `rate_limited`   |
| Requests per player, a minute          | 120   | `rate_limited`   |

The SDK turns these into `OhMyGameError` codes of the same names, `conflict` for
a stale `ifVersion` or another order, and `offline` when the service cannot be
reached.

## Running the service

`createMultiplayerServer({ gameData })` mounts the routes:

- `store`: a `ServerStore`. `MemoryGameDataStore` keeps data in the process, for
  development. `PostgresGameDataStore` from `@ohmygame/server/postgres` takes a
  connection string or pool and creates or upgrades its tables when it starts;
  several instances may share one database.
- `allowGame(gameId)`: which games the service keeps data for, every game by
  default. `publishedGameCheck(cloudApiUrl)` allows the games OhMyGame has
  published, listed in Community or not (`GET /v1/published-games/:id` on the
  cloud API), and caches the answer.
- `guestRetentionDays` (30) and `accountRetentionDays` (365): data of a player who
  has not used a game for that long is removed, hourly.
- `adminToken`: enables the operator route. Call it when an OhMyGame account is
  deleted.

The hosted entry (`packages/games/src/server.ts`) enables cloud data when
`GAME_DATA_DATABASE_URL` is set, and then requires `OHMYGAME_CLOUD_API_URL` for the
published-game check; `GAME_DATA_ADMIN_TOKEN` sets the operator token.

Rate limits are counted in each process, by player. Behind a reverse proxy, or
with several instances, the proxy must also limit requests per client address;
the service sees only the proxy's address.

## Tests

`test/game-data.test.ts` runs the store contract against the memory store, and
against Postgres when `OHMYGAME_TEST_POSTGRES_URL` names a disposable database,
then the routes through a running service. `test/cloud-saves.test.ts` drives the
browser SDK against a running service: offline saves, guest renewal, sign-in
migration, a second device, quotas and leaderboards.
