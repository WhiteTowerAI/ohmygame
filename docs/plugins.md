# Plugins

A plugin is a package with a manifest at `.ohmygame-plugin/plugin.json`. It can
add Skills, MCP servers, tools, commands, panels and project types. One that only
adds Skills applies by itself to every project it suits; any other is turned on
per project, once the person has allowed what it asks for.

Plugins come bundled with the app, prepared with it from another repository, from
the [Plugin Builder](#making-a-plugin), or from [Add plugin](#adding-a-plugin).
Installing a signed release from the app is not built yet: no catalog or release
keys ship.

## Browse plugins

The Plugins page reads `GET /plugin-store/plugins` and has three tabs.

- **Installed** groups the plugins that apply by themselves into **Game
  creation**, **Engines & platforms**, **Art & assets** and **Other plugins**.
  Each group shows up to six cards and a **View all**. **Turned on per project**
  comes next, then **Personal**: the plugins the person made (`personal/<name>`),
  ending with **Create a plugin with AI**, then the AI workspaces. Search shows
  every match in one list. Switching a plugin doesn't move it.
- **Browse** lists every plugin with its source and what it adds, and filters by
  source and by what it adds.
- **Skills** lists each plugin's Skills, with the person's own under **Personal**.

A project's **Plugins…** sheet, from the project menu, lists the plugins that
switch per project, with how many are on, as described in [Routes](#routes).
Under **Every project** it shows the plugins that apply by themselves, locked on;
they switch on the Plugins page, which **Manage all plugins** opens.

A plugin's page has **About** (the long description and Try it prompts),
**Skills**, and **Settings** tabs, beside a **Management** card with the plugin's
switch, version, source, and actions. A Try it prompt turns the plugin on in the project it
starts in, and waits until what the plugin asks for is allowed.

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
| Plugins for every project, preinstalled packages, packaging Skills | `src/daemon/plugin-services.ts`, `src/daemon/preinstalled-plugins.ts`, `src/daemon/plugin-conversion.ts`, `scripts/prepare-preinstalled-plugins.ts` | `test/bundled-plugins.test.ts`, `test/preinstalled-plugins.test.ts`, `test/plugin-runtime.test.ts` |
| Godot | `plugins-v2/godot/` | `test/plugin-manifest.test.ts`, `test/project-plugins.test.ts` |
| TapTap Maker | `plugins-v2/taptap-maker/` | `test/taptap-maker.test.ts` |
| Services, tools, commands, settings | `src/daemon/plugin-services.ts`, `src/daemon/plugin-values.ts` | `test/extension-hosts.test.ts`, `test/external-mcp.test.ts` |
| MCP host | `src/daemon/plugin-mcp-host.ts`, `src/daemon/mcp-definitions.ts` | `test/plugin-mcp-host.test.ts` |
| Project types and web builds | `src/daemon/project-types.ts`, `src/daemon/preview.ts` | `test/extension-hosts.test.ts`, `test/preview.test.ts` |
| Writes outside a turn | `src/daemon/plugin-writes.ts` | `test/checkpoints.test.ts` |
| Plugin pages | `src/daemon/plugin-ui-server.ts`, `src/shared/plugin-ui-protocol.ts`, `src/renderer/plugin-frame.tsx`, `src/daemon/plugin-page-storage.ts`, `packages/plugin-ui/` | `test/preview-static.test.ts` |
| Plugins page | `src/renderer/plugin-store.tsx`, `src/renderer/plugins.tsx` | `test/plugin-store.test.tsx`, `test/plugin-catalog-api.test.ts` |
| Plugin Builder | `src/daemon/plugin-setup.ts`, `src/daemon/plugin-draft.ts`, `src/daemon/plugin-authoring.ts`, `src/renderer/plugin-builder.tsx` | `test/plugin-builder.test.ts`, `test/agent-tools.test.ts` |
| Workspace panels, commands, changes | `src/renderer/project-plugin-contributions.tsx`, `src/renderer/project-shell.tsx`, `src/renderer/workspace-layout.ts`, `src/renderer/composer-context-menu.tsx` | `test/project-shell-checkpoints.test.tsx`, `test/workspace-layout.test.ts`, `test/composer-context-menu.test.ts`, `test/project-plugins-sheet.test.tsx` |
| Signed releases | `src/daemon/plugin-releases.ts` | `test/plugin-manifest.test.ts` |
| Icons | `src/shared/plugin-icons.ts`, `src/daemon/plugin-icons.ts`, `src/daemon/plugin-svg.ts`, `src/renderer/plugin-icons.tsx`, `src/renderer/plugin-icon-picker.tsx` | `test/plugin-builder.test.ts`, `test/plugins-protocol.test.ts` |
| Adding a plugin | `src/daemon/plugin-sources.ts`, `src/daemon/archive-extraction.ts`, `src/renderer/plugin-add-dialog.tsx` | `test/plugin-sources.test.ts`, `test/plugin-add-dialog.test.tsx`, `test/plugin-catalog-api.test.ts` |

## Routes

- Types: `GET /project-types`; `POST /projects` with `projectType` creates a
  typed project in an empty folder or adopts a folder that holds one.
- Tools reach every agent through the session's tool list and external MCP.
  Agents and commands both call them through `PluginServices.callTool`, which
  checks the input and the result against the manifest's schemas.
- Skills of a project's active plugins load in its agent sessions, both
  OhMyGame's agent and the coding agents.
- MCP servers (`contributes.mcpServers`) of a project's active plugins start
  in its agent sessions beside the person's [connections](#connections), through
  the same MCP host (`PluginServices.mcpServers`). A server runs a `command` listed in
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
- A project's Plugins sheet: `GET /projects/:id/plugins` lists the plugins
  that apply by themselves (shown locked) and every plugin turned on per project, with
  the version the project uses, its status, what it asks for, and whether the
  person allowed that. Turning on one never allowed asks first, then posts
  the consent. The type's plugin stays on.
- A plugin's page reads `GET /plugin-store/plugins`: its icon, long
  description, `examples` (Try it), `appliesTo`, Skills and homepage. Its icon,
  Skill contents and folder come through their own routes
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
  and lists `GET /project-plugins`, the enabled plugins a new project
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
project. A project's Skills come in order: these plugins, sorted by id, then the plugins
in its `ohmygame.json`. They have no
per-Skill switches. Mentions keep `{name, marketplaceId}`, with the publisher as
`marketplaceId`, so `plugin://web-game-studio@ohmygame` names a bundled one. A prompt that mentions one the project doesn't suit gets a 409.

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
  ([Connections](#connections)).

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
on the plugin's page, and mark itself `beta`.

## Packaging a repository of Skills

`packageSkills` (`src/daemon/plugin-conversion.ts`) writes a package from a
repository of Agent Skills, without changing the source.
`scripts/prepare-preinstalled-plugins.ts` uses it for the plugins the app brings
along from other repositories, as `config/preinstalled-plugins.json` lists them.

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
- The result maps each Skill's old path to its new one.

## In the app

- **Plugins page:** `GET /plugin-store/plugins` has one row per installed
  version, newest first, with the plugin's settings fields and what it
  adds, MCP services included. A plugin's page switches it off everywhere, asks for what it
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

## Plugin icons

`icon` in the manifest is optional: a path to an image in the package, such as
`./assets/icon.png`. A plugin with panels needs one, for their tabs. The `@` and
Add context menus show it too, through the same authenticated image loading and
fallback as the plugin library.

Custom icons support PNG, WebP, and static SVG, up to 1 MB and 2048 × 2048.
SVG files must be UTF-8 with an explicit positive `viewBox` no larger than
2048 × 2048 units. The static subset accepts shapes, groups, gradients, clipping,
masks, and local fragment references. Scripts, event handlers, styles, embedded
images, external references, document types, and foreign namespaces are rejected.
Use presentation attributes such as `fill` and `stroke`, and export editor metadata
away before packaging. Keep pixel artwork as PNG instead of tracing it into SVG.

Paths start with `./`, stay inside the plugin root, and cannot use symbolic
links. Remote URLs and absolute paths are rejected. A square image with consistent
transparent padding is recommended. Installed images are served by the daemon using
authenticated requests in the desktop app. A package without an icon, or a missing
or failed image, shows the default package glyph. Package artwork should remain
readable in both themes, including inline references; any necessary backplate
belongs in the asset itself. Brand resources belong to their plugin packages; see
[logo sources and maintenance](plugin-logos.md).

Installed image responses use content-based ETags for private revalidation.
Successful raster decoding and SVG validation are reused by content hash; each
read still checks the current file and its path. SVG is served with its image MIME
type, `nosniff`, and a restrictive document CSP, and displayed through `<img>`;
plugin SVG text is never inserted into the renderer DOM.

In Plugin Builder's Overview, click the icon beside the plugin name to upload an
image, choose a package image path, or restore the default. This editor is available
after a valid draft has been prepared. Changes save to the draft; use Install plugin
or Update plugin to apply them. Uploads use content-addressed filenames under
`assets/` and preserve existing package files. Icon edits refresh the content
revision and clear saved checks; stale icon saves and installations are rejected.
Image path previews only read valid PNG/WebP/SVG files from that draft.

## Connections

MCP servers the person adds themselves are connections (Settings → **MCP
Connections**; `src/daemon/connections.ts`, `src/daemon/connection-routes.ts`,
`src/renderer/connections-settings.tsx`). The agent can use them in every
project, or only in the project types a connection is limited to.

- **Adding:** by URL, by command and arguments, or by pasting the
  `mcpServers` JSON another app uses (each server becomes a connection named
  after its key). Credentials in environment variables, headers, URLs and
  arguments are taken out of the definition into encrypted configuration; the
  definition editor shows `${config.*}` references in their
  place. Unlike a plugin's HTTP server, a connection may use OAuth and any
  other option the MCP adapter supports.
- **Storage:** `<data>/connections.json` lists them. Each connection's
  definition, values and secrets are in `<data>/plugin-configuration.json`, owned
  by `connection:<id>`. Secrets are encrypted with a private `0600` key file
  (`plugin-credentials.key`), so keep the data directory and key together when
  backing it up; OAuth uses the adapter's credential storage. Credentials are
  never returned by the configuration APIs.
- **Runtime:** a connection runs under a fixed runtime name
  (`connection-<id>`), which its OAuth
  sign-in is stored by. Project sessions start connections, then the project's
  plugins' servers. Any change restarts the sessions using them. A test uses an
  isolated temporary session, lists what the server offers, and closes without
  calling its tools. A pending OAuth sign-in expires after ten minutes.
- **API:** `GET`, `POST /connections`; `GET`, `PATCH`, `DELETE
  /connections/:id`; `GET`, `PUT /connections/:id/definition` and
  `/configuration`; `POST /connections/:id/test`, `/auth-start` and
  `/auth-complete`. `#/settings/connections` opens MCP Connections.

## Bundled engine workflows

Bundled plugins live in `plugins-v2/`. Blender and Godot are marked Beta while
their platform workflows are being validated, and default to enabled. Blender,
like the other bundled plugins that only add Skills (Game Studio, Web Game Studio,
Three.js World and the Beta workflows below), applies to every project it suits;
see [Plugins for every project](#plugins-for-every-project). Godot is turned on
per project, and so is Unreal Engine (below). See [TapTap Maker](#taptap-maker)
for that plugin.

- **Blender:** local Blender CLI/Python workflow for editable `.blend` sources,
  GLB delivery, and preview images. The export helper accepts an optional
  collection, excludes cameras/lights, and requires `--overwrite` to replace an
  existing output. It does not save the source file. Validate the exported asset
  in its target engine, including material appearance and animation playback.
  Inspect the rendered preview and refresh affected outputs after visual fixes;
  without a target runtime, reimport the GLB into a clean Blender scene and leave
  runtime validation pending. No editor bridge/add-on is required. Use
  `--apply-modifiers` for baked static geometry; keep it off for shape-key export.
- **Godot:** the `ohmygame/godot` plugin brings the Godot game type
  (played in the game panel as a web build), native tools (`godot_status`,
  `run_headless`, `export_web`), **Run in Godot**, a Godot Skill, and the
  pinned `@coding-solo/godot-mcp@0.1.1` as its MCP server. Godot game projects
  have it: creating one with the app's `godot-game` kind makes it the
  plugin's type while the plugin is on. A General project turns Godot on in
  its plugins and approves it for its folder.
  Keep Web preview off when using General for native Godot development. The
  **Godot executable** setting (`godotPath`) is an absolute path, or empty to
  look in `GODOT_PATH`, the PATH and the usual install folders;
  `native/godot.mjs` does that lookup for both the tools and the MCP server,
  which `native/mcp.mjs` starts through `npx` (Node.js with npx is needed).
  Check the actual engine version and import/run logs
  after testing. Viewport capture and gameplay input are not supplied by this
  MCP or the web `game_use` integration.

For a local Blender integration check, set `BLENDER_EXECUTABLE` to its absolute
executable path and run `bun run test -- test/blender-export.test.ts`. This
checks real GLB output, packed textures, transparency, hierarchy, skin animation,
morph targets, export scope, source preservation, and overwrite behavior;
it skips when Blender is not provided. Godot import/runtime still needs a local
Godot.

## TapTap Maker

TapTap Maker (`plugins-v2/taptap-maker/`, Beta) is a bundled plugin
that starts off; turn it on from **Plugins** in the main sidebar. It adds the
Maker project type, whose game runs in Maker's own native Runtime window, so
the project has no web preview and isn't published to Community.

- **Maker panel:** prepares the pinned `@taptap/maker@0.0.39` CLI and its
  Python/Lua diagnostics once in the plugin's data folder (Python 3.8+ with
  venv/pip and Git are required), opens Maker's browser sign-in, creates or
  connects the Maker project, and starts, refreshes and stops the preview,
  with its logs. Sign-in stays in Maker's own store in the home folder. One
  project prepares the CLI at a time; a cancelled step stops Maker's
  processes.
- **Creating:** a new Maker project starts empty apart from `ohmygame.json`.
  Until it is connected, the type's `ready` check holds the first message and
  opens the panel. Creating and connecting keep the folder's files, unless
  the Maker project has files at the same paths, and refuse a folder that is
  already a Git repository, since Maker would replace its remote and branch.
  `ohmygame.json`, `.ohmygame/` and `canvas/` go in the repository's
  `.git/info/exclude`, so Maker's commits leave them out unless the
  project's own `.gitignore` un-ignores them. A failed checkout resumes the created project instead of creating
  another; when a create's outcome is unknown, the panel asks the person to
  connect the project instead. Connecting the same project again only checks
  it.
- **Agent:** the `maker` MCP server starts from the same pinned install with
  `TAPTAP_MAKER_DISTRIBUTION=ohmygame_plugin` and offers Maker's tools; tools
  take the project's absolute `target_dir`. The `maker_preview` tool controls
  the same preview as the panel. Local previews never submit remotely;
  `maker_build_current_directory` commits, pushes and builds the bound branch,
  leaving out the excluded files unless they are already tracked. The TapTap
  Release Skill uses the person's signed-in `taptap-cli` for the store page,
  Spark version binding and review, and asks before installing it and before
  each approval-gated write.

See the [TapTap Maker](../plugins-v2/taptap-maker/skills/taptap-maker/SKILL.md)
and [TapTap Release](../plugins-v2/taptap-maker/skills/taptap-release/SKILL.md)
Skills. Authenticated Maker creation, preview, build and publication still
need a Maker account to check by hand.

## Additional Beta workflows

Cocos Creator, WeChat Mini Games, Douyin Mini Games, Unity, Unreal Engine,
Aseprite, and Tiled are bundled Beta plugins and default to **disabled**.
Open **Plugins** in the main sidebar and enable only the workflows needed for
the current project.
These packages reuse the existing runtime; they introduce no new project types,
client installers, custom MCP bridges, or automatic engine upgrades. All but
Unreal Engine only add Skills. Unreal Engine is a plugin with an HTTP MCP server, so once it is on, each General project
turns it on in its own plugins.

| Plugin | Project scope | Local integration and initial boundary |
| --- | --- | --- |
| Cocos Creator | General | Creator's own CLI and source workflow, initially targeting 3.8 LTS. Preserve the project's editor version and exported build configurations. |
| WeChat Mini Games | General | Engine exporter plus official WeChat DevTools. Simulator, device, test upload, review, and release are separate checks. |
| Douyin Mini Games | General | Engine exporter plus official game developer tools; the documented mini-game CLI entrypoint is `tt-minigame-ide-cli@2.1.1` / `tmg`. |
| Unity | General | Official Unity CLI and Pipeline package. Live Editor control requires Unity 6.0 LTS or later; the CLI is experimental. Existing older projects keep their own batch-mode workflows. |
| Unreal Engine | General | Official experimental Unreal MCP, documented for UE 5.8. Requires an Editor build containing the plugin, enabled toolsets, and a local server. Calls must be serial. |
| Aseprite | General, Web Game, Godot, Asset Canvas | Installed Aseprite CLI/Lua for editable source and PNG/JSON exports, followed by target-engine animation checks. |
| Tiled | General, Web Game, Godot, Asset Canvas | Installed Tiled editor/CLI for source maps, external tilesets, runtime exports, and target-engine checks. |

Engine and platform plugins compose: use Cocos Creator with WeChat or Douyin
rather than maintaining separate copies of the engine workflow. Unity platform
exports additionally require the platform's matching conversion SDK; a generic
WebGL build does not establish mini-game support. Use General with web preview
disabled for native editors and developer tools. Serve actual Web exports through
the browser workflow only after their build and serving command are known.

Only Unreal adds an MCP connection in this group. Its configurable endpoint
defaults to `http://127.0.0.1:8000/mcp` and connects lazily. It may only be on
this computer (`127.0.0.1` or `localhost`, any port), and the connection
follows no redirect. Start the official server in the intended Editor and
verify the actual project/level before editing. The default tool-search mode exposes three
meta-tools; listing them proves neither enabled toolsets nor a working scene
operation. Other packages use the agent's file/terminal tools and official local
applications. CLI executables may need absolute paths when absent from PATH.

The [manual acceptance checklist (中文)](plugin-beta-testing.zh-CN.md) gives
prerequisites, copyable prompts, hands-on checks, pass criteria, and a result
template for all seven packages. These real engine, account, and device loops
remain pending manual acceptance. Automated package and switch/scope
tests do not claim to verify them. Upload, review, and production publication
must follow the user's requested destination and scope.

## Validation

`test/plugin-mcp-host.test.ts` covers real STDIO and HTTP tool discovery and
execution, a simulated OAuth provider, the session guard, and a simulated model
making a real assistant tool call. `test/connections.test.ts` covers credential
isolation and masks. `test:node-runtime` also exercises MCP connection in the
compiled Node daemon.
