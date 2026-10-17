# Native OhMyGame plugins

Plugins is the single place to install Skills and MCP services, change configuration, test connections, and authorize services. A plugin may bundle Skills (including supporting scripts, references, and assets), existing MCP servers, or both.

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

### Plugin icons

`interface.icon` is optional display metadata. Use a Solar preset with
`{"type":"preset","id":"image"}`, or a package-owned image with
`{"type":"asset","path":"./assets/icon.png"}`. Supported preset IDs are
`package`, `gamepad`, `globe`, `box`, `image`, `palette`, `brush`, `music`,
`video`, `film`, `code`, `terminal`, `plug`, `server`, `wand`, `sparkles`,
`document`, `folder`, `layers`, `lightbulb`, `search`, `wrench`, `clipboard`,
and `flag`. The shared catalog in `src/shared/plugin-icons.ts` supplies the
picker, validation, and AI authoring instructions.

Custom icons must be valid PNG or WebP files up to 1 MB and 2048 × 2048 pixels.
Paths start with `./`, stay inside the plugin root, and cannot use symbolic
links. Remote URLs, absolute paths, SVG, and unknown preset IDs are rejected.
A square image with a transparent background is recommended. Installed images
are copied with the package and served by the daemon using authenticated
requests in the desktop app. Missing or failed image requests show the default
package glyph. Packages without an icon retain the existing built-in/default
appearance.

Missing, oversized or undecodable icon images in an imported or installed
package do not prevent the plugin from installing or loading; their icon
metadata is omitted so the default glyph appears. Builder preparation and icon
saves still reject invalid assets.
Installed image responses use content-based ETags for private revalidation.
Successful image decoding is reused by content hash; each read still checks the
current file and its path.

In Plugin Builder's Overview, click the icon beside the plugin name to search
presets, enter a preset ID, upload an image, choose a package image path, or
restore the default. This editor is available after a valid draft has been
prepared, including for an installed plugin with its original builder draft.
Changes save to the draft; use Install plugin or Update plugin to apply them.
Uploads use content-addressed filenames under `assets/` and preserve existing
package files. Icon edits refresh the content revision and clear saved checks;
stale icon saves and installations are rejected. Image path previews only read
valid PNG/WebP files from that draft. AI chooses from the same preset catalog
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

These responsibilities form the long-term architecture: packages declare capabilities, user configuration supplies values, and the host owns runtime sessions. Future capabilities should extend these boundaries.

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

The assistant authors Skills and supporting files in its workspace, then uses `plugin_manage prepare` to expose and validate the draft. `create-mcp` also prepares an uninstalled draft. The user reviews the overview and files and chooses Install plugin; further changes to the same authored package can be applied with Update plugin. Installation verifies a content revision so an outdated preview cannot install a changed draft. Package validation and MCP connection checks are displayed separately from workflow behavior, which must be tried in a project.

Draft configuration uses an independent configuration identity per workspace, including for two drafts with the same package name. Installation atomically promotes saved draft configuration to the stable plugin identity and removes the redundant draft copy. The workspace retains that configuration identity after uninstall, so reinstallation preserves the latest values and cleared credentials. If promotion fails after the package is installed, its installed identity is saved and the builder offers retry and uninstall. Draft connection tests use isolated temporary MCP sessions without installing the package or invoking business tools. Saved connection results belong to a content revision and are cleared after configuration changes. Browser OAuth completion remains on the installed plugin's configuration page.

Configuration assistance uses the same effective configuration, service-definition editing, and connection tests as the manual interface. Its package-authoring rules are shared with the `plugin-creator` Skill available in game conversations. Generating new MCP servers, hooks, custom plugin interfaces, and multiple accounts are outside the current supported scope.

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

## Validation

`test/plugin-capabilities.test.ts` covers credential isolation, reinstall and restart persistence, switches and shared ownership, migration, real STDIO/HTTP tool discovery, tool execution, a simulated OAuth provider, and a simulated model making a real assistant tool call. `test:node-runtime` also exercises MCP installation and connection in the compiled Node daemon.
