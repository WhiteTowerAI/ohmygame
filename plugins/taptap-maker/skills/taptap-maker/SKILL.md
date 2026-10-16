---
name: taptap-maker
description: Connect and develop TapTap Maker workspaces, run local Maker Runtime previews, and submit explicit Maker build requests using the official CLI and MCP.
---

# TapTap Maker

Use the current workspace's absolute path as `target_dir` on project MCP tools and `--target-dir` on project CLI commands. OhMyGame launches MCP from the plugin directory; process cwd is not the game directory. Never change a global MCP cwd to bind a project.

## Entry and project context

Discover the connected Maker tool schemas and read `maker_status_lite` with explicit `target_dir`. Connection success only verifies the server; account access, project binding, and Runtime readiness are separate checks.

For a bound project, continue with its existing binding. For initialization, authentication, or recovery, read [setup.md](references/setup.md). Run the pinned CLI using `npx -y --package=@taptap/maker@0.0.36 taptap-maker <COMMAND>`. Set `TAPTAP_MAKER_DISTRIBUTION=ohmygame_plugin` in the command environment so updates remain managed by this plugin.

Maker projects use their own UrhoX/Lua dev-kit. Read the workspace's Maker instructions and the relevant `engine-docs`, templates, or examples before implementing engine-specific behavior. OhMyGame does not automatically discover `.agents/skills`: list the project's Skill descriptions and read the relevant `SKILL.md` and its needed references directly. Retain these upstream resources in place rather than copying them into this plugin.

## Local development and preview

Use Maker Runtime for local preview. Run CLI `preview status`, then `preview install` if the Runtime is missing and its installation is authorized, and `preview start`; pass `--target-dir <PROJECT> --json` to each. Read `preview logs` and `preview check` for execution evidence. Refresh an existing preview after relevant edits; refresh restarts the game and loses in-memory state. Stop the preview started for a bounded test when finished.

For automated Lua validation or screenshot evidence, read the project's `run-lua-validate` Skill and check the pinned CLI's `preview validate` help. Open resulting images and read the actual reports. Process liveness is not gameplay verification. Maker Runtime opens its own native window; use a General project with web preview disabled rather than inventing a Vite preview or using OhMyGame's web `game_use` tools.

Use local preview when the user asks to run or inspect the local game. If context leaves local versus remote intent unresolved, clarify before a remote action. Multiplayer preview may need an existing remote test build and a test-server allocation; follow its reported prerequisites and obtain authorization for those remote actions.

## Submit, build, and publish

For an authorized Maker submit, push, or remote build, inspect the changes and call `maker_build_current_directory` with explicit `target_dir`. This tool commits and pushes before triggering a remote build; even a clean workspace may create a wake-up commit. Keep local preview and generic tests on their local paths.

Maker submission uses its bound `main` branch and the combined MCP tool, rather than a general-purpose feature-branch/PR workflow or manual Git authentication. On failure, report whether commit/push already succeeded and follow the returned error classification before retrying. Do not replay a remote action whose result is unknown.

After a successful remote build, return the Maker result/link and guide the user to the project's Maker preview/publish page. A build is not proof of publication. OhMyGame Community publishing is a separate destination.
