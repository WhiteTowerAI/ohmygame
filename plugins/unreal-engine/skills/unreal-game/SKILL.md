---
name: unreal-game
description: Inspect Unreal projects and edit levels or actors through the official experimental Unreal MCP, and diagnose builds and Editor runs.
---

# Unreal Game

Read the `.uproject`, engine association, `Config/`, and source modules. Keep the engine version and enabled plugins.

## Connect

The official experimental **Model Context Protocol** Editor plugin is documented for UE 5.8; confirm the actual Editor includes it. Enabling the plugin and its toolsets changes the project, so do it only when the task needs Editor operations, and enable only the toolsets needed.

Start the server in that Editor's console with `ModelContextProtocol.StartServer` (default `http://127.0.0.1:8000/mcp`) and make this plugin's **Local Unreal MCP URL** match. Keep it on loopback because it is unauthenticated. With several Editors, use separate ports and confirm the project and level with read-only tools before editing.

In the default tool-search mode the server lists only `list_toolsets`, `describe_toolset`, and `call_tool`. Describe a toolset before calling its tools. Call tools one at a time and wait for each result, because they run on the game thread. Blueprint graph editing, viewport capture, input, and Play-in-Editor exist only when a toolset provides them.

## Change and verify

Change `.uasset` and `.umap` files only through the Editor. Edit C++ and config files normally and read the build diagnostics. Read back actor names, transforms, and properties, then save and reopen the level to confirm persistence. Package only on request, using the project's existing UAT/BuildCookRun recipe. Stop a server you started with `ModelContextProtocol.StopServer`.

Without the official MCP, use the project's existing build scripts and report which Editor operations are unavailable. Do not install a community bridge or migrate the engine.
