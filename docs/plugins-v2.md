# Plugin format 2

Format 2 is the next plugin contract. It runs beside format 1 ([plugins.md](plugins.md)),
which the app's plugin screens, integrations and format 1 Godot projects
still use. The daemon side of format 2 is complete and tested; its screens
are not built yet, so people can't install or allow format 2 plugins from
the app.

## Files

- **Manifest:** `.ohmygame-plugin/plugin.json` in the package, checked by
  `src/shared/plugin-manifest.ts`. The JSON Schema is
  `schemas/plugin-2.json` (`bun run plugin:schema` rebuilds it). Ids are
  `publisher/name`; `engines["ohmygame-api"]` must allow 2.0.0.
- **Project file:** `ohmygame.json` at a project's root names its type and the
  exact plugin versions it uses (`src/shared/project-file.ts`). It asks for
  plugins; it never allows them.
- **App data,** under `<data>/plugin-store/`:
  - `index.json`: installed packages, with their tool schemas;
  - `grants.json`: install consent, the app switch per plugin, and what each
    project folder allows (by real path);
  - `configuration.json`: settings values, readable only by the person;
  - `packages/<publisher>/<name>/<version>/`: installed releases.
- **Project data,** in the project's storage folder: `plugin-changes.json`
  (changes plugins made outside a turn) and `plugin-storage/` (plugin pages'
  storage).
- **Bundled:** `plugins-v2/` ships with the app and is indexed in place;
  `packages/plugin-ui/` is `@ohmygame/plugin-ui`.

## Native code

A native entry exports `activate(context)` (types in
`src/shared/extension-host-protocol.ts`). It runs in an extension host, a
Node child process per project (`src/daemon/extension-hosts.ts`), never in
the daemon. `context.project.folder` is the project; each call gets
`signal`, `progress`, `turn` and `configuration`. Only tools, commands and
project type hooks the manifest declares can be registered.

## Modules

| Area | Code | Tests |
| --- | --- | --- |
| Manifest, index, `when` | `src/shared/plugin-manifest.ts`, `src/shared/plugin-when.ts`, `src/daemon/plugin-index.ts` | `test/plugin-manifest.test.ts` |
| Project file and decisions | `src/daemon/project-plugins.ts` | `test/project-plugins.test.ts` |
| Hosts and native calls | `src/daemon/extension-hosts.ts`, `src/daemon/extension-host-process.ts`, `src/daemon/native-plugins.ts` | `test/extension-hosts.test.ts`, `scripts/test-node-runtime.mjs` |
| Services, tools, commands, settings | `src/daemon/plugin-services.ts`, `src/daemon/plugin-values.ts` | `test/extension-hosts.test.ts`, `test/external-mcp.test.ts` |
| Project types and web builds | `src/daemon/project-types.ts`, `src/daemon/preview.ts` | `test/extension-hosts.test.ts`, `test/preview.test.ts` |
| Writes outside a turn | `src/daemon/plugin-writes.ts` | `test/checkpoints.test.ts` |
| Plugin pages | `src/daemon/plugin-ui-server.ts`, `src/shared/plugin-ui-protocol.ts`, `src/renderer/plugin-frame.tsx`, `src/daemon/plugin-page-storage.ts`, `packages/plugin-ui/` | `test/preview-static.test.ts` |
| Signed releases | `src/daemon/plugin-releases.ts` | `test/plugin-manifest.test.ts` |

## Routes

- Types: `GET /project-types`; `POST /projects` with `projectType` creates a
  typed project in an empty folder or adopts a folder that holds one.
- Tools reach every agent through the session's tool list and external MCP.
  Agents and commands both call them through `PluginServices.callTool`, which
  checks the input and the result against the manifest's schemas.
- Skills of a project's active plugins load in its agent sessions, both
  OhMyGame's agent and the coding agents, beside format 1 plugins' Skills.
- A typed project's preview follows the plugin version its `ohmygame.json`
  pins; the app updates what it recorded when that file changes and at
  startup.
- Commands and changes: `GET`/`POST /projects/:id/plugin-commands`,
  `GET /projects/:id/plugin-changes`,
  `POST /projects/:id/plugin-changes/:changeId/undo`.
- Pages: `GET /projects/:id/plugin-panels`,
  `GET`/`PUT /projects/:id/plugin-storage/:publisher/:name/:key`.
- Store: `GET /plugin-store/plugins`, `POST /plugin-store/releases`,
  `POST /plugin-store/:publisher/:name/consent`,
  `PUT /plugin-store/:publisher/:name/enabled`,
  `GET`/`PUT /plugin-store/:publisher/:name/configuration`,
  `DELETE /plugin-store/:publisher/:name/:version`,
  `PUT /projects/:id/plugins/:publisher/:name` (moves a project to another
  installed version, which is both an update and a rollback; `null` turns
  it off). A project without `ohmygame.json` gets one the first time a
  plugin is turned on, typed `general`, or its own core type.
- A project's Plugins sheet: `GET /projects/:id/plugins` lists the format 1
  plugins on for it (shown locked) and every installed format 2 plugin with
  the version the project uses, its status, what it asks for, and whether the
  person allowed that. Turning on one never allowed asks first, then posts
  the consent. The type's plugin stays on.
- Home: the composer's type menu lists the app's types, then plugins' types
  from `GET /project-types`, then enabled format 1 plugins that set up their
  own projects (`integration.createProject`, such as TapTap Maker), then a
  link to the plugins that add types (`#/plugins?adds=projectType`). The type
  picks the starting plugin; a format 1 plugin's own type keeps that plugin on
  and makes the app type it names first. The plugin menu beside the type
  takes any number of starting plugins, sent as mentions in the order chosen,
  and lists `GET /project-plugins`, the enabled format 2 plugins a new project
  can turn on for itself, except those that add project types: they are
  picked as the type, and a project of another type turns them on in its
  Plugins sheet. With starting plugins to pick, the menu leaves that list out
  while it is empty. Creating the project posts each one's consent, if still
  needed, and turns it on once the project exists.

Releases install only when they are signed by a key the app trusts for
their publisher (`AppOptions.pluginReleaseKeys`). The app ships with none
yet. A release's package is checked before it is indexed and may hold what
a folder install can, dotfiles such as a template's `.gitignore` included;
only `.ohmygame-plugin/` must sit at the package's top. Uninstalling a
release deletes its folder.

## Plugin pages

A panel's page is served by its own server on the port the desktop app
picks, never the daemon's. Its frame has only `allow-scripts`, so its origin
is opaque; it gets one end of a MessageChannel on its first load and talks
through `@ohmygame/plugin-ui`. The page's CSP allows no inline scripts, so
its script is a module file next to it. The desktop app keeps the frame
within its plugin version's files (`src/desktop/window.ts`); a page that
loads again is replaced by a new frame at the panel's URL.
