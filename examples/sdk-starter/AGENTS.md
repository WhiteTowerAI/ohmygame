# OhMyGame SDK starter instructions

This is a browser-only starter that deliberately uses no cloud or multiplayer
deployment. Keep `public/manifest.json` as an empty object unless OhMyGame has
generated a deployment configuration for the game.

Before adding SDK features, read the SDK's
[`AGENT_GUIDE.md`](https://github.com/WhiteTowerAI/ohmygame/blob/main/packages/sdk/AGENT_GUIDE.md). It defines the supported
imports, error handling, rules for local testing, and the boundary between
browser code and trusted game rules.

Do not invent or hand-edit production `multiplayer`, `account`, or `cloud`
manifest settings. Use OhMyGame setup and publishing flows for those settings.
