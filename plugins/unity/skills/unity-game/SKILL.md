---
name: unity-game
description: Develop Unity scenes, prefabs, C# scripts, and assets; use the official Unity CLI for local Editor control, diagnostics, tests, and builds.
---

# Unity Game

Read `ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json`, and project instructions. Use the matching installed Editor, render pipeline, and serialization conventions. Keep asset `.meta` files with their assets and preserve GUIDs. Use a General workspace; the Unity Editor and native player have their own windows.

## Official tools

Prefer Unity's official CLI and Pipeline integration. Start with `unity --version`, `unity --help`, and `unity status` (or the located CLI's absolute executable path). Live Editor control requires Unity 6.0 LTS or later and `com.unity.pipeline`; CLI capabilities are experimental and vary by version. Inspect installed command help and relevant upstream Skills before relying on a particular schema.

Run project commands with explicit `--project-path <ABSOLUTE_PROJECT>` where supported and verify the returned project identity. Do not pick the first connected Editor. Use `unity command` discovery to inspect available Editor commands before executing them. `unity eval` executes C# in the Editor and has full project effects; prefer an existing command when it expresses the requested operation.

When Pipeline is missing, read `unity pipeline --help` and use the official install workflow for the selected project if dependency changes are within the user's request. Check the package diff and Editor connection afterward. Installing or enabling a plugin alone does not install Unity, activate a license, or connect an Editor. Avoid global `unity skill install` or `unity mcp configure` setup for other clients: OhMyGame already supplies this Skill and can execute CLI commands directly.

Older Unity projects may use their existing Editor batch-mode build/test scripts. Preserve that route and report live control as unavailable rather than upgrading the project or substituting an unrequested community bridge.

## Edit and verify

Use Editor APIs/commands for scene, prefab, and imported-asset changes. Edit C# through file tools, retain assembly boundaries, and inspect compile diagnostics after changes. Do not edit `Library/` caches or hand-author binary assets. Save the affected scene/assets through the Editor and confirm the intended asset path.

Discover the installed CLI's compile, test, play, log, capture, and build commands through help and command schemas. Run checks appropriate to the change, retain reports, and exercise the changed behavior in Play Mode or a built player. Play Mode can pause when the Editor loses focus; verify advancing state/frames and actual interaction rather than relying only on an `isPlaying` flag.

Open screenshots when capture is available; otherwise name the visual/manual check still needed. OhMyGame's web `game_use` does not control a native Unity window. A browser-export test does not establish WeChat/Douyin SDK compatibility or native-player behavior. Finish by reporting compilation, tests, runtime, and build evidence separately.

Official references: [Agent Plugin and Skills](https://github.com/Unity-Technologies/unity-agent-plugin), [CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference), [CLI versus MCP and version requirements](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli).
