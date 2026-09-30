# Agent

In Playable Nodes the Agent is the primary author. The author describes; the
Agent reads and writes ordinary project files, checks its work, and reports
back. This document defines what the Agent is given, the rules it follows,
and the tools it uses to verify results.

## Principles

- **Files are the interface.** The Agent edits `graph.json`, node
  source, `shared/`, and `editor/layout.json` directly. There is no
  Agent-only representation or hidden editing API.
- **The public contract is enough.** [runtime.md](runtime.md), the project
  `AGENTS.md` and `README.md`, and `schemas/` are sufficient to build normal
  content. The OhMyGame Runtime source is open for understanding edge cases,
  but projects never copy or modify it.
- **Verify, don't assume.** A change is finished when validation passes,
  every surface compiles, and the affected route has been exercised in the
  Runtime.
- **Stay in scope.** A request about one node changes that node, plus the
  graph entries and shared files it genuinely needs.

## Project instructions

Every project contains an `AGENTS.md` with the stable rules:

- Every node is the same kind of thing. Presets are starting points; never
  recreate node types.
- Node JavaScript exports `mount(context)`, renders into `context.root`, and
  cleans up with the returned function or `context.lifecycle.signal`.
- Emit only Signals declared by the node. Signals describe outcomes, never
  target nodes. Declare a new Signal in `graph.json` before emitting it.
- Keep authoritative data in Project State. Add a top-level key to
  `initialState` before using it, with a one-line description in
  `variables`. A key is for what crosses nodes or belongs in the save;
  progress inside one node stays in its code.
- Use only assets declared by the node, through `context.assets.url(id)`.
- Build every screen with the Project Style in `shared/style/`. Add a new
  shared component there when two nodes need the same piece of UI.
- UI that appears on more than one node, such as a top bar or a Home
  button, is a shared component under `shared/components/`. Each node that
  shows it imports it, and declares and routes the Signals it emits like its
  own. There is no layer drawn over every node; State carries whatever must
  continue across nodes.
- Give a Signal `"role": "navigation"` when it is a way around the game
  rather than a step in the story, such as Home, Menu, or Settings on many
  nodes. The editor then names its target instead of drawing a line;
  routing is the same.
- Use `replace` for forward progress and `push` only when the player should
  return with `back()`.
- Keep IDs and source paths stable. Do not rely on `window` globals.
- Run the checks below before finishing.

`README.md` documents the files and the node API in more detail, and
`schemas/` contains the exact JSON contracts.

