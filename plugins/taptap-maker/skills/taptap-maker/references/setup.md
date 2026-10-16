# Maker setup and recovery

Use the same pinned CLI as the plugin's MCP: `npx -y --package=@taptap/maker@0.0.36 taptap-maker`. Set `TAPTAP_MAKER_DISTRIBUTION=ohmygame_plugin` in its environment. Read the CLI's command help when options are uncertain; use `--json` for machine-readable results.

## Existing projects

Check `doctor --target-dir <PROJECT> --json` and the local binding in `.maker-mcp/config.json`. Resume the bound project rather than asking the user to choose another app or overwriting its binding. Keep the project's own Git history and dev-kit. Missing/outdated dev-kit content is handled by the official `dev-kit update` command for this directory.

## New local directory

Initialization requires an empty directory, Git, a Maker account, and the CLI's Python environment. OhMyGame can create an empty General workspace; disable its web preview for Maker Runtime development.

Before `init`, explain the following concrete upstream behavior and obtain authorization for changes outside the project unless already explicitly authorized:

- CLI 0.0.36 may prepare private Python and Lua LSP dependencies under Maker's user directory.
- Its Lua LSP setup may run `maker-lua-lsp install --ide codex,cursor,claude`, modifying those editors' configuration. `--skip-mcp-install` does not skip this step.

If those editor changes are unwanted, use an already initialized Maker directory. There is no verified skip-LSP flag in this pinned release; do not invent one or edit other clients' settings to simulate it.

Once authorized:

1. Run `login` if required. Use the browser authorization flow; let Maker store its own credentials. Do not request PATs in chat or put them in plugin manifests or command arguments.
2. Run `apps --json` and present the returned projects for selection. Use the selected app ID; do not silently pick the first app. Only create a remote Maker project when the user requests one.
3. Run `init --app-id <SELECTED_ID> --target-dir <EMPTY_DIRECTORY> --skip-mcp-install --json`. For an explicitly requested new remote project, use `--create --name <NAME>` instead of `--app-id`.
4. Check `doctor` and MCP status for this absolute directory, then read its relevant dev-kit instructions.

OhMyGame already owns this plugin's MCP registration. Avoid the standalone `install --ide ...`, `mcp install`, or `upgrade` paths that register other clients or switch runtime versions. Update this plugin to change the pinned CLI/MCP version.

## Diagnose before retrying

Connection/protocol failure, expired login, missing local dependencies, invalid project configuration, remote compilation errors, and Git conflicts need different fixes. Preserve the specific diagnostic and local files. Use `doctor`, `python doctor`, or `lua-lsp doctor` as appropriate; setup/update commands have side effects and must remain within the authorized scope.

For long operations, retain their returned status, logs, or operation identifiers. A host timeout does not prove the remote operation failed; inspect its state before retrying.

Upstream references: [Maker CLI/MCP](https://github.com/taptap/instant-games-open-mcp/blob/main/docs/MAKER.md), [local preview](https://github.com/taptap/instant-games-open-mcp/blob/main/docs/MAKER_LOCAL_PREVIEW.md). The pinned release's help and the project's dev-kit determine which capabilities are actually available.
