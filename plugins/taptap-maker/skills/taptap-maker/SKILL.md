---
name: taptap-maker
description: Develop bound TapTap Maker (UrhoX/Lua) projects with the official Maker MCP, run the native Maker preview, and submit explicitly requested Maker builds.
---

# TapTap Maker

Maker games use UrhoX and Lua. Pass the workspace's absolute path as `target_dir` to Maker MCP tools, and start with `maker_status_lite`. Read the workspace instructions. When the needed `.agents/skills/*/SKILL.md` files are not already available as Skills, read them directly.

## Setup and binding

The plugin's connection panel prepares the pinned CLI and diagnostics, signs in, and binds the directory. When setup, sign-in, or binding is missing, direct the user there. Do not ask for tokens, run Maker installers, upgrade the CLI, run `init`, or create remote projects yourself. Keep the existing binding, Git history, and dev-kit files.

## Preview

Use `project_preview` with `status`, `start`, `refresh`, `stop`, or `logs`; a missing Runtime is installed from View. The game opens in its own window, and a running process does not prove gameplay. Refresh after relevant edits, which resets game state. Never restart a preview the user stopped, and stop one you started for a test. CLI 0.0.36 has no `preview validate` or screenshots; validate Lua with the project's validation Skill and read its reports.

## Submit

Submit, push, or build remotely only on an explicit request: review the changes, then call `maker_build_current_directory` with `target_dir`. It commits and pushes `main` before building, even in a clean workspace. Report partial success, and inspect an unknown outcome before retrying. A build is not a publication; give the user the returned link to Maker's preview page. For the TapTap store page, review, and release, use the TapTap Release Skill.
