---
name: ohmygame-studio
description: Use OhMyGame's game studio tools from this agent - generate images, video, 3D models, animation, speech, sound effects and music with the person's configured providers, keep the project's Design and Asset Canvas valid, and playtest the game in a real window. Use when working in an OhMyGame project folder, or when the person asks for game art, 3D assets, audio or a playtest through OhMyGame.
---

# OhMyGame Studio

OhMyGame is a desktop app for making games. Its tools reach you through the
`ohmygame-studio` MCP server. You keep writing code with your own tools;
OhMyGame adds what you cannot do alone: media generation with the person's
providers, its canvas, and playing the game like a player.

## Choose the project

Every tool except `list_projects` and `open_project` works on one OhMyGame
project.

- Working inside a project's folder selects it. Call `get_project` to confirm
  the project, its type and its workspace folder.
- Otherwise call `list_projects`, then `open_project` with an ID or folder.
- If a tool says OhMyGame is turned off or could not be started, tell the
  person to open OhMyGame and turn on **Settings → MCP Server → Allow other
  agents to use OhMyGame**. Do not retry in a loop.

## Generate assets

Use `generate_image`, `generate_video`, `generate_3d_asset`,
`animate_3d_asset`, `generate_speech`, `generate_sound_effect` and
`generate_music`. Each call uses the person's provider credits, so:

- Write one specific prompt and generate once; do not try variations unless
  asked.
- Start 3D from an approved image: `generate_image` first, then
  `generate_3d_asset` with `imagePath`, then `animate_3d_asset` for rigged
  characters.
- Results name the saved file's workspace-relative path. Read the file with
  your own tools to check it before using it in the game.

Generation can take minutes. A tool that is not done within about 45 seconds
returns a job ID: call `wait_job` with it until the job finishes. Never start
the same generation again while its job runs. `get_job` checks without
waiting; `cancel_job` stops a job the person no longer wants.

## Canvas

Projects keep design docs, concept art and assets on a canvas under
`canvas/`. If you change files there, run `canvas_check` and fix what it
reports. `canvas_initialize` creates the canvas in a project without one.
`generate_canvas_media` generates into an existing canvas node.

## Playtest

`game_use` opens the game in OhMyGame's player window, acts as a player and
captures screenshots. Use it after changing gameplay: a successful build is
not a playtest.

1. `open` returns a session ID and the first state.
2. `act` with a batch of input and wait steps; it returns the new state.
3. `capture` for screenshots of canvas or WebGL games.
4. `close` the session when finished.

It needs the OhMyGame desktop app and a project with a game preview.

## Interactive Story projects

Use `playable_add_node` to add a screen and `playable_check` after changes;
use mode `publish` before the person publishes.

## What stays with you

Edit code and files, run commands, plan, and ask the person questions with
your own tools. OhMyGame cannot undo changes you make outside its tools, so
keep the project in version control.
