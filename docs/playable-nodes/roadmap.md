# Roadmap

This document turns the design into a sequence of small, focused steps. It also records what we learned from the first attempt.

## Lessons from the first attempt

The `feat/interactive-drama-improvements` branch built a solid Runtime, then
replaced the mature Interactive Drama editor with a new, code-centered editor
and deleted the old one in the same effort. The result regressed the
authoring experience.

This time:

1. **Design before code.** The documents in this directory are agreed first.
2. **Replace before remove.** The old editor and Story runtime keep working
   until the new editor reaches parity on the inventory below.
3. **Reuse the mature UI.** The new editor is the old workspace with one node
   type, not a new interface.
4. **Small steps.** Each step has one purpose, passes checks, and leaves the
   product usable.
5. **Check in the real app.** Every UI step is exercised in the desktop app,
   not only by tests.

## What to carry over from the first attempt

The first branch is preserved at `feat/interactive-drama-improvements`
(local snapshot `449a49a`). Its Runtime work is carried over at its final,
renamed state rather than replayed commit by commit, which avoids re-applying
the old document and intermediate names.

| Area                                   | Files on the old branch                                                                                                      | Carry over                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Graph, state, navigation, validation   | `src/shared/playable-{nodes,graph,graph-schema,graph-validation,state,navigation}.ts`                                           | As is                                                                                      |
| Compiler                               | `src/daemon/playable-compiler.ts`, `src/shared/playable-compiled.ts`                                                           | As is, then add preview source attributes                                                  |
| Runtime and sandbox                    | `src/shared/playable-{runtime,sandbox,player-protocol}.ts`, `src/renderer/playable-{player.tsx,player.css,sandbox-entry.ts}`, sandbox HTML and Vite configs | As is, then add preview policy and diagnostics                                             |
| Codebase contract and source writes    | `src/daemon/playable-codebase.ts`, `src/shared/playable-{codebase,editor}.ts`                                                  | As is, including project `AGENTS.md` and `README.md`, updated to the new rules             |
| Project and publish                    | `src/daemon/playable-project.ts`, `src/shared/playable-publish.ts`, playable parts of `publish/archive.ts`, `published-player.tsx` | Playable parts only; keep the Story publish path                                           |
| Playtest                               | Playable branch of `src/renderer/playtest.tsx`                                                                                 | With the legacy fallback kept                                                              |
| Starter switch                         | `src/daemon/interactive-drama-starter.ts`                                                                                      | **Not yet.** New projects switch format only when the new editor is ready                  |
| Asset Canvas split                     | `asset-canvas-*` renderer and shared files                                                                                     | Yes, as its own step                                                                       |
| New editor                             | `src/renderer/playable-editor-workspace.tsx`                                                                                   | No. Individual pieces (codebase update and source draft handling) may be reused            |
| Tests                                  | `test/playable-*.test.ts`, `test/playable-fixture.ts`                                                                          | With the code they cover                                                                   |

## Old editor inventory

The new editor reaches parity when every *Keep* and *Adapt* row works in the
desktop app with a Playable Nodes project.

| Current capability                                                     | Where                                                                   | Decision | In Playable Nodes                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Workspace header, home, publish, chat toggle                           | `InteractiveDramaWorkspace`                                             | Keep     | Same header plus Style, Shell, State                                     |
| Chat left/right placement and collapse                                 | `project-shell.tsx`, `chat-layout.ts`                                   | Keep     | Unchanged; adds Playable Nodes context to messages                       |
| Canvas pan, zoom, fit view, zoom controls                              | `ZoomControls`, canvas                                                  | Keep     | Unchanged                                                                |
| Add-node menu and canvas context menu                                  | `CanvasToolbar`, `StoryCanvasContextMenu`                               | Adapt    | Presets instead of node types                                            |
| Alignment guides, copy and paste                                       | `story-canvas-alignment.ts`, `story-canvas-clipboard.ts`                | Adapt    | Copy duplicates node source under a new ID                               |
| Node cards with preview and inline title rename                        | `StoryPresentationNodeCard`, `InlineNodeTitle`                          | Adapt    | One card: thumbnail, title, Signal ports, badges, issue marker           |
| Output ports                                                           | `StoryNodeOutputs`                                                      | Adapt    | Ports are declared Signals                                               |
| Breadcrumb from node editor to canvas                                  | `StoryEditorBreadcrumb`                                                 | Keep     | Unchanged                                                                |
| Workbench layout with preview and resizable inspector                  | `NodeWorkbenchLayout`                                                   | Keep     | Single Workbench for every node and the Shell                            |
| Live runtime preview inside the Workbench                              | `StoryRuntimeWorkbenchPreview`                                          | Adapt    | Node Runtime with `report` policy and preview state                      |
| Library asset picker and upload                                        | `StoryMediaSourcePicker`, `StoryAssetPicker`                            | Adapt    | Inspector Assets section; declares project Asset IDs                     |
| Variables dialog                                                       | `story-variables-dialog.tsx`                                            | Adapt    | Project State panel                                                      |
| Story issues banner                                                    | workspace                                                               | Adapt    | Validation issues and node markers                                       |
| Playtest page, save and restore                                        | `playtest.tsx`, `story-progress.ts`                                     | Adapt    | Node Runtime, one save slot, debug drawer                                |
| Open UI, Scene, Interaction, Choice, Ending workbenches and inspectors | `*Workbench`, `StoryInspector`, `ChoiceActionsEditor`, `ChoiceConditionRule` | Remove   | Presets plus conversation                                                |
| Scene timeline and duration                                            | `SceneWorkbench`, `SceneTimerClock`                                     | Remove   | Cinematic Preset with `playCinematic()`                                  |
| Condition and Update State nodes                                       | `ConditionEditorPage`, `UpdateStateEditorPage`                          | Remove   | Node code reads State and emits Signals                                  |
| Story Map and Settings system nodes                                    | `story-map.tsx`, `story-settings.tsx`                                   | Remove   | Ordinary nodes, Destinations, Shell                                      |
| Screen, scene, interaction surfaces                                    | `story-*-surface.tsx`, `public/*-surface.html`                          | Remove   | One sandbox surface                                                      |
| Text, Image, Video, 3D, Asset generation nodes                         | `TextNode` … `AssetNode`, `MediaNodeShell`                              | Move     | Asset Canvas only                                                        |

