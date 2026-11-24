# Project panel

A panel beside the project, and a command in the project menu that opens it.

An [OhMyGame](https://github.com/WhiteTowerAI/ohmygame) plugin, `example/project-panel`.

## Develop

1. `npm install`
2. In OhMyGame, open **Plugins › Add plugin › This computer**, choose this
   folder and turn on **Develop**. The app reloads the plugin when a file
   changes, with the files a release includes.
3. `npm run check` checks the package the way OhMyGame does when it's added.

Translate `locales/zh-CN.json`; until then it repeats `locales/en.json`.

## Publish

OhMyGame's market lists plugins released on GitHub, in a public repository
with the topic `ohmygame-plugin` owned by the user or organization whose
name, lowercased, is the publisher `example`. For each release:

1. Raise `version` in both `package.json` and
   `.ohmygame-plugin/plugin.json`.
2. Publish it from OhMyGame's Plugin Builder (**Publish to GitHub**), or push
   the tag `v<version>`: in a folder exported from OhMyGame,
   `.github/workflows/release.yml` packs the plugin and attaches it to the
   tag's release as a `.zip`, making the release if there isn't one.

Add a license before publishing.
