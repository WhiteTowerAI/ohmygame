# Project panel

A panel beside the project, and a command in the project menu that opens it.

An [OhMyGame](https://github.com/WhiteTowerAI/ohmygame) plugin, `example/project-panel`.

## Develop

1. `npm install`
2. In OhMyGame, open **Plugins › Add plugin › This computer**, choose this
   folder and turn on **Develop**. The app reloads the plugin when a file
   changes, with what npm would publish.
3. `npm run check` checks the package the way OhMyGame does when it's added.

Translate `locales/zh-CN.json`; until then it repeats `locales/en.json`.

## Publish

The npm package is `@example/project-panel`: its scope is the plugin's publisher, so
OhMyGame only takes `example/project-panel` from it. Raise `version` in both
`package.json` and `.ohmygame-plugin/plugin.json` for each release.

- `npm run pack` makes the `.tgz` npm would publish and checks it.
- `.github/workflows/publish.yml` publishes a GitHub release with
  provenance. Add `repository` to `package.json`, then set this repository
  up as a [trusted publisher](https://docs.npmjs.com/trusted-publishers) of
  the package on npmjs.com.
- Add a license before publishing.
