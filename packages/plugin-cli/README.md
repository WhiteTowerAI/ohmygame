# @ohmygame/plugin-cli

Checks and packs [OhMyGame](https://github.com/WhiteTowerAI/ohmygame) plugins
with the app's own code, so a package that passes here is one the app will add.

```sh
npm install --save-dev @ohmygame/plugin-cli
npx ohmygame-plugin check
npx ohmygame-plugin pack
```

- `check [folder]` checks the files a release would include from the folder
  (what `package.json`'s `files` lists, as npm packs it): the manifest, its files, the npm name and version, and the panels' use of the
  page components.
- `pack [folder]` runs `npm pack`, checks the archive as adding it would, and
  keeps the `.tgz` only when it has no errors. `--pack-destination <folder>`
  chooses where it goes.

The manifest's JSON Schema ships as `@ohmygame/plugin-cli/plugin.schema.json`.
`ohmygame-plugin --version` prints the plugin API it checks for, which is also
the package's version.

Start a plugin with `npm create ohmygame-plugin`.
