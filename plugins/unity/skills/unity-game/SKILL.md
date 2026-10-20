---
name: unity-game
description: Develop Unity scenes, prefabs, C# scripts, and assets, using the official Unity CLI for Editor control, diagnostics, tests, and builds.
---

# Unity Game

Read `ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json`, and use the matching Editor, render pipeline, and conventions. Keep `.meta` files with their assets so GUIDs survive. Never edit `Library/` or hand-write binary assets.

## Official CLI

Start with `unity --version`, `unity status`, and `unity --help`; the CLI is experimental and its commands vary by version. Live Editor control needs Unity 6.0 LTS or later with `com.unity.pipeline`. If Pipeline is missing, install it through `unity pipeline` only when the request allows dependency changes.

Pass `--project-path <ABSOLUTE_PROJECT>` and confirm the returned project; never take the first connected Editor. Discover Editor commands with `unity command` before running them. `unity eval` runs arbitrary C# in the Editor; use it only when no command fits. Do not run `unity skill install` or `unity mcp configure`: this Skill already provides the integration.

For older Editors, use the project's existing batch-mode build and test scripts and report live control as unavailable. Do not upgrade the project or add a community bridge.

## Change and verify

Change scenes, prefabs, and imported assets through Editor commands and save them. Edit C# with file tools and read compile diagnostics. Use the test, play, log, capture, and build commands listed by `--help`. Play Mode can pause when the Editor loses focus, so confirm that frames advance rather than trusting `isPlaying`. Open captured screenshots when capture is available.