The author sees the editor's words, not the engine's. The Agent uses the
editor's words when talking to the author and the engine terms in code: a
node is a Scene, a Signal with its edge is an Exit, the Entry Node is the
Start, a `push` edge is an Exit
with **Allow Back**, and a Preset is a Template
([vocabulary](README.md#vocabulary)). Project State keys are **Variables**,
listed read-only in Project ▾ with their descriptions and starting values.

## Request context

When the author sends a message with a node open, the message
ends with an `<editor-context>` block the Agent reads and the conversation
does not show; the timeline shows only the chip labels. The open node's
source files also arrive as workspace file references.

```text
<editor-context>
{"instruction":"The user sent this message from the editor with the context below. …",
 "items":[
  {"kind":"playable-node","label":"Case archive","text":"The user has Node \"archive\" (Case archive) open in the Playable editor.\nSources: nodes/archive/index.html, nodes/archive/style.css, nodes/archive/node.js\nSignals:\n- open-notes \"打开博弈笔记\" → notes (push)\n- leave → not connected\nAssets: archive-desk (image)"},
  {"kind":"playable-element","label":"<a> \"打开博弈笔记\"","text":"The user picked this element in the preview of Node \"archive\":\nElement: <a> \"打开博弈笔记\"\nSource: nodes/archive/index.html:24:7\nCSS path from the surface root: …\nBox in project viewport pixels: …"}
 ]}
</editor-context>
```

A picked element also attaches a screenshot of the preview with the element
outlined. On the canvas,
with no Workbench open, a message carries no editor context.

## Common tasks

**Create a node.** When a Preset fits, call `playable_add_node`; it performs
the same action as the editor's Add node menu. Otherwise write `nodes/<id>/`
from scratch using the Project Style and add the node to `graph.json` with
its title, source paths, assets, and Signals. Either way, omit its position;
the editor places new nodes.

**Add an exit.** Declare the Signal on the node, emit it from the right
interaction, and add an edge if the author named the target.

**Branch on progress.** Read State in the node and emit a different Signal
for each outcome, and give each a `when`: one short sentence such as "if
trust is 3 or more" or "needs the brass key". The canvas shows it on the
Exit. It is a description, not a rule; the node's code decides. Do not add
edge conditions. Every node must look right with the initial State, because
the editor previews each node from a new game.

**Remember something.** Add a key to `initialState` and describe it in
`variables`, then `set` or `patch` it where the event happens. An inventory
is one list Variable, item definitions in a `shared/` module, and a shared
component that shows it.

**Keep the words true.** Whenever the logic changes, update the `when` of
the affected Signals and the Variable descriptions in the same change, and
remove the description of a removed Variable.

**Use media.** Reuse an existing project Asset ID when it fits. Otherwise
find a Library asset, or generate one with `generate_image` or
`generate_video`, add a project Asset ID for it, and declare it on the node.
Tell the author what was generated.

**UI on many Scenes.** Build it once in `shared/components/` and import it
into each node that should show it. Declare the Signals it emits on each of
those nodes and connect them with that node's edges, marking navigation
Signals such as Home with `"role": "navigation"`; replace any duplicated
per-node copies with the import.

**Restyle the game.** Change `shared/style/` first; touch individual nodes
only where they override the style.

## Tools

The Agent has two Playable Nodes tools, and `game_use` when a Playtest
driver is available, in addition to its normal file,
shell, and media generation tools.

### `playable_add_node`

Creates a node from a Preset, exactly as the editor does.

```json
{ "preset": "choice", "id": "conductor", "title": "The conductor" }
```

It copies the Preset source into `nodes/<id>/`, adds the node with the
Preset's starter Signals to `graph.json`, and returns the created paths and
the Preset brief. Blank is available as `"blank"`.

### `playable_check`

Validates the graph and compiles every node and the shared modules it imports.

```json
{ "mode": "draft" }
```

It returns the same issues as the validation endpoint, each with `phase`,
`code`, `path`, `message`, and the surface when known, including compiler
errors. The Agent fixes every issue before finishing. `publish` mode
additionally requires every Signal to be connected and every source file to
exist.

### `game_use` for Playable Nodes

The existing `game_use` tool plays Playable Nodes projects. `open` builds the
current sources into a draft of the Published Player, served on loopback
under an unguessable path, and opens it in the Playtest window.

Snapshots read text and interactive elements inside the Player's frames and
node ShadowRoots, so the snapshot's text is what the screen shows.
Its `gameState` is the Playtest debug record: current node,
back stack, recent Signals and whether an edge followed them, State, State
changes, errors, and save status. The bridge `reset` action starts a new game
without the save. Only drafts expose the bridge; a published game does not. `act` drives real input; `capture` returns a screenshot.

A typical verification: open the draft, reset, play to the changed node,
perform the interaction, confirm the expected Signal and target in
`gameState`, and capture a screenshot for visual changes.

## Turn review

Turn review comes after the MVP ([roadmap](roadmap.md#after-the-mvp)). Until
then the Agent makes the complete change in one turn and summarizes it at the
end: nodes created or changed, Signals and edges added, Variables added,
assets generated or declared, and what was verified.

## Measuring success

The Agent-facing design works when an Agent can build, connect, validate,
visually check, and debug every case in the
[vision success list](vision.md#what-success-looks-like) by changing only
project content, and without editing or depending on Runtime internals.
