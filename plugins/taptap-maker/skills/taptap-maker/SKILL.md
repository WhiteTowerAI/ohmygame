---
name: taptap-maker
description: Develop bound TapTap Maker workspaces with the official MCP, preview locally, and submit explicitly requested Maker builds.
---

# TapTap Maker

Use the workspace's absolute path as `target_dir` on project MCP tools. Discover the connected schemas and read `maker_status_lite` for that directory. Preserve its existing binding. If setup or authorization is missing, direct the user to the plugin connection panel; see [setup.md](references/setup.md).

Maker uses UrhoX/Lua. Read the workspace's instructions and relevant dev-kit documentation, templates, or examples before implementing engine behavior. List its `.agents/skills` descriptions and read the needed `SKILL.md` files directly; OhMyGame does not automatically discover them. Keep these resources in place.

## Local preview

Use `project_preview` for status, start, refresh, stop, and logs. Install a missing Runtime from View. It opens a native window; process liveness does not verify gameplay. Refresh a running preview after relevant edits; refresh resets game state. Never revive a stopped preview automatically. Stop a preview started for a bounded test when finished.

For Lua validation, follow the project's available validation Skill and inspect its actual reports. CLI 0.0.36 does not support `preview validate` or native preview screenshots. Do not invent a Web preview or use Web `game_use` tools for Maker.

## Submit and publish

For an explicitly requested Maker submit, push, or remote build, inspect the changes and call `maker_build_current_directory` with `target_dir`. It commits and pushes the bound `main` branch before triggering a build; even a clean workspace may receive a wake-up commit. Follow the returned error classification, report partial success, and inspect unknown outcomes before retrying.

After a successful build, return its result/link and guide the user to Maker's preview/publish page. A build does not prove publication. OhMyGame Community publishing is a separate destination.
