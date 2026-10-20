# Native OhMyGame plugins

Plugins is the single place to install Skills and MCP services, change configuration, test connections, and authorize services. A plugin may bundle Skills (including supporting scripts, references, and assets), existing MCP servers, or both.

## Browse plugins

The library separates **Public** and **Personal** tabs. Public packages are
grouped into **Game creation**, **Engines & platforms**, and **Art & assets**,
with **Other plugins** for packages not yet in the curated grouping. Each group
shows its count and up to six cards; **View all** expands that group. Personal
plugins use a flat alphabetical list. Search shows all matching plugins in the
selected tab without group expansion, including disabled plugins.
Enabling or disabling a plugin does not change its position in the catalog.
Beta remains a status badge, and saved enablement choices are preserved.

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

The legacy `connections` manifest field is a provider reference. It neither owns nor changes the provider's switch. Disabling a consuming plugin leaves an independent provider enabled. Missing providers remain visible and do not invalidate the consuming package.

## Installation and AI assistance

The Add plugin menu supports folder/Git installation, manual MCP configuration, and a dedicated AI assistant. Existing MCP configuration JSON can be pasted into the manual dialog. Credentials in environment/header fields are extracted into private configuration rather than copied into the generated package. The detail page offers configuration forms, definition editing, tests, and HTTP authorization controls.

The library groups plugins into **Public** and **Personal**. Public contains plugins provided by OhMyGame, including bundled and preinstalled packages, plus catalog entries whose trusted adapter marks the marketplace as official. Personal contains user-created plugins and user imports from folders, Git repositories, and third-party marketplaces. These are display groups: plugin IDs, original marketplace identities, and configuration keys are preserved. Imported archives always enter Personal, even when their source metadata came from a public catalog. Both groups expose plugin switches, including for bundled plugins. Bundled packages cannot be uninstalled.

Create with AI opens a dedicated Plugin Builder page with a conversation and four preview views: Overview, Files, Setup, and Checks. Each new plugin gets its own persisted workspace. The Plugins page lists AI workspaces that can be resumed or deleted; unsent input and the selected model are saved per workspace on the current device.

Configure with AI opens or resumes a separate configuration workspace for the selected installed plugin, starting on Setup. Its assistant can inspect the selected plugin and its Skill contents, change nonsecret configuration and MCP templates, and test connections. It cannot author or install packages or modify another plugin. Skills-only plugins offer Ask about this plugin. Edit with AI is available for Personal plugins and creates an editable native copy of the installed package, including normalized manifests for imported formats. Configuration and editing workspaces can start a new conversation in a separate workspace.

Game projects and Plugin Builder share `WorkspaceShell`, `WorkspaceAgentPane`, `ComposerActions`, and `WorkspaceFileBrowser`, alongside the existing timeline, prompt, model selector, workspace tabs, and configuration components. Both use the same compact toolbars, resizable panels, saved chat width, chat-side preference, and collapse controls. File preview accepts plugin-owned data and optional document rendering; authoring sessions, draft validation, configuration, and installation remain owned by the plugin service.

The builder exposes plugin enable/disable, conversation deletion, workspace deletion, and Uninstall as independent operations. Deleting only the conversation clears persisted history and unsent input while preserving draft files, configuration, and the installed package. Deleting a workspace removes its conversation, draft files, and private draft configuration; installed packages and their saved configuration remain. Workspace deletion is also available directly from the AI workspace list. Destructive actions require confirmation. Busy workspaces must finish or stop before deletion.

Uninstalling preserves the workspace and restores its draft for reinstallation, including when the plugin was removed from its detail page. A deleted authoring workspace can be replaced with Edit with AI from the installed plugin. AI-created packages have stable authored provenance rather than a conversation-directory identity. Editing updates the original plugin ID and retains configuration and component settings. An edited plugin gets authored provenance, so reinstalling or updating it from its original folder or Git repository is rejected instead of overwriting the edits. An update is rejected when the installed package has changed since the editing workspace was created. Preview views show plugin content, configuration fields, and actual check results; empty views use a single short status.

The assistant authors Skills and supporting files in its workspace, then uses `plugin_manage prepare` to expose and validate the draft. AI authoring validation requires each Skill's `name` and `description` frontmatter before installation; the game conversation's `install_plugin` uses the same validation. Incomplete Skills remain available in Builder's Files view for correction. `create-mcp` prepares a new uninstalled draft and refuses to overwrite an existing directory. The user reviews the overview and files and chooses Install plugin; further changes to the same authored package can be applied with Update plugin. Installation verifies a content revision so an outdated preview cannot install a changed draft. Package validation and MCP connection checks are displayed separately from workflow behavior, which must be tried in a project.

In create/edit workspaces, `plugin_manage` without an `id` reads, configures nonsecret values, or tests the current draft. These operations share the configuration and connection-test logic used by the preview, including credential isolation and invalidation of saved checks. An explicit `id` targets an installed plugin. Configuration workspaces default to their selected installed plugin. Draft MCP definitions are edited as files and prepared again; the definition-editing operations apply to installed plugins.

