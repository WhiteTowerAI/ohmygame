# Plugin format 2

Format 2 is the next plugin contract. It runs beside format 1 ([plugins.md](plugins.md)),
which the Browse tab still uses.
The app lists installed format 2 plugins on the Plugins page, turns them on
per project, and shows their panels and commands in a project. Installing a
signed release from the app is not built yet: no catalog or release keys
ship, so format 2 plugins come bundled, from the Plugin Builder, or from
[Add plugin](#adding-a-plugin).

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
  - `origins.json`: where packages added from npm or GitHub came from;
  - `grants.json`: install consent, the app switch per plugin, and what each
    project folder allows (by real path);
  - `configuration.json`: settings values, readable only by the person;
  - `packages/<publisher>/<name>/<version>/`: installed releases;
  - `data/<publisher>/<name>/`: the plugin's data folder, shared by its
    versions and projects, made private on first use and deleted with its
    last version.
- **Project data,** in the project's storage folder: `plugin-changes.json`
  (changes plugins made outside a turn) and `plugin-storage/` (plugin pages'
  storage).
- **Bundled:** `plugins-v2/` ships with the app and is indexed in place by
  `PluginServices.ready()`, which every service method and route waits for;
  `packages/plugin-ui/` is `@ohmygame/plugin-ui`. A bundled plugin starts
  on unless it is in `bundledOff` (TapTap Maker), which leaves it off until
  the person turns it on.

## Native code

A native entry exports `activate(context)` (types in
`src/shared/extension-host-protocol.ts`). It runs in an extension host, a
Node child process per project (`src/daemon/extension-hosts.ts`), never in
the daemon. `context.project.folder` is the project and
`context.dataFolder` the plugin's data folder; each call gets `signal`,
`progress`, `turn` and `configuration`. Only tools, commands and project
type hooks the manifest declares can be registered. A tool, native command
or MCP server may set `timeoutSeconds` (up to 3600) for calls that
download or build. A native command with `changesFiles: false` runs
without the project's write lock and leaves no change to undo.
`progress(message, { url })` carries an https link the person needs, such
as a device sign-in page; it is never dropped as frequent updates are. For a
command the app runs, every message arrives as `plugin.command.progress`;
the project offers to open a link after showing its host, and the plugin's
own pages get the message as their `progress` event. An agent's tool call
shows it in the call's progress.

## Modules

| Area | Code | Tests |
| --- | --- | --- |
| Manifest, index, `when` | `src/shared/plugin-manifest.ts`, `src/shared/plugin-when.ts`, `src/daemon/plugin-index.ts` | `test/plugin-manifest.test.ts` |
| Project file and decisions | `src/daemon/project-plugins.ts` | `test/project-plugins.test.ts` |
| Hosts and native calls | `src/daemon/extension-hosts.ts`, `src/daemon/extension-host-process.ts`, `src/daemon/native-plugins.ts` | `test/extension-hosts.test.ts`, `scripts/test-node-runtime.mjs` |
| Plugins for every project, preinstalled packages, conversion | `src/daemon/plugin-services.ts`, `src/daemon/preinstalled-plugins.ts`, `src/daemon/plugin-conversion.ts`, `scripts/convert-format-1-plugin.ts` | `test/bundled-plugins.test.ts`, `test/preinstalled-plugins.test.ts`, `test/plugin-runtime.test.ts` |
| Godot | `plugins-v2/godot/` | `test/plugin-manifest.test.ts`, `test/project-plugins.test.ts` |
| TapTap Maker | `plugins-v2/taptap-maker/` | `test/taptap-maker.test.ts` |
| Services, tools, commands, settings | `src/daemon/plugin-services.ts`, `src/daemon/plugin-values.ts` | `test/extension-hosts.test.ts`, `test/external-mcp.test.ts` |
| Project types and web builds | `src/daemon/project-types.ts`, `src/daemon/preview.ts` | `test/extension-hosts.test.ts`, `test/preview.test.ts` |
| Writes outside a turn | `src/daemon/plugin-writes.ts` | `test/checkpoints.test.ts` |
| Plugin pages | `src/daemon/plugin-ui-server.ts`, `src/shared/plugin-ui-protocol.ts`, `src/renderer/plugin-frame.tsx`, `src/daemon/plugin-page-storage.ts`, `packages/plugin-ui/` | `test/preview-static.test.ts`, `test/plugin-ui-components.test.ts` |
| Plugins page | `src/renderer/plugin-store.tsx`, `src/renderer/plugins.tsx` | `test/plugin-store.test.tsx`, `test/plugin-catalog-api.test.ts` |
| Plugin Builder | `src/daemon/plugin-setup.ts`, `src/daemon/plugin-draft.ts`, `src/daemon/plugin-authoring.ts`, `src/renderer/plugin-builder.tsx` | `test/plugin-builder.test.ts`, `test/agent-tools.test.ts` |
| Workspace panels, commands, changes | `src/renderer/project-plugin-contributions.tsx`, `src/renderer/project-shell.tsx`, `src/renderer/workspace-layout.ts`, `src/renderer/composer-context-menu.tsx` | `test/project-shell-checkpoints.test.tsx`, `test/workspace-layout.test.ts`, `test/composer-context-menu.test.ts`, `test/project-plugins-sheet.test.tsx` |
| Signed releases | `src/daemon/plugin-releases.ts` | `test/plugin-manifest.test.ts` |
| Adding a plugin | `src/daemon/plugin-sources.ts`, `src/daemon/archive-extraction.ts`, `src/renderer/plugin-add-dialog.tsx` | `test/plugin-sources.test.ts`, `test/plugin-add-dialog.test.tsx`, `test/plugin-catalog-api.test.ts` |

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
  MCP host (`PluginServices.mcpServers`). A server runs a `command` listed in
  `capabilities.processes`, from the plugin's folder or its `cwd`, or is an
  HTTP server at a `url`, with optional `headers` (see below).
  The app sets `OHMYGAME_PLUGIN_DATA_DIR` in its `env` to the plugin's data
  folder; the manifest can't set that name itself.
  Its `args` and `env` may name settings as `${config.field}`; a server waits
  until those are filled in, and a secret needs `capabilities.secrets`.
  Agents see only the `tools` it lists. Servers start lazily, on a session's
  first call to one of them. The adapter would read the app's environment
  variables into `args` and `cwd`, so those can't name one (`${VAR}`,
  `$env:VAR`, `{env:VAR}`), in the manifest or once settings are filled in;
  `env` is passed as written. A session keeps the servers it started with,
  so once one of them is turned off or changed, the session's MCP calls are
  refused until its next message (`McpGuard`). The guard is asked before
  each of the adapter's tools runs and again by the adapter's approval
  request before each MCP call, including calls a script makes. A script
  already running can still start a server that hadn't started, but every
  call to it is refused. When an HTTP server reports an expired session, the
  adapter reconnects and resends a call it already approved without asking
  again, so that one call can still finish after the change.
