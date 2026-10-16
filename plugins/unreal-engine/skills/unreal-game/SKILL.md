---
name: unreal-game
description: Inspect Unreal projects and edit levels or actors through the official experimental Unreal MCP; diagnose project build and Editor execution workflows.
---

# Unreal Game

Inspect the `.uproject`, engine association, `Config/`, source modules, and project instructions. Use a General workspace with web preview disabled. Preserve the existing engine version and enabled plugins; native Editor and player windows are separate from OhMyGame's browser preview.

## Connect the selected Editor

The official experimental MCP is documented for UE 5.8. Verify that the actual Editor build contains **Unreal MCP / Model Context Protocol** rather than assuming all UE 5 installations support it. For setup, enable that plugin and only the toolsets needed for the task; restart the Editor if prompted. These are project/plugin changes, not prerequisites to a read-only project review.

In the selected Editor console, `ModelContextProtocol.StartServer` starts the server on demand. The default is `http://127.0.0.1:8000/mcp`. Match the plugin's **Local Unreal MCP URL** to that Editor's port/path and keep this unauthenticated experimental service on loopback. Use different ports for multiple Editors and verify the actual project/level through read-only tools before editing. Do not generate configuration for other AI clients.

Discover the server's schemas. With default tool-search mode, `tools/list` exposes `list_toolsets`, `describe_toolset`, and `call_tool`; three tools do not mean the Editor has only three operations. Describe relevant toolsets before calling their tools. Send Unreal tool calls **serially**, awaiting each result, because execution synchronizes with the game thread. A connection test lists capabilities without proving that an Editor operation works.

## Make changes through supported APIs

Use available scene/actor/property tools and confirm the target level and object identity. Save affected assets and verify saved paths. Keep `.uasset` and `.umap` changes in Editor APIs; do not rewrite them as text. Edit C++ and configuration through the project's normal source workflow, then read build and Editor diagnostics.

Blueprint graph editing, viewport capture, input injection, and Play-in-Editor controls depend on the actual toolsets. Do not invent missing tools or claim those capabilities from a successful handshake. If the engine lacks the official MCP, use an existing project build/script workflow where appropriate and report the unavailable Editor operations. Do not install a community bridge or migrate the engine as an automatic fallback.

## Verify

Read back actor names, transforms, and changed properties, save the test level, and reopen it to confirm persistence. For behavior changes, run the relevant Editor/player flow and inspect runtime logs. Capture and open the real viewport when supported; otherwise request the specific manual check. OhMyGame's web `game_use` does not control Unreal.

Use the project's existing UAT/BuildCookRun or CI recipe for an authorized package build, with the matching engine, platform SDK, and explicit project path. Keep successful MCP discovery, scene persistence, gameplay, cooking/packaging, and publication as separate results. Stop an on-demand server started solely for a bounded test when finished using the Editor's `ModelContextProtocol.StopServer` command.

Official reference: [Unreal MCP setup, tool search, and experimental constraints](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor).