Draft configuration uses an independent configuration identity per workspace, including for two drafts with the same package name. Installation atomically promotes saved draft configuration to the stable plugin identity and removes the redundant draft copy. The workspace retains that configuration identity after uninstall, so reinstallation preserves the latest values and cleared credentials. If promotion fails after the package is installed, its installed identity is saved and the builder offers retry and uninstall. Draft connection tests use isolated temporary MCP sessions without installing the package or invoking business tools. Saved connection results belong to a content revision and are cleared after configuration changes. Browser OAuth completion remains on the installed plugin's configuration page.

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
packages use the release prepared by the current app; Personal packages update
only through explicit editing, reinstalling, or importing. Per-turn editing
snapshots will reuse the shared workspace checkpoint system once it is
available to Plugin Builder; this change adds no separate snapshot store.

## Migration

On first startup, application-level `pi-agent/mcp.json` is backed up to `mcp.json.pre-plugins.bak`. Each existing connection becomes a native plugin with its full definition, enabled state, and original runtime server ID. Godot is owned by the bundled Godot plugin. Import progress and provider ownership are persisted so retrying migration does not duplicate packages. The original file and backup remain available for recovery; subsequent runtime configuration comes from Plugins. The old Connections UI route redirects to Plugins, and its CRUD API is retired.

The migration reader never modifies the old file or creates a missing one. A retry replays credentials and switches for an unfinished import before recording ownership, including when installation succeeded but configuration persistence was interrupted.

## Bundled engine workflows

Blender, Godot, and TapTap Maker are marked Beta while their platform workflows
are being validated. They use the standard Skill/MCP package contract.
Blender and Godot default to enabled. TapTap Maker defaults to disabled: turn it
on from **Plugins** in the main sidebar when testing or developing Maker
projects. Existing saved switch choices are preserved.

- **Blender:** local Blender CLI/Python workflow for editable `.blend` sources,
  GLB delivery, and preview images. The export helper accepts an optional
  collection, excludes cameras/lights, and requires `--overwrite` to replace an
  existing output. It does not save the source file. Validate the exported asset
  in its target engine, including material appearance and animation playback.
  Inspect the rendered preview and refresh affected outputs after visual fixes;
  without a target runtime, reimport the GLB into a clean Blender scene and leave
  runtime validation pending. No editor bridge/add-on is required. Use
  `--apply-modifiers` for baked static geometry; keep it off for shape-key export.
- **Godot:** dedicated Godot Skill plus the existing pinned
  `@coding-solo/godot-mcp@0.1.1`, available in both General Game and Godot Game
  projects. Keep Web preview off when using General for native Godot development.
  The Godot executable configuration defaults to
  `godot` for upstream automatic discovery and can be replaced with an absolute
  executable path. Check the actual engine version and import/run logs after
  testing the MCP connection. Viewport capture and gameplay input are not
  supplied by this MCP or the web `game_use` integration.
- **TapTap Maker:** General-project workflow with the official pinned
  `@taptap/maker@0.0.36` CLI/MCP. Pass the current project's absolute `target_dir`
  on tools and `--target-dir` on project CLI commands: the MCP process starts in
  the plugin directory. The plugin's runtime script starts both from the same
  pinned install with `TAPTAP_MAKER_DISTRIBUTION=ohmygame_plugin`. Authentication remains in
  Maker's own local store. Read project `.agents/skills` explicitly as needed;
  they are not automatically added to OhMyGame's Skill catalog.

Maker's connection panel prepares a private pinned CLI and Python/Lua diagnostics,
then opens official browser authorization. Python 3.8+ with venv/pip and Git are
required. Enable the plugin to reveal this panel; enabling alone does not install
dependencies or log in. The plugin does not install configurations into other AI
editors. Private dependencies survive package updates and disabling, are removed
when an installed integration plugin is uninstalled, and stay outside exported
plugin packages. Credentials remain in Maker's own store.

Reference Maker when creating a project to select General automatically, or select
it under Project plugin in the new-project window. Project creation includes a
branded creation dialog before opening a conversation, keeping the original
description visible behind it. It defaults to **New project**: enter a name and
choose **Create project** to create the Maker project and
prepare its empty local directory. A ready account is summarized in one line,
with reconnect and refresh under **Account options**. Missing environment or
authorization steps expand only when needed. The explicit new-project window
uses the same content without opening a second dialog. **Existing project** retains explicit remote
project selection; an already bound directory can also be imported. Closing setup
preserves the home prompt. A failed checkout resumes the created project instead
of creating another one; an unknown creation outcome requires checking the project
list before reconnecting. Reconnecting the
same binding only checks its status; it does not run initialization again.
A newly imported directory with a Maker binding uses the plugin's compatible
type. A directory already registered as an OhMyGame project reopens unchanged.
Referencing Maker in an existing compatible project opens the connection panel;
the project switches to Maker only when you continue, which turns off its Web
preview and Community publishing. Closing the panel leaves the project as it was.
While the connection cannot be used, for example after the plugin is disabled or
removed, the Preview tab offers Disconnect plugin. It returns the project to an
ordinary General project, stops a running native preview, and
keeps Maker's binding files, so the project can connect again; Web preview stays
off until you turn it on in Project settings. Conflicting plugin references
require a compatible selection.