- An HTTP MCP server's `url` must be https, or http on this computer
  (`127.0.0.1`, `localhost`), carry no user name or password, and be on a
  host `capabilities.network` lists: an entry names a host with any port, or
  `host:port` for one port. Its `url` and `headers` may name settings; a URL
  can't carry a secret, and a header's secret needs `capabilities.secrets`.
  The manifest check tries the URL with its settings' defaults, saving a
  setting refuses a value that would move the URL outside those hosts, and a
  server whose URL is still outside them (a value saved by hand) is left out.
  The app hands the adapter (`pi-mcp-adapter`, patched in
  `patches/pi-mcp-adapter@2.27.0.patch`) the URL's origin as
  `allowedOrigins`: every request stays on it, redirects are refused, the
  URL and headers are used as written (no `${VAR}` or `!command`), and OAuth,
  header commands and the failure probe are off.
- A typed project's preview follows the plugin version its `ohmygame.json`
  pins; the app updates what it recorded when that file changes and at
  startup. A `native` preview runs outside the app, so the project has no
  web preview and can't be published to Community.
- A project type's `ready` names a native command without input and a panel.
  Before each prompt the app runs the command (up to 20 seconds); when it
  answers `{ ready: false, message? }`, the prompt route answers 409 with
  `code: "project-not-ready"` and the panel, which the project opens, and a
  new project's first message waits there. A failed or missing check lets the
  prompt through.
