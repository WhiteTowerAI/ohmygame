# Native OhMyGame plugins

Plugins is the place to install Skills and the MCP services that come with them, change configuration, test connections, and authorize services. A plugin may bundle Skills (including supporting scripts, references, and assets), existing MCP servers, or both. MCP servers the person adds on their own are [connections](#connections), in Settings.

## Browse plugins

Plugins has three tabs. **Installed** groups OhMyGame's plugins into **Game
creation**, **Engines & platforms**, and **Art & assets**, with **Other
plugins** for packages not yet in the curated grouping. Each group shows its
count and up to six cards; **View all** expands that group. **Personal**
follows in alphabetical order, ending with **Create a plugin with AI**, then the
AI workspaces. Search shows every matching plugin in one list without groups,
including disabled plugins. Enabling or disabling a plugin does not change its
position in the catalog. Beta and Needs configuration remain status badges, and
saved enablement choices are preserved. Each card's tags say where the plugin
applies (every project, or the project types it lists) and what it adds: its
Skill count and MCP services.

**Browse** lists the whole catalog with its source, the project types each
plugin works with, and what it adds. It filters by source (OhMyGame or other
sources), by project type, and by what it adds (**Skills** and **MCP**, from
`skillCount` and `mcpServerCount` in the summary); a plugin without project types works with every type.

A project's **Plugins…** sheet, from the project menu, lists the format 2
plugins that switch per project, with how many are on, as described in
[Plugin format 2](plugins-v2.md#routes). Under **Every project** it shows these
plugins locked on: they are on for every project they work with and switch on
the Plugins page, which **Manage all plugins** opens.

A plugin's page has **About** (the long description and Try it prompts),
**Skills**, and **Settings** (configuration, MCP services, and
dependencies) tabs, beside a **Management** card with the plugin's switch,
version, source, and actions. It opens on Settings while required
configuration is missing. A format 2 plugin's page has the same tabs, without a
switch per Skill; a Try it prompt turns the plugin on in the project it starts
in, and waits until what the plugin asks for is allowed.

## Package format

A package contains `.ohmygame-plugin/plugin.json`:

```json
{
  "formatVersion": 1,
  "name": "my-service",
  "version": "1.0.0",
  "description": "Tools for my service",
  "skills": "./skills/",
  "mcpServers": "./mcp.json",
  "configuration": {
    "endpoint": {
      "type": "text",
      "label": "MCP URL",
      "required": true
    },
    "api-key": {
      "type": "secret",
      "label": "API key",
      "required": true
    }
  },
  "interface": {
    "displayName": "My Service",
    "icon": { "type": "preset", "id": "plug" },
    "projectTypes": ["web-game", "godot-game"]
  }
}
```

All paths are relative to the plugin root and start with `./`. Omit components the plugin does not use. Skills use `skills/<skill-name>/SKILL.md` with `name` and `description` frontmatter. Configuration fields support `text`, `secret`, `path`, `boolean`, and `select`. Select fields require string `options`. Nonsecret fields may provide a default of the appropriate type; secret defaults are rejected.

Optional `interface.beta: true` displays a Beta badge on the plugin card and
detail page. Omit it or set it to false for plugins without that label; it does
not change installation, configuration, or enablement behavior.

Optional `enabledByDefault` sets a package's initial plugin switch (default:
`true`). A saved user choice takes precedence across restarts and package
updates. Disabled plugins contribute neither Skills nor MCP services to agent
conversations. Enabled Skills become candidates for compatible project types;
their full instructions are read when needed rather than injected into every
message. A lazy MCP service connects when requested.

### Plugin icons

`interface.icon` is optional display metadata. Use a Solar preset with
`{"type":"preset","id":"image"}`, or a package-owned image with
`{"type":"asset","path":"./assets/icon.png"}`. Supported preset IDs are
`package`, `gamepad`, `globe`, `box`, `image`, `palette`, `brush`, `music`,
`video`, `film`, `code`, `terminal`, `plug`, `server`, `wand`, `sparkles`,
`document`, `folder`, `layers`, `lightbulb`, `search`, `wrench`, `clipboard`,
and `flag`. The shared catalog in `src/shared/plugin-icons.ts` supplies the
picker, validation, and AI authoring instructions.

The `@` and Add context menus show each plugin's configured icon. Home and
conversation capability responses include `icon` and `iconRevision` so these
menus share the plugin library's authenticated image loading and fallback.

Custom icons support PNG, WebP, and static SVG, up to 1 MB and 2048 × 2048.
SVG files must be UTF-8 with an explicit positive `viewBox` no larger than
2048 × 2048 units. The static subset accepts shapes, groups, gradients, clipping,
masks, and local fragment references. Scripts, event handlers, styles, embedded
images, external references, document types, and foreign namespaces are rejected.
Use presentation attributes such as `fill` and `stroke`, and export editor metadata
away before packaging. Keep pixel artwork as PNG instead of tracing it into SVG.

Paths start with `./`, stay inside the plugin root, and cannot use symbolic
links. Remote URLs, absolute paths, and unknown preset IDs are rejected.
A square image with consistent transparent padding is recommended. Installed images
are copied with the package and served by the daemon using authenticated
requests in the desktop app. Missing or failed image requests show the default
package glyph. Packages without an icon retain the existing built-in/default
appearance. Package artwork should remain readable in both themes, including inline
references; any necessary backplate belongs in the asset itself. Brand resources
belong to their plugin packages; see [logo sources and maintenance](plugin-logos.md).

Missing, oversized or undecodable icon images in an imported or installed
package do not prevent the plugin from installing or loading; their icon
metadata is omitted so the default glyph appears. Builder preparation and icon
saves still reject invalid assets.
Installed image responses use content-based ETags for private revalidation.
Successful raster decoding and SVG validation are reused by content hash; each
read still checks the current file and its path. SVG is served with its image MIME
type, `nosniff`, and a restrictive document CSP, and displayed through `<img>`;
plugin SVG text is never inserted into the renderer DOM.

In Plugin Builder's Overview, click the icon beside the plugin name to search
presets, enter a preset ID, upload an image, choose a package image path, or
restore the default. This editor is available after a valid draft has been
prepared, including for an installed plugin with its original builder draft.
Changes save to the draft; use Install plugin or Update plugin to apply them.
Uploads use content-addressed filenames under `assets/` and preserve existing
package files. Icon edits refresh the content revision and clear saved checks;
stale icon saves and installations are rejected. Image path previews only read
valid PNG/WebP/SVG files from that draft. AI chooses from the same preset catalog
and preserves an existing user-selected icon.

`mcp.json` declares existing STDIO or HTTP MCP servers:

```json
{
  "mcpServers": {
    "api": {
      "url": "${config.endpoint}",
      "headers": { "Authorization": "Bearer ${config.api-key}" }
    },
    "local": {
      "command": "npx",
      "args": ["-y", "existing-mcp-package@1.0.0"]
    }
  }
}
```

The host resolves `${config.field-id}` from the user's configuration. Missing inputs leave the affected service unconfigured; other configured services and Skills remain available. Each service has one configuration instance. Relative STDIO `cwd` paths resolve from the package root; native services default to that root. Imported connections retain their existing working-directory behavior. HTTP transports, OAuth discovery, tool filtering, timeouts, and other adapter options are preserved. Tools use a stable server namespace; legacy server IDs retain their original names.

### Compatibility and dependencies

`formatVersion` describes the package contract, independently of the plugin's
SemVer `version`. The host currently supports format `1`; an omitted field also
means `1`, so existing native packages remain readable. A newer format is
rejected during discovery, installation, and archive import with an upgrade
message; in a marketplace, only the incompatible plugins are skipped. Optional
`minimumHostVersion` is a SemVer release of OhMyGame required by the package.
It is checked against the running application's version, including prereleases.
Already installed plugins remain listed after a downgrade, so they can still be
exported or uninstalled.

Keep plugin names, configuration field IDs/types, and component IDs stable
across compatible updates. The host preserves user configuration by plugin ID;
it does not run configuration migration scripts. A breaking configuration
change therefore needs a new plugin identity or a future explicit migration
mechanism. Format checks do not guarantee compatibility with an external MCP
service or a future dependency release.

Optional `requirements` declares executable names and supported systems, for
example `{"commands":["node","python3"],"platforms":["darwin","linux"]}`.
The detail page's **Check dependencies** reads the daemon's PATH, MCP commands,
working directories, and common script paths without running plugin commands
or installing packages. It reports unavailable tools/files, unresolved
configuration, unpinned `npx`/`bunx` package versions, and machine-specific paths.
Use exact package versions and package-relative paths for portable plugins.
This check does not validate tool versions, arbitrary Skill instructions, or
remote service availability; use the separate MCP connection test and try the
Skill in a project for those checks.

## Definition, configuration, and runtime

These responsibilities form the long-term architecture: packages declare capabilities, user configuration supplies values, and the host owns runtime sessions. Future capabilities should extend these boundaries, and must be expressible as Skills or MCP servers: [coding agents](coding-agents.md) receive a plugin's Skills and reach its MCP servers through the daemon, but cannot load Pi extensions.

Installed packages remain versioned. User values, credential references, and edited server definitions live separately in `plugin-configuration.json`, keyed by stable plugin ID. Reinstalling or updating a package preserves these values and overrides. Static credentials use an encrypted local store with a private `0600` key file; OAuth uses the adapter's credential storage. Keep the data directory and key together when backing it up. Credentials entered through the configuration form are never returned by configuration APIs or included in the assistant's structured tool results. Package authors should always use secret fields rather than embedding credentials in package files.

The same effective-configuration resolver supplies game sessions, manual tests, OAuth, and assistant operations. Plugin and per-service switches determine the active server set, together with project-type restrictions. Active game conversations finish the current turn before their session is rebuilt. Session shutdown closes adapter clients and processes. Connection tests use isolated temporary sessions, list capabilities, and close afterward without calling business tools. Pending OAuth sessions expire after ten minutes and cannot complete after the service configuration changes.

Reading a server definition only returns masked templates and never writes configuration. Explicit saves extract literal credentials and remove unused fields generated by previous server edits, while retaining fields still used by other services and fields declared by the package. Ordinary values such as `NODE_ENV`, `LOG_LEVEL`, `Accept`, and `Content-Type` remain in the template.

The legacy `connections` manifest field named a server imported from the old `mcp.json`. Nothing provides one now: each named connection is listed as not installed, and the package stays valid.

## Installation and AI assistance

The Add plugin menu supports folder/Git installation and a dedicated AI assistant. Its **Add MCP** entry opens Settings → MCP Connections. The detail page offers configuration forms, definition editing, tests, and HTTP authorization controls.

The library groups plugins into OhMyGame's (public) and **Personal**. OhMyGame's contains plugins provided by OhMyGame, including bundled and preinstalled packages, plus catalog entries whose trusted adapter marks the marketplace as official. Personal contains user-created plugins and user imports from folders, Git repositories, and third-party marketplaces. These are display groups: plugin IDs, original marketplace identities, and configuration keys are preserved. Imported archives always enter Personal, even when their source metadata came from a public catalog. Installed plugins in both groups have switches, including bundled plugins. Bundled packages cannot be uninstalled. A format 2 plugin that only adds Skills has one switch, with no switch per Skill.

Create with AI opens a dedicated Plugin Builder page with a conversation and four preview views: Overview, Files, Setup, and Checks. It makes format 2 packages with the id `personal/<name>`; see [Plugin format 2](plugins-v2.md#making-a-plugin). Each new plugin gets its own persisted workspace. The Plugins page lists AI workspaces that can be resumed or deleted; unsent input and the selected model are saved per workspace on the current device.

Configure with AI opens or resumes a separate configuration workspace for the selected installed format 1 plugin, starting on Setup. Its assistant can inspect the selected plugin and its Skill contents, change nonsecret configuration and MCP templates, and test connections. It cannot author or install packages or modify another plugin. Skills-only format 1 plugins offer Ask about this plugin; format 2 plugins have neither this nor Configure with AI yet. Edit with AI is available for format 2 plugins with the `personal` publisher and creates an editable copy of the newest installed version. Configuration and editing workspaces can start a new conversation in a separate workspace.

Game projects and Plugin Builder share `WorkspaceShell`, `WorkspaceAgentPane`, `ComposerActions`, and `WorkspaceFileBrowser`, alongside the existing timeline, prompt, model selector, workspace tabs, and configuration components. Both use the same compact toolbars, resizable panels, saved chat width, chat-side preference, and collapse controls. File preview accepts plugin-owned data and optional document rendering; authoring sessions, draft validation, configuration, and installation remain owned by the plugin service.

The builder exposes plugin enable/disable, conversation deletion, workspace deletion, and Uninstall as independent operations. Deleting only the conversation clears persisted history and unsent input while preserving draft files and the installed package. Deleting a workspace removes its conversation and draft files; installed packages and their saved settings remain. Workspace deletion is also available directly from the AI workspace list. Destructive actions require confirmation. Busy workspaces must finish or stop before deletion.

Uninstalling preserves the workspace and restores its draft for reinstallation, including when the plugin was removed from its detail page. A deleted authoring workspace can be replaced with Edit with AI from the installed plugin. Once a draft is installed it must keep its id. An update is rejected when the installed package has changed since the workspace last installed or copied it. Preview views show plugin content, what it asks for and actual check results; empty views use a single short status.

The assistant authors Skills and supporting files in its workspace, then uses `plugin_manage prepare` to expose and validate the draft. Validation is the same as for any format 2 package, so each Skill needs a `description` and a `name` matching its folder before installation; the game conversation's `install_plugin` uses the same validation. Incomplete Skills remain available in Builder's Files view for correction. The user reviews the overview and files and chooses Install plugin; further changes to the same package can be applied with Update plugin. Installation verifies a content revision so an outdated preview cannot install a changed draft. Package validation and MCP connection checks are displayed separately from workflow behavior, which must be tried in a project.

In create/edit workspaces, `plugin_manage` lists installed plugins, and reads, prepares or tests the current draft. MCP definitions and icons in a draft are edited as files and prepared again, and an explicit `id` is refused. Configuration workspaces work on their selected installed plugin, and the definition-editing operations apply there.

A draft has no settings of its own: the person fills them in after installing, on the plugin's page or in the builder's Setup view, and they stay through reinstalling. Draft connection tests use isolated temporary MCP sessions without installing the package or invoking business tools, A server that needs a setting can be tested once the draft is installed and the setting filled in: only a draft that matches the package its workspace installed gets the saved settings, so another draft can't send them elsewhere. Saved connection results belong to a content revision.

Configuration assistance uses the same effective configuration, service-definition editing, and connection tests as the manual interface. Its package-authoring rules are shared with the `plugin-creator` Skill available in game conversations. Authoring favors small, portable packages with task-specific guidance and supporting resources only when needed. Generating new MCP servers, hooks, custom plugin interfaces, and multiple accounts are outside the current supported scope.

Conversation history and structured tool activity come from the agent's session log and are returned as timeline turns; workspace listings load metadata only. `state.json` stores workspace purpose, package association, edit-source metadata, content revisions, and check results and uses atomic replacement. Shutdown and cancellation cover model lookup and session initialization as well as the active conversation. A workspace restored after an interrupted run explicitly reports interruption and can be continued with another message.

### Export and restore

Installed Personal plugins can be exported as a ZIP package and restored from
**Add plugin → Import plugin archive**. Preview shows the package before any
installation. Replacing an installed Personal plugin requires confirmation and
the revision from the preview; a concurrent package change requires a new
preview. Public plugins cannot be replaced by imported archives.

Exports contain native package metadata, Skills and supporting files, effective
MCP templates, nonsecret configuration, and plugin/component switches. Imported
formats are normalized to native metadata and retain their original Personal
or third-party marketplace identity. An imported plugin does not take ownership
of that marketplace, so the marketplace can still be installed from its folder
or Git repository. `.ohmygame-plugin/backup.json` holds the
versioned nonsecret restore data; ordinary native ZIP packages without this
file can also be imported. Executable file permission is preserved without
special permission bits. ZIP files are limited to 50 MB and extraction rejects
unsafe paths, symbolic links, private hidden files, and `node_modules`.

Platform-stored credentials, OAuth sessions, AI conversation history, and
builder workspaces are excluded. Sensitive MCP literals in environment,
headers, credential URLs, credential-named arguments, and token-shaped
positional arguments or URL path segments become required secret fields.
Detection is heuristic. Authors must still avoid embedding credentials in arbitrary
scripts/assets or ordinary text fields. Exports exclude private hidden files
and dependency directories; dependencies must be installed on the destination.
Manifest-declared Skills and the MCP file are checked in the completed export
before download. Supporting files are included as-is; references inside custom
scripts are not statically inspected.

On a fresh install, enter credentials and authorize OAuth again. Restoring a
backup over an existing plugin adopts the archive's templates and nonsecret
settings while retaining saved credentials for field IDs still declared as
secret. A package-only import preserves existing user configuration. Package
installation is atomic; restoring configuration and switches follows in
separate persisted writes. A settings failure explicitly reports that the
package was installed and allows the import to be retried.

Installed packages do not depend on the original AI workspace or source
directory. Bundled package contents follow application updates, while their
user switches and configuration remain separate. Versioned preinstalled
packages use the release prepared by the current app (Image to Three.js
ships as a format 2 package; see [Plugins format 2](plugins-v2.md)); Personal packages update
only through explicit editing, reinstalling, or importing. Per-turn editing
snapshots will reuse the shared workspace checkpoint system once it is
available to Plugin Builder; this change adds no separate snapshot store.

## Connections

MCP servers the person adds themselves are connections (Settings → **MCP
Connections**; `src/daemon/connections.ts`, `src/daemon/connection-routes.ts`,
`src/renderer/connections-settings.tsx`). The agent can use them in every
project, or only in the project types a connection is limited to.

- **Adding:** by URL, by command and arguments, or by pasting the
  `mcpServers` JSON another app uses (each server becomes a connection named
  after its key). Credentials in environment variables, headers, URLs and
  arguments are taken out of the definition into encrypted configuration, as
  for plugins; the definition editor shows `${config.*}` references in their
  place. Unlike a plugin's HTTP server, a connection may use OAuth and any
  other option the MCP adapter supports.
- **Storage:** `<data>/connections.json` lists them. Each connection's
  definition, values and secrets are in the plugin configuration store (the
  same encryption key), owned by `connection:<id>`.
- **Runtime:** a connection runs under a fixed runtime name
  (`connection-<id>`), which its OAuth
  sign-in is stored by. Project sessions start format 1 plugins' servers,
  then connections, then the project's format 2 plugins'. Any change restarts
  the sessions using them.
- **API:** `GET`, `POST /connections`; `GET`, `PATCH`, `DELETE
  /connections/:id`; `GET`, `PUT /connections/:id/definition` and
  `/configuration`; `POST /connections/:id/test`, `/auth-start` and
  `/auth-complete`. `POST /plugins/mcp`, which made a plugin holding only MCP
  servers, is gone, and so is the old settings CRUD API;
  `#/settings/connections` opens MCP Connections.

## Bundled engine workflows

Blender and Godot are marked Beta while their platform workflows are being
validated, and default to enabled. Existing saved switch choices are
preserved. Blender, like the other bundled plugins that only add Skills
(Game Studio, Web Game Studio, Three.js World and the Beta workflows below),
is a format 2 package in `plugins-v2/` that applies to every project it suits;
see [Plugin format 2](plugins-v2.md#plugins-for-every-project). Godot is a
format 2 plugin turned on per project, and so is Unreal Engine (below). No
bundled plugin is format 1 any more. TapTap Maker is a format 2 plugin; see
[TapTap Maker](#taptap-maker).

- **Blender:** local Blender CLI/Python workflow for editable `.blend` sources,
  GLB delivery, and preview images. The export helper accepts an optional
  collection, excludes cameras/lights, and requires `--overwrite` to replace an
  existing output. It does not save the source file. Validate the exported asset
  in its target engine, including material appearance and animation playback.
  Inspect the rendered preview and refresh affected outputs after visual fixes;
  without a target runtime, reimport the GLB into a clean Blender scene and leave
  runtime validation pending. No editor bridge/add-on is required. Use
  `--apply-modifiers` for baked static geometry; keep it off for shape-key export.
- **Godot:** the format 2 `ohmygame/godot` plugin brings the Godot game type
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

TapTap Maker (`plugins-v2/taptap-maker/`, Beta) is a bundled format 2 plugin
that starts off; turn it on from **Plugins** in the main sidebar. It adds the
Maker project type, whose game runs in Maker's own native Runtime window, so
the project has no web preview and isn't published to Community.

- **Maker panel:** prepares the pinned `@taptap/maker@0.0.36` CLI and its
  Python/Lua diagnostics once in the plugin's data folder (Python 3.8+ with
  venv/pip and Git are required), opens Maker's browser sign-in, creates or
  connects the Maker project, and starts, refreshes and stops the preview,
  with its logs. Sign-in stays in Maker's own store in the home folder. One
  project prepares the CLI at a time; a cancelled step stops Maker's
  processes.
- **Creating:** a new Maker project starts empty apart from `ohmygame.json`.
  Until it is connected, the type's `ready` check holds the first message and
  opens the panel. Creating and connecting refuse a folder with files of its
  own. A failed checkout resumes the created project instead of creating
  another; when a create's outcome is unknown, the panel asks the person to
  connect the project instead. Connecting the same project again only checks
  it.
- **Agent:** the `maker` MCP server starts from the same pinned install with
  `TAPTAP_MAKER_DISTRIBUTION=ohmygame_plugin` and offers Maker's tools; tools
  take the project's absolute `target_dir`. The `maker_preview` tool controls
  the same preview as the panel. Local previews never submit remotely;
  `maker_build_current_directory` commits, pushes and builds the bound branch,
  which may include `ohmygame.json`. The TapTap Release Skill uses the
  person's signed-in `taptap-cli` for the store page, Spark version binding
  and review, and asks before installing it and before each approval-gated
  write.

See the [TapTap Maker](../plugins-v2/taptap-maker/skills/taptap-maker/SKILL.md)
and [TapTap Release](../plugins-v2/taptap-maker/skills/taptap-release/SKILL.md)
Skills. Authenticated Maker creation, preview, build and publication still
need a Maker account to check by hand.

## Additional Beta workflows

Cocos Creator, WeChat Mini Games, Douyin Mini Games, Unity, Unreal Engine,
Aseprite, and Tiled are bundled Beta plugins and default to **disabled**.
Open **Plugins** in the main sidebar and enable only the workflows needed for
the current project.
Their saved switches are preserved by the same settings store as other plugins.
These packages reuse the existing runtime; they introduce no new project types,
client installers, custom MCP bridges, or automatic engine upgrades. All but
Unreal Engine are format 2 packages that only add Skills. Unreal Engine is a
format 2 plugin with an HTTP MCP server, so once it is on, each General project
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
remain pending manual acceptance. Automated package discovery and switch/scope
tests do not claim to verify them. Upload, review, and production publication
must follow the user's requested destination and scope.

## Validation

`test/plugin-capabilities.test.ts` covers credential isolation, reinstall and restart persistence, switches, real STDIO/HTTP tool discovery, tool execution, a simulated OAuth provider, and a simulated model making a real assistant tool call. `test:node-runtime` also exercises MCP installation and connection in the compiled Node daemon.
