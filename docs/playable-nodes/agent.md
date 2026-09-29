# Agent

In Playable Nodes the Agent is the primary author. The author describes; the
Agent reads and writes ordinary project files, checks its work, and reports
back. This document defines what the Agent is given, the rules it follows,
and the tools it uses to verify results.

## Principles

- **Files are the interface.** The Agent edits `graph.json`, node and Shell
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
  `initialState` before using it.
- Use only assets declared by the node, through `context.assets.url(id)`.
- Build every screen with the Project Style in `shared/style/`. Add a new
  shared component there when two nodes need the same piece of UI.
- Use the Shell only for UI that must stay alive across nodes; use
  Destinations for Shell navigation.
- Use `replace` for forward progress and `push` only when the player should
  return with `back()`.
- Keep IDs and source paths stable. Do not rely on `window` globals.
- Run the checks below before finishing.

`README.md` documents the files and the node API in more detail, and
`schemas/` contains the exact JSON contracts.

## Request context

When the author sends a message from the editor, the message carries the
current editor context as a structured block the Agent can read:

```text
[Playable Nodes context]
view: node-workbench
node: archive ("Case archive")
files: nodes/archive/index.html, nodes/archive/style.css, nodes/archive/node.js
signals: open-notes → notes (push), leave → (unconnected)
assets: archive-desk (image), old-book (image)
state used: roundsCompleted (read)
preview state: { "roundsCompleted": 8 }
screenshot: attached
picked element: nodes/archive/index.html:24:7 <a> "打开博弈笔记" (crop attached)
```

On the canvas the context lists the selected nodes and edges instead. With
nothing selected it contains only the project summary.

## Common tasks

**Create a node.** When a Preset fits, call `playable_add_node`; it performs
the same action as the editor's Add node menu. Otherwise write `nodes/<id>/`
from scratch using the Project Style and add the node to `graph.json` with
its title, source paths, assets, and Signals. Either way, omit its position;
the editor places new nodes.

**Add an exit.** Declare the Signal on the node, emit it from the right
interaction, and add an edge if the author named the target.

**Branch on progress.** Read State in the node and emit different Signals.
Do not add edge conditions.

**Remember something.** Add a key to `initialState`, then `set` or `patch` it
where the event happens.

**Use media.** Reuse an existing project Asset ID when it fits. Otherwise
find a Library asset, or generate one with `generate_image` or
`generate_video`, add a project Asset ID for it, and declare it on the node.
Tell the author what was generated.

**Persistent UI.** Build it in `shell/`, add the Destinations it opens, and
remove any duplicated per-node copies.

**Restyle the game.** Change `shared/style/` first; touch individual nodes
only where they override the style.

## Tools

The Agent has three Playable Nodes tools in addition to its normal file,
shell, and media generation tools.

### `playable_add_node`

Creates a node from a Preset, exactly as the editor does.

```json
{ "preset": "archive", "id": "archive", "title": "Case archive" }
```

It copies the Preset source into `nodes/<id>/`, adds the node with the
Preset's starter Signals to `graph.json`, and returns the created paths and
the Preset brief. Blank is available as `"blank"`.

### `playable_check`

Validates the graph and compiles every node and the Shell.

```json
{ "mode": "draft" }
```

It returns the same issues as the validation endpoint, each with `code`,
`path`, and `message`, followed by compiler errors with file and line. The
Agent fixes every issue before finishing. `publish` mode additionally reports
unconnected Signals.

### `game_use` for Playable Nodes

The existing `game_use` tool opens the real Player for Playable Nodes
projects. `open` accepts an optional starting node and state:

```json
{ "operation": "open", "path": "?node=archive&state=%7B%22roundsCompleted%22%3A8%7D" }
```

Snapshots include interactive elements inside node and Shell ShadowRoots and
the Runtime diagnostics snapshot defined in [runtime.md](runtime.md#diagnostics-snapshot):
current node, back stack, recent Signals, State, State access, errors, and
save status. `act` drives real input; `capture` returns a screenshot.

A typical verification: open at the changed node with a relevant state,
perform the interaction, confirm the expected Signal and target in the
snapshot, and capture a screenshot for visual changes.

## Turn review

The editor checkpoints project files before each Agent turn and shows the
change set afterwards with **Keep** and **Undo turn**
([authoring.md](authoring.md#multi-node-agent-changes)). The Agent therefore
makes the complete change in one turn and summarizes it at the end: nodes
created or changed, Signals and edges added, State keys added, assets
generated or declared, and what was verified.

## Measuring success

The Agent-facing design works when an Agent can build, connect, validate,
visually check, and debug every case in the
[vision success list](vision.md#what-success-looks-like) by changing only
project content, and without editing or depending on Runtime internals.