## Step sequence

Each step is one commit (or a few) on `feat/playable-nodes-rework`. The
branch is opened as one pull request when the whole sequence is complete.
"Visible" means the author can see a change in the app.

### Phase 0: Design

1. `docs(playable-nodes): add redesign documents` — this directory.

### Phase 1: Runtime foundation (not visible)

2. `feat(runtime): add playable nodes contracts` — graph types, schema,
   validation, State, navigation, and their tests.
3. `feat(runtime): add playable node compiler` — compiler and compiled
   definition types.
4. `feat(runtime): add node runtime and sandbox` — Runtime, sandbox host,
   Player component, sandbox build, and Playtest support for `graph.json`
   projects, with the Story path kept as fallback.
5. `feat(playable): add project codebase and publishing` — codebase
   endpoints, validation endpoint, source writes, playable publishing, and
   Published Player support. New projects still use `story.json`; the
   `OHMYGAME_DEV_PLAYABLE_NODES=1` development flag creates `graph.json`
   projects for testing.

Check for each: `npm test`, `npm run typecheck`, and `npm run build` pass, an existing Interactive
Drama project still opens, plays, and publishes exactly as before.

### Phase 2: Separate Asset Canvas (visible, no behavior change)

6. `refactor(asset-canvas): extract asset canvas workspace` — give Asset
   Canvas projects their own workspace and schema containing only media
   nodes, so the Interactive Drama workspace can later drop media nodes.

Check: Asset Canvas projects generate, connect, and preview media as before.

### Phase 3: Runtime additions for authoring (not visible)

7. `feat(runtime): add preview policy and diagnostics` — `report` policy,
   preview state, diagnostics snapshot with State access.
8. `feat(runtime): add element picking and preview source locations`.
9. `feat(playable): add project style and presets` — default Project Style
   with `playCinematic()`, the seven Presets, and `playable_add_node` shared
   by editor and Agent.

### Phase 4: Editor on the new format (visible, behind a project format check)

The Interactive Drama workspace chooses the editor by project format:
`story.json` projects keep the old editor; `graph.json` projects get the new
one. During this phase only the internal "Playable Nodes" project creation
path (a development flag) creates `graph.json` projects.

10. `feat(editor): open playable projects in the drama workspace` — header,
    chat, canvas with one node card, Signal ports, edges, Entry and
    Destination badges, add from Preset, context menu, clipboard.
11. `feat(editor): add node workbench` — Workbench with live preview, preview
    bar, and inspector (title, Signals, Assets, State used).
12. `feat(editor): add node thumbnails`.
13. `feat(editor): add project state, style, and shell panels`.
14. `feat(editor): add playtest debug drawer`.
15. `feat(agent): add playable nodes context and tools` — request context,
    `playable_check`, `game_use` for Playable Nodes, updated project
    instructions.
16. `feat(editor): add agent turn review` — checkpoints, change highlights,
    Keep and Undo turn.
17. `feat(editor): add element picking to chat`.

Check for each: exercised in the desktop app. After step 17, build the
[vision success list](vision.md#what-success-looks-like) through conversation
and confirm every *Keep* and *Adapt* row of the inventory.

### Phase 5: Switch and remove

18. `feat(interactive-drama): create new projects as playable nodes` — new
    projects and the starter use `graph.json`; the development flag is
    removed.
19. `chore(interactive-drama): remove story runtime and editor` — remove the
    rows marked *Remove*, the Story runtime, and `story.json` support.

## Existing Story projects

The product has not launched, so existing `story.json` projects need no
conversion or compatibility. Keeping the old editor until step 18 exists only
to keep the app usable while the new editor is built, not to preserve
projects.

## Status

| Phase                       | Status      |
| --------------------------- | ----------- |
| 0. Design                   | Done        |
| 1. Runtime foundation       | Done        |
| 2. Separate Asset Canvas    | Done        |
| 3. Runtime for authoring    | Done        |
| 4. Editor on the new format | Not started |
| 5. Switch and remove        | Not started |