- Commands and changes: `GET`/`POST /projects/:id/plugin-commands`
  (`{ command, input? }`; `PluginServices.runCommand` runs it),
  `GET /projects/:id/plugin-changes`,
  `POST /projects/:id/plugin-changes/:changeId/undo`.
- Pages: `GET /projects/:id/plugin-panels`,
  `GET`/`PUT /projects/:id/plugin-storage/:publisher/:name/:key`.
- Adding: `POST /plugin-sources/inspect` and `/plugin-sources/install` take a
  source as JSON; `POST /plugin-sources/file/inspect` and
  `/plugin-sources/file/install?digest=` take a `.tgz` as `application/gzip`.
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
- A plugin's page reads `GET /plugin-store/plugins`: its icon, long
  description, `examples` (Try it), `appliesTo`, Skills and homepage. Its icon,
  Skill contents and folder come through the same routes as a format 1 plugin's
  (`/plugins/:id/icon`, `/skill-content`, `/skill-file`, `/directory`), with the
  id `publisher/name` encoded and its newest version read; a bundled plugin's
  folder isn't offered.
- A plugin's `appliesTo` names the project types it works in (none means
  all); the type's own plugin always works in it. For a plugin turned on per
  project, that is the type `ohmygame.json` says: `general` (which a Web
  game or Asset Canvas project's file says too), `interactive-story`, or a
  plugin type. The sheet leaves out one that doesn't suit the project unless
  it is on, offering the newest version that does; turning it on is refused,
  and one the file asks for anyway resolves as `not-applicable`, so it
  doesn't run. Home offers only plugins that suit the chosen type.
- Home: the composer's type menu lists the app's types, then plugins' types
  from `GET /project-types`, then a link to the plugins that add types
  (`#/plugins?adds=projectType`). The type picks the starting plugin. The plugin menu beside the type
  takes any number of starting plugins, sent as mentions in the order chosen,
  and lists `GET /project-plugins`, the enabled format 2 plugins a new project
  can turn on for itself, except those that add project types: they are
  picked as the type, and a project of another type turns them on in its
  Plugins sheet. With starting plugins to pick, the menu leaves that list out
  while it is empty. Creating the project posts each one's consent, if still
  needed, and turns it on once the project exists.

## Plugins for every project

A plugin that only adds Skills, with no native entry, settings or
capabilities (`isAppWidePlugin`, judged on its newest version), can't run code
or reach files of its own. It asks for nothing, so there is nothing to consent
to, whoever publishes it: it applies to every project its `appliesTo` suits
instead of being turned on per project, unless the person switches it off.
`BUNDLED_PLUGINS_OFF` in `src/daemon/plugin-services.ts` lists the bundled ones
that start off.

`PluginServices.appWide(project)` lists these plugins and
`appWideSkills(project)` their Skills. A project suits a plugin when `appliesTo`
names its app kind or its plugin project type (`appWidePluginSuits`); the type
in `ohmygame.json` doesn't count, and a plugin with no `appliesTo` suits every
project. A project's Skills come in order: these plugins, sorted by id, then format 1
plugins for its type, then the plugins in its `ohmygame.json`. They have no
per-Skill switches. Mentions keep `{name, marketplaceId}`, with the publisher as
`marketplaceId`, so `plugin://web-game-studio@ohmygame` still names a bundled
one. A prompt that mentions one the project doesn't suit gets a 409.

A project can't turn one of these on in `ohmygame.json`: `setProjectPlugin`
refuses it, and `resolveProjectPlugins` skips an entry left there. The exception
is an older version that asks for more than the newest: a project that names it
keeps running it, in place of the newest.

`src/daemon/preinstalled-plugins.ts` installs the versions in
`config/preinstalled-plugins.json` through `PluginServices.installManaged`, the
same path that checks a package with `indexPluginPackage` and copies it under
`packages/<publisher>/<name>/<version>`. A package the person removes stays
removed, later releases included. Bundled plugins are indexed from `plugins-v2/`
and can't be uninstalled.

## Making a plugin

The Plugin Builder (`src/daemon/plugin-setup.ts`) and the `plugin-creator` Skill
(`src/daemon/pi-agent.ts`) follow the rules in `src/daemon/plugin-authoring.ts`.
What they make is always `personal/<name>`: `PluginServices.installPersonal`
refuses any other publisher, so it can't replace what the app or a publisher
ships. `src/daemon/plugin-draft.ts` checks a draft with `indexPluginPackage`,
as any package is checked.

- Installing from the builder allows what the plugin asks for, since the person
  reviewed it and chose Install. `install_plugin`, which the agent calls in a
  game conversation, allows nothing: the person turns such a plugin on in a
  project's Plugins sheet, which asks them to approve it. A plugin that only
  adds Skills asks for nothing and applies right away.
- A new version of a plugin that only adds Skills replaces its older versions.
  Any other keeps them for the projects that name them.
- A draft has no settings of its own; they are saved for the installed plugin.
  A draft's MCP server can be tried with `PluginServices.draftMcpServer`, which
  gives it the saved settings only if it is the package its workspace installed.
- An MCP service that signs in with OAuth is a connection, not a plugin
  ([Connections](plugins.md#connections)).

## Adding a plugin

**Add plugin…** on the Plugins page (`src/renderer/plugin-add-dialog.tsx`) adds a
package from npm, GitHub or this computer. `src/daemon/plugin-sources.ts` reads
each one into a temporary folder and never runs anything in it, so npm's install
scripts don't apply. The person reviews what it does, then adds it: adding reads
the source again and refuses a package whose digest isn't the one reviewed.

| Source | What's accepted | What's checked |
| --- | --- | --- |
| npm, from `registry.npmjs.org` or `registry.npmmirror.com` | `@publisher/name` or `@publisher/ohmygame-plugin-name` for the plugin `publisher/name`, optionally `@version` | The download's host and its SHA-512; the scope is the plugin's publisher and the version is the package's |
| GitHub | A public repository's URL, optionally `/tree/<branch or tag>`, with the package at its top | Pinned to the commit that exact branch or tag is at, recorded as the plugin's origin. GitHub's general commit lookup isn't used, since it also reaches commits in the repository's forks |
| This computer | A folder (desktop app) or an uploaded `.tgz` | As any package |

- A package allows nothing when it's added. What it asks for waits for the person
  to approve it, on its page or when they turn it on in a project's Plugins sheet.
  One that only adds Skills asks for nothing, so it applies right away and replaces
  its older versions.
- A package joins an installed plugin only from the same source: the same npm
  scope or GitHub repository. Approvals and settings belong to the id, so from
  anywhere else, and from this computer always, the person uninstalls it first,
  which clears them. Other contents under an installed version are refused; a
  new release needs a new version.
- A folder is copied to a private temporary folder before it's reviewed or
  installed, so it can't change between the two checks that matter.
- The publishers `ohmygame` and `personal` can't be added this way
  (`PluginServices.installAdded`), so a package can't stand in for what the app or
  the Plugin Builder provides.
- Archives come out through `extractTarball`, which takes only files and folders
  within the destination. The size and file limits are the release ones.
- npm leaves `.gitignore` files out of what it publishes, so a template ships
  `gitignore`, and packages from npm or a `.tgz` get it back as `.gitignore` in
  each project type's `template` folder, unless one is already there.
- Where a package came from is in `<data>/plugin-store/origins.json`, and shows on
  its page. Nothing updates a package by itself: adding it again is the update.

## More manifest fields

A manifest can also give a `longDescription` and up to five `examples`, shown
on the plugin's page, and mark itself `beta`. `ui.preview` lets its pages
load page components still in preview (see [Page components](#page-components)).
`scripts/convert-format-1-plugin.ts` converts a format 1 plugin that only adds
Skills, in place (`src/daemon/plugin-conversion.ts`).

`convertFormat1Package` writes a new format 2 package for any format 1
package's Skills, without changing the source:

- Every `SKILL.md` its Skills paths reach becomes `skills/<name>/`, copied with
  its folder. Paths can be one or several, each a folder searched to any depth
  or a single `SKILL.md`.
- A Skill nested in another's folder gets its own folder.
- Each name is the frontmatter name made a folder name, numbered when two
  match. The frontmatter is rewritten to that name, and gets the plugin's
  description when it has none.
- A file a `SKILL.md` links to outside its folder is copied into the Skill's
  `_shared/` folder, and the link is pointed there.
- The icon keeps its path, and a missing version becomes `0.0.0`.
- MCP servers, configuration and requirements are not carried over; the result
  lists them for the caller.
- The result maps each Skill's old path to its new one.

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

The frame has no border. It stays hidden until its page has the app's
theme: the bridge tells the app once it has applied it, a page without the
bridge shows half a second after it loads, and any page shows within three
seconds. A page that
links `/_ohmygame/plugin-ui.css` has a transparent root, so the panel's
surface shows through, and the app's type, colours and controls. When it
connects, and whenever the theme changes, the app sets the tokens in
`PAGE_TOKENS` (`src/renderer/plugin-frame.tsx`) on the page's `:root`. These
are the colours a theme sets, the roles the app's own components use
(`--color-surface`, `--color-text`, `--color-border`, `--color-ink`…), and
its type, radius, spacing and motion tokens. Until then the stylesheet holds
the app's defaults, and `test/preview-static.test.ts` keeps them equal to
`src/renderer/ui/tokens.css`. Pages may rely on these names: a release may
add tokens but not rename or remove one.

### Page components

`/_ohmygame/ui/<major>/index.js` defines the app's page components, which
`packages/plugin-ui/ui/<major>/` holds. Each draws in its own Shadow DOM from
the tokens above, so a page customizes one only through its attributes, CSS
custom properties and `::part()`. `--omg-accent` is the plugin's brand
colour, used only for the current step and progress; buttons stay ink.

Version 1 is in preview: a page's policy loads it only when the manifest has
`"ui": { "preview": true }`. Once a major version is stable, it loads for
every plugin, and a new one doesn't remove it for at least 12 months.
Featured and certified plugins won't use preview components.

| Component | What it is |
| --- | --- |
| `omg-page` | The page's column, at most 720px wide. `heading`, `description`; slots `brand` and `actions`. |
| `omg-section` | A titled group. `heading`, `description`; slot `actions`. |
| `omg-stack` | A row or column. `direction`, `gap` (`1`–`6`, the space tokens), `align`, `justify`, `wrap`. |
| `omg-steps`, `omg-step` | A numbered flow. A step's `state` is `pending`, `current`, `done` or `error`; a current or failed step, or one that is `open`, shows its content. Slot `summary` always shows. |
| `omg-status` | A state after a coloured dot, or a spinner. `tone`: `neutral`, `good`, `warning`, `bad`, `busy`. A live region. |
| `omg-banner` | A message across the page. `tone`: `info`, `good`, `warning`, `bad` (an alert); `heading`; slot `actions`. |
| `omg-log` | Monospace output that scrolls. `empty` text; `follow` keeps the latest line in view; the `text` property. |
| `omg-empty` | What to show when there is nothing yet. `heading`, `description`; slots `icon` and actions. |
| `omg-button` | The app's button. `variant`: `secondary`, `primary`, `ghost`, `danger`; `disabled`; `busy`. |
| `omg-command-button` | Runs one of the plugin's commands by its manifest id. `command`, and `input` as JSON or a property. While running, it is busy, shows the command's progress, and other command buttons wait unless `concurrent`; a failure shows beside it unless `quiet`. Events: `omg-command-start` (cancelable), `omg-command-result`, `omg-command-error` (cancelable). |
| `omg-select` | The app's select over its `<option>` children. `label` or `aria-label`, `value`, `disabled`; fires `change` and `input`. |

The components connect to the app themselves, so a page may use them
without calling `connect()`.