View shows the plugin and the state of Maker's separate native Runtime window,
with install/start/refresh/stop controls, a status refresh, and logs. The live
game cannot be embedded: Maker's Runtime is a native program with its own window.
Web preview is disabled for these projects. Controls load only while View is
open. While the
preview runs, View checks it every ten seconds to notice a closed window;
otherwise it rereads the daemon's in-memory state, which also reflects agent
calls, without starting the adapter. Agents use the same adapter through
`project_preview`.
The pinned release does not provide `preview validate` or native screenshots.
Local previews do not submit remotely. `maker_build_current_directory` commits,
pushes, and builds the bound branch; use Maker's own page to publish. OhMyGame
Community publishing is unavailable for integrated projects.

See the [TapTap Maker Skill](../plugins/taptap-maker/skills/taptap-maker/SKILL.md).

For a local Blender integration check, set `BLENDER_EXECUTABLE` to its absolute
executable path and run `bun run test -- test/blender-export.test.ts`. This
checks real GLB output, packed textures, transparency, hierarchy, skin animation,
morph targets, export scope, source preservation, and overwrite behavior;
it skips when Blender is not provided. Godot import/runtime and authenticated
Maker initialization/build/publication still need their respective local/account
environments.

## Additional Beta workflows

Cocos Creator, WeChat Mini Games, Douyin Mini Games, Unity, Unreal Engine,
Aseprite, and Tiled are bundled Beta plugins and default to **disabled**.
Open **Plugins** in the main sidebar and enable only the workflows needed for
the current project.
Their saved switches are preserved by the same settings store as other plugins.
These packages reuse the existing runtime; they introduce no new project types,
client installers, custom MCP bridges, or automatic engine upgrades.

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
defaults to `http://127.0.0.1:8000/mcp` and connects lazily. Start the official
server in the intended Editor, keep it on loopback, and verify the actual
project/level before editing. The default tool-search mode exposes three
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

`test/plugin-capabilities.test.ts` covers credential isolation, reinstall and restart persistence, switches and shared ownership, migration, real STDIO/HTTP tool discovery, tool execution, a simulated OAuth provider, and a simulated model making a real assistant tool call. `test:node-runtime` also exercises MCP installation and connection in the compiled Node daemon.

## Optional project integrations

> **Experimental.** TapTap Maker is the only implementation of this contract. Its
> actions, result fields, and connection steps may change in a later protocol
> version without a compatibility layer; third-party packages should not depend
> on it yet.

A native manifest can declare an integration without adding a host project type:

```json
"integration": {
  "entry": "./scripts/integration.mjs",
  "createProject": true,
  "projectFiles": ["./.maker-mcp/config.json"],
  "preview": "external"
}
```

`entry` is an installed `.mjs` file within the package. The host launches it with
its Node runtime and writes one version-1 JSON request to stdin. It receives
JSON-lines progress/result/error messages, validated against
[`plugin-integration.ts`](../src/shared/plugin-integration.ts). Requests contain
an action, private data directory, resolved plugin configuration, and (for project
actions) the registered workspace path. `projectId` on a bind request is the
explicitly selected service project; the HTTP query uses the OhMyGame project ID.
Plugins with `createProject: true` also accept `create`, with the registered
`projectName` and workspace path. Creation and binding both acquire the project's
write guard. The adapter must preserve a created identity across initialization
failures and must not repeat creation when its outcome is unknown.
The renderer cannot submit arbitrary filesystem paths.

The adapter owns service-specific dependencies, credentials, binding and preview
identity. The host owns task cancellation, time/output limits, write exclusion,
and presentation. No adapters run on app startup: import recognition only checks
that every declared `projectFiles` marker exists inside the workspace, resolving
symlinks. Project metadata saves the plugin ID and optional preview presentation;
the service's binding file remains authoritative. Only one integration may own a
workspace. A compatible project without an integration can check status and bind
as a candidate; it selects the plugin through
`PUT /projects/:projectId/integration` when the user continues, and
`DELETE /projects/:projectId/integration` removes it again. Native preview
actions require a selected integration. The host retains task outcomes in memory, without an automatic mutation
retry. Before a prompt, an idle connection result older than ten minutes is
rechecked; a failed recheck keeps the previous result so local work continues.
Disabling/removing the plugin cancels its active tasks, and a binding refreshes
only that project's conversations. Native preview windows remain service-owned
and are stopped through View or `project_preview`.
