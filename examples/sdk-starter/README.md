# OhMyGame SDK starter

A minimal browser game that uses the published `@ohmygame/sdk` package. It
initializes the SDK and saves a counter in the browser.

## Run it

```sh
npm install
npm run dev
```

Build the production files with:

```sh
npm run build
```

`public/manifest.json` is copied into the build output. The empty object makes
this a local-only starter: `game.storage` uses browser storage, while account
sign-in, cloud saves, leaderboards, and multiplayer require a manifest written
by OhMyGame during setup or publishing. Do not hand-author their production
configuration.

For the full SDK rules and feature guides, read
[`AGENT_GUIDE.md`](https://github.com/WhiteTowerAI/ohmygame/blob/main/packages/sdk/AGENT_GUIDE.md), then the linked
multiplayer, cloud saves, and sign-in documentation.
