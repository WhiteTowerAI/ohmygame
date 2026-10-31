# Plugin format 2

Format 2 is the next plugin contract. It runs beside format 1 ([plugins.md](plugins.md)),
which integrations, the Browse tab and format 1 Godot projects still use.
The app lists installed format 2 plugins on the Plugins page, turns them on
per project, and shows their panels and commands in a project. Installing a
signed release from the app is not built yet: no catalog or release keys
ship, so format 2 plugins come bundled or from a folder.

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
- **Bundled:** `plugins-v2/` ships with the app and is indexed in place by
  `PluginServices.ready()`, which every service method and route waits for;
  `packages/plugin-ui/` is `@ohmygame/plugin-ui`.

## Native code

A native entry exports `activate(context)` (types in
`src/shared/extension-host-protocol.ts`). It runs in an extension host, a
Node child process per project (`src/daemon/extension-hosts.ts`), never in
the daemon. `context.project.folder` is the project; each call gets
`signal`, `progress`, `turn` and `configuration`. Only tools, commands and
project type hooks the manifest declares can be registered.
`progress(message, { url })` carries an https link the person needs, such
as a device sign-in page; it is never dropped as frequent updates are. For a
command the app runs, the link arrives as `plugin.command.progress` and the
project offers to open it after showing its host; an agent's tool call shows
it in the call's progress.

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
| Plugins page | `src/renderer/plugin-store.tsx`, `src/renderer/plugins.tsx` | `test/plugin-store.test.tsx`, `test/plugin-catalog-api.test.ts` |
| Workspace panels, commands, changes | `src/renderer/project-plugin-contributions.tsx`, `src/renderer/project-shell.tsx`, `src/renderer/workspace-layout.ts`, `src/renderer/composer-context-menu.tsx` | `test/project-shell-checkpoints.test.tsx`, `test/workspace-layout.test.ts`, `test/composer-context-menu.test.ts`, `test/project-plugins-sheet.test.tsx` |
| Signed releases | `src/daemon/plugin-releases.ts` | `test/plugin-manifest.test.ts` |

## Routes

- Types: `GET /project-types`; `POST /projects` with `projectType` creates a
  typed project in an empty folder or adopts a folder that holds one.
- Tools reach every agent through the session's tool list and external MCP.
  Agents and commands both call them through `PluginServices.callTool`, which
  checks the input and the result against the manifest's schemas.
- Skills of a project's active plugins load in its agent sessions, both
  OhMyGame's agent and the coding agents, beside format 1 plugins' Skills.
- MCP servers (`contributes.mcpServers`) of a project's active plugins start
  in its agent sessions beside format 1 plugins' servers, through the same
  MCP host (`PluginServices.mcpServers`). A server runs a `command` listed
  in `capabilities.processes`, from the plugin's folder or its `cwd`, or
  reaches a `url` on this machine or on a host in `capabilities.network`.
  Its `args`, `env`, `url` and `headers` may name settings as
  `${config.field}`; a server waits until those are filled in, and a secret
  needs `capabilities.secrets`. Agents see only the `tools` it lists. Servers
  start lazily, on a session's first call to one of them.
- A typed project's preview follows the plugin version its `ohmygame.json`
  pins; the app updates what it recorded when that file changes and at
  startup.
- Commands and changes: `GET`/`POST /projects/:id/plugin-commands`
  (`{ command, input? }`; `PluginServices.runCommand` runs it),
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
  can turn on for itself; the type's own plugin is left out. Creating the project posts each one's consent, if still needed, and
  turns it on once the project exists.

## In the app

- **Plugins page:** Installed lists format 2 plugins under **Turned on per
  project**, from `GET /plugin-store/plugins` (one row per installed
  version, newest first, with the plugin's settings fields and what it
  adds, MCP services included). A plugin's page switches it off everywhere, asks for what it
  hasn't been allowed, fills its `configuration` fields (a secret is only
  replaced or cleared), and uninstalls one version at a time. A plugin in
  `plugins-v2/` only switches off; uninstalling it is refused.
- **Panels** of a project's active plugins sit beside its own, in the area
  the manifest names, when their `when` holds. A panel opens the first time
  it is offered and stays closed once the person closes it, like the
  built-in ones.
- **Commands** show in the slots `composer.slash` (and every command with a
  `slash` name), `composer.add` and `project.menu`. A prompt is sent, or
  put in the composer with `insert`; `openPanel` brings the panel forward;
  `openSettings` opens the plugin's page; a `url` opens after the person
  sees its host; tool and native commands run in the plugin, and a toast
  offers Undo when they changed files. The other slots are not shown yet.
  A plugin page's `command.run` may send `input`: a tool command passes it
  to the tool instead of the manifest's `input`, and a native command takes
  it only when its `run.input` names a JSON Schema for it. Both are checked
  before the plugin runs.
- **Plugin changes…** in the project menu lists `GET
  /projects/:id/plugin-changes`, each with its own Undo.

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
