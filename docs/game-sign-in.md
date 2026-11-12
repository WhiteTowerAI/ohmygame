# Game sign-in

Games published to OhMyGame can sign players in with their OhMyGame account. The game
never receives the player's OhMyGame session: the account service issues a short-lived
**game token** that names the player and is valid for that one game. Game services, such
as the multiplayer service, accept the token in place of a guest.

This document is the contract between three parties:

- the browser SDK in a game (`packages/sdk/src/account.ts`, `game.auth`);
- the OhMyGame account service in `ohmygame-cloud` (its `docs/game-sign-in.md`), which
  signs players in and issues tokens;
- game services that verify tokens (`packages/server/src/auth.ts`), for rooms and for
  [cloud saves and leaderboards](cloud-saves.md).

Until the account service is deployed with game sign-in configured,
`game.auth.signIn()` in a published game fails when the sign-in page cannot be
reached, and players stay guests.

## Configuration

Public publishing writes the account service to the game's `manifest.json`:

```json
{ "account": { "issuer": "https://api.ohmygame.example" } }
```

| Field         | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `issuer`      | The account service's HTTPS base URL. The endpoints below are relative to it.                 |
| `hostOrigins` | Optional. Pages that may embed the game and hand it the player. Defaults to `issuer`'s origin. |

The desktop app takes the issuer from `OHMYGAME_ACCOUNT_ISSUER`, or else the cloud API
URL it publishes to, and writes it only when that URL uses HTTPS. Locally, the manifest
names OhMyGame's local game service instead (`localAccounts` in `@ohmygame/server`,
`packages/server/src/local-accounts.ts`), which speaks this protocol with test
players: its sign-in page signs in anyone by name, the same name being the same
player in every browser, and its tokens are good for every local game. The desktop
app lets that page open from previews and playtests, and lets a playtest's page
navigate there and back when no popup opens. Public publishing replaces the local
entry with the real issuer, or removes it.

## Player and game identity

- The player's ID is their OhMyGame account ID (the Supabase user ID). It is the same in
  every game.
- A published game is identified by its OhMyGame game ID. Its pages are served from its
  own origin, `https://g-<gameId>.<play domain>/`, so the account service identifies the
  game from the `redirect_uri` of a sign-in request: no client ID is sent.
- A multiplayer deployment of a game published to OhMyGame uses that game ID as its
  `gameId`, so a token for one game is refused by another game's deployments.

## Game token

A JSON Web Token signed with ES256:

| Claim  | Value                                                         |
| ------ | ------------------------------------------------------------- |
| `iss`  | The issuer, exactly as configured, without a trailing slash   |
| `aud`  | `ohmygame:game:<gameId>` (`gameTokenAudience(gameId)`)          |
| `sub`  | The player's OhMyGame account ID                              |
| `name` | The player's display name                                     |
| `exp`  | At most 15 minutes after `iat`                                |
| `iat`  | Issue time                                                    |

The public keys are served as a JSON Web Key Set at `GET {issuer}/v1/game-auth/jwks.json`.
Game services cache them and verify signature, `iss`, `aud`, `exp`, and the algorithm.

## Endpoints

### `GET {issuer}/v1/game-auth/authorize`

The sign-in page, opened in a popup or, where popups are blocked, in place of the game's
page. Query parameters:

| Parameter               | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| `response_type`         | `code`                                                    |
| `redirect_uri`          | The game page's origin and path, without query or fragment |
| `code_challenge`        | Base64url SHA-256 of the code verifier (PKCE)             |
| `code_challenge_method` | `S256`                                                    |
| `state`                 | Opaque; returned unchanged                                |

The service rejects a `redirect_uri` that is not a published game's own page and never
redirects to it. Otherwise it sends the player to the account dashboard's
`/game-sign-in` page, which signs them in with their OhMyGame account if needed, shows
which game is asking and that the game will receive the player's name and ID, and asks
them to continue or cancel. It then redirects to
`redirect_uri?code=…&state=…`, or `redirect_uri?error=access_denied&state=…` when the
player declines. A code is single use and expires within a minute.

### `POST {issuer}/v1/game-auth/token`

A JSON body, answered with a session:

```json
{ "grant_type": "authorization_code", "code": "…", "code_verifier": "…", "redirect_uri": "…" }
{ "grant_type": "refresh_token", "refresh_token": "…" }
```

```json
{
  "access_token": "<game token>",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "…",
  "player": { "id": "<account ID>", "name": "Ada" }
}
```

Refresh tokens belong to one game, rotate on every use, and last 30 days. One used twice
ends every session of that sign-in; they also end when the account is deleted or the
game unpublished. An invalid, used, or expired grant
answers 400 or 401, which signs the player out in the game. The endpoint allows
cross-origin requests from published games' origins.

## In the browser

`init()` creates `game.auth`, which is also the default identity for game services:

- `signIn()` opens the authorize page in a popup named `ohmygame-sign-in` and resolves with
  the player. The popup returns to the game page, where `init()` hands the code to the
  game through `postMessage` (same origin only) and closes; `init()` never resolves in
  the popup, so the game does not start there. If a sign-in page cut the popup off from
  the game (`Cross-Origin-Opener-Policy`), the popup finishes signing in itself and the
  game finds the saved session when the popup closes. A game in a frame keeps its
  storage apart from its popup's (browsers partition a frame's storage by the page
  above it), so a popup that finds no sign-in of its own still hands `code` and `state`
  to its opener and closes; the opener checks the state and holds the verifier.
- When the popup is blocked, the page goes to sign-in and back. `init()` then exchanges
  the code, removes `code` and `state` from the address, and the player is signed in.
  A game in a frame, as on its website page, can't do that, since the sign-in page
  refuses to be framed: `signIn()` rejects with `cancelled`, and the player allows the
  popup and tries again.
- The session is kept in the game origin's `localStorage`. `getToken()` renews it 30
  seconds before it expires. Tabs of one browser renew one at a time (`navigator.locks`),
  and a tab that waited uses the session the other saved: two renewals with one refresh
  token would look like a stolen token to the account service, which then ends the
  sign-in.

### Embedding pages

An OhMyGame page that embeds a game and has the player signed in can hand the game a
session, so the player does not sign in again. The game posts
`{ "type": "ohmygame:account-request" }` to its parent, addressed to each of
`hostOrigins`. The host answers through the frame's `postMessage`:

```json
{ "type": "ohmygame:account", "session": { "access_token": "…", "expires_in": 900, "player": { "id": "…", "name": "…" } } }
```

The session has the same shape as the token endpoint's answer; `refresh_token` is
optional, and without it the game asks the host again when the token expires. The game
believes only an answer from its own parent window at one of `hostOrigins`. The host
obtains the session from the account service for the game it embeds.

The desktop app's renderer runs from `file://`, which a framed game sees as the origin
`null`, the same as any sandboxed page; it therefore cannot hand over sessions this way
yet.

### In the desktop app

Community games play in a frame of the desktop window that may open popups. The app
opens a popup in its own window only when it is the SDK's sign-in window
(`ohmygame-sign-in`) at `{issuer}/v1/game-auth/authorize`, with the same issuer the
daemon writes to manifests (`OHMYGAME_ACCOUNT_ISSUER`, or else the cloud API URL),
over HTTPS (`src/desktop/game-sign-in.ts`). That window is a plain sandboxed page, with
no preload and no app access; it may visit any HTTPS page on the way, such as an identity
provider, and back to the game's page, but opens no windows of its own. Any other
`http:` or `https:` popup from a game, or from that window, opens in the system browser,
like other links in the app.
