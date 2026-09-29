# Authoring

This document describes what creating a Playable Nodes project feels like. The
Runtime contract is described separately; this document is about the editor.

## Principle

> The author describes. The Agent builds. The author sees it live.

Every authoring surface is designed around that loop. Editing code by hand is
possible, but it is an escape hatch that most authors never open, and no
normal task should require it.

The editor also reuses the parts of the current Interactive Drama editor that
already work well. The redesign removes node-type-specific forms; it does not
replace the whole interface.

## Workspace

The workspace keeps the current Interactive Drama layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Header: project title · Style · Shell · State · Playtest ·   │
│         Publish                                              │
├───────────────┬──────────────────────────────────────────────┤
│               │                                              │
│  Chat with    │   Flow canvas                                │
│  the Agent    │     or                                       │
│  (left/right, │   Node Workbench (opened from a node)        │
│  collapsible) │                                              │
│               │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

- The chat panel keeps its existing placement preference and collapse
  behavior.
- The main area shows either the Flow canvas or the Workbench of one node,
  with a breadcrumb (`Canvas › Case archive`) to return, as the current
  editor does.
- Style, Shell, and State open from the header. Playtest opens the real
  Runtime.

## Flow canvas

The canvas answers one question: how can the player move through the
project?

Each node card shows:

- a live thumbnail of the node, rendered by the Runtime, so the canvas looks
  like the game rather than like a diagram;
- the node title;
- one output port per declared Signal, labeled with the Signal label;
- an **Entry** badge on the entry node and **Destination** badges such as
  `home` or `rules`;
- an issue marker when the node fails to build, emits an undeclared Signal,
  or has an unconnected Signal.

Edges connect a Signal port to a target node. `replace` and `push` edges are
drawn differently, and the edge inspector offers only those two modes.

The canvas keeps the current editor's mature interactions: add-node menu,
context menu, selection, alignment guides, copy and paste, zoom controls,
and fit view.

Connecting can happen two ways, and both produce the same edges:

- drag from a Signal port to a node;
- ask the Agent, for example "connect Start to the lobby and Archive to the
  case archive as push".

## Creating a node

1. The author chooses **Add node** on the canvas.
2. They pick a Preset (Blank, Main menu, Cinematic scene, Dialogue choice,
   Archive, Investigation, QTE, Ending) or write a short description.
3. The node appears on the canvas with working starter content, and the
   Workbench opens.
4. The chat is focused with the new node as context, ready for "make this the
   Ash Club start screen, with a dark stone background and four entries".

A Preset is starter content plus instructions for the Agent. It is not stored
as a type, and a node created from "Main menu" can later become anything.

## Node Workbench

Opening a node shows its Workbench. It reuses the current
`NodeWorkbenchLayout`: a large preview and a resizable, collapsible
inspector. Every node gets the same Workbench.

```text
┌────────────────────────────────────────────┬─────────────────┐
│                                            │ Title           │
│                                            │                 │
│              Live preview                  │ Signals         │
│        (real Runtime, real assets)         │  start → Lobby  │
│                                            │  archive → …    │
│                                            │                 │
│                                            │ Assets          │
│                                            │  [img] [video]  │
├────────────────────────────────────────────┤                 │
│ Preview bar: restart node · state · recent │ State used      │
│ Signals · pick element                     │                 │
└────────────────────────────────────────────┴─────────────────┘
```

### Live preview

The preview runs the node in the real Node Runtime. It is interactive:
clicking "进入俱乐部" in the preview emits `enter-club`, and the preview bar
shows the Signal and the target it would lead to instead of leaving the node.

The preview bar offers:

- **Restart node** to mount the node again;
- **Preview state** to set Project State values for this preview, for
  example to see the archive after eight completed rounds;
- **Recent Signals and errors** from this node;
- **Pick element** to point at part of the preview and refer to it in chat.

### Inspector

The inspector contains only things every node has:

- **Title**, the editor-facing name.
- **Signals**: each declared Signal, its label, and the node it leads to.
  Authors can rename labels and jump to the target. The Agent adds Signals
  when it builds interactions that leave the node.
- **Assets**: the assets this node declares, with thumbnails, stable IDs, and
  missing-file status. Authors can add assets from the Library, upload a
  file, or ask the Agent to generate one for this node (see
  [Asset Canvas](#relationship-with-asset-canvas)).
- **State used**: the Project State keys this node read or wrote in recent
  previews, with current values.

There are no type-specific forms. What used to be a Choice's options or a
Scene's duration now lives in the node's own content and is changed by
describing the change.

### Talking to the Agent about a node

When a node is open, chat messages carry that node as context: its ID,
source files, Signals, declared assets, a current preview screenshot, and
any picked element. The Agent edits the node's files; the preview reloads
when the change is saved; new or removed Signals appear on the inspector and
canvas immediately.

Typical requests:

- "Make the right page an index of three cases; choosing one changes the left
  page."
- "Show the number of completed rounds from state on the left page."
- Picking "打开博弈笔记" and saying "this should lead to a new notes node".
- Picking a title and saying "use the pixel typeface from the main menu".

Small edits use the same loop. Direct text editing inside the preview is a
possible later improvement, not a v1 requirement.

### Code, when it is really needed

The Workbench overflow menu contains **Open source**, which opens the node's
files in the coding view. It is not a tab of the Workbench and it is never
the default view.

## Project Style

**Style** in the header opens the project's shared visual language: colors,
typefaces, spacing, and shared components such as a button or a page frame.
It is stored as ordinary shared source files that every node can import.

- The Agent reads and uses the Project Style whenever it builds a node.
- Authors can change the style through conversation ("make the whole game
  warmer, like lamp light on old paper").
- Changing the style updates every node that uses it.

Project Style is how two different screens, such as the Ash Club menu and
archive, stay recognizably part of one game.

## Shell and Destinations

**Shell** in the header opens a Workbench for the optional persistent UI,
such as the Ash Club top bar. It works like a node Workbench: live preview
over a sample node, a Destinations list, declared assets, and chat context.

Destinations (`home`, `lobby`, `rules`, …) are listed with the node each one
opens. Authors assign a Destination from the node inspector or the canvas
context menu, and the node card shows its badge.

## Project State

**State** in the header shows the project's shared data as a readable table
of keys, initial values, and types inferred from those values. Authors rarely
add keys by hand; the Agent adds a key when a node needs one and explains it
in chat.

During preview and Playtest the same panel shows live values and highlights
recent changes.

## Playtest

Playtest runs the real Runtime from the entry node, or from a chosen node
with a chosen state. It keeps the current Playtest entry point and adds a
compact debug drawer:

- current node, with a link to open it in the editor;
- back stack;
- recent Signals and the edges they followed;
- State changes;
- Runtime and build errors.

The same information is available to the Agent in serializable form, so it
can verify a flow it just built.

## Relationship with Asset Canvas

Asset Canvas and Playable Nodes stay separate workspaces:

- Asset Canvas connections mean **data dependency** (this image is a
  reference for that video). Playable Nodes edges mean **player movement**.
  One canvas with two meanings for a line was a major source of complexity in
  the old editor.
- Generating media is exploratory iteration; arranging a playable project is
  structural work. They are different working modes.
- With Agent-first authoring, the Agent can find or generate the media a node
  needs, so the author does not need both on one canvas.

Separation must not make the authoring loop longer. Three bridges keep it
short:

1. **One Asset Library with stable project Asset IDs.** Asset Canvas results
   enter the Library. A project Asset ID such as `club-background` points at
   one Library asset, and nodes use only the project Asset ID. **Replace**
   re-points that ID at a better Library asset, which updates every node that
   uses it without changing code.
2. **Media from the Workbench.** The node inspector can pick from the
   Library, upload, or ask the Agent for a single generation for this node.
   Complex generation opens the asset in Asset Canvas and returns to the node
   afterwards.
3. **Where used.** Asset Canvas can show which nodes use an asset. This can
   come after v1.

If real use shows authors constantly switching between the two workspaces,
an asset side panel on the Flow canvas can be reconsidered then.

## Reuse from the current editor

| Current editor part                                   | In Playable Nodes                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Workspace header, chat placement, breadcrumb          | Keep                                                                  |
| Flow canvas interactions (menu, guides, clipboard)    | Keep, with one node card and Signal ports                             |
| `NodeWorkbenchLayout` (preview, inspector, resizing)  | Keep as the single Workbench for every node and for the Shell         |
| Library asset picker and upload                       | Keep in the Assets section of the inspector                           |
| Playtest entry point                                  | Keep, driven by the Node Runtime, with the debug drawer               |
| Variables dialog                                      | Becomes the Project State panel                                       |
| Story issue banners                                   | Become node issue markers and validation messages                     |
| Per-type forms (Open UI, Scene, Choice, Ending, …)    | Remove; replaced by conversation and node content                     |
| Condition and Update State nodes                      | Remove; nodes read State and emit distinct Signals                    |
| Story Map and Settings system nodes                   | Remove; ordinary nodes, Destinations, and the Shell                   |
| Text, Image, Video, and 3D generation nodes           | Stay in Asset Canvas only                                             |

The detailed inventory and PR order belong in `roadmap.md`.

## Design decisions

### Presets

v1 ships seven Presets. Each Preset contains starter source that already uses
the Project Style, its expected Signals, and a short brief that tells the
Agent what the author usually wants next.

| Preset           | Starter content                                                  | Starter Signals        |
| ---------------- | ---------------------------------------------------------------- | ---------------------- |
| Blank            | An empty full-screen stage                                       | none                   |
| Main menu        | Title, subtitle, a list of entries, background image slot        | `start`                |
| Cinematic scene  | Full-screen video with skip; advances when the video ends        | `next`                 |
| Dialogue choice  | Background, speaker line, and options that can read State        | `option-a`, `option-b` |
| Archive          | A book or folder with an index that changes the visible page     | `leave`                |
| Investigation    | An image with hotspots that record findings in State             | `done`                 |
| Ending           | Ending title and text, restart and return-to-menu actions        | none                   |

Starter Signals are ordinary declared Signals; the author or Agent renames
and adds them freely. QTE and other small games start from Blank plus a
description; they are too varied for one useful starting point.

Presets live in OhMyGame, not in projects. Creating a node copies the
Preset's source into `nodes/<id>/`; later Preset changes do not affect
existing nodes.

### Node thumbnails

Thumbnails are screenshots of the real node, never a separate rendering.

- The Workbench preview captures its visible frame through the desktop
  `capturePage` capability, the same mechanism that captures Web Game project
  covers, about one second after the node reports ready or after a reload.
- Thumbnails are editor cache stored under `.ohmygame/thumbnails/` in the
  workspace. They are not part of `graph.json`, `editor/layout.json`, or the
  published project.
- A thumbnail records the hash of the node's compiled output. When the source
  changes, the card keeps the old image with a *stale* marker until the next
  capture.
- A node that has never been previewed shows its first declared image asset,
  or a neutral card with its title.
- A node that fails to build shows its last good thumbnail dimmed with an
  error marker; opening it shows the error in the Workbench.
- When the capture capability is unavailable (for example in the browser
  development build), the canvas uses the same fallbacks.

The same capture is attached to Agent requests about that node.

### Element picking

Element picking is editor tooling implemented by the sandbox host, not by
node code, and it is disabled in the Published Player.

1. **Pick element** puts the preview into pick mode. The sandbox host draws a
   hover outline inside the node's surface and blocks node input.
2. Clicking returns a **picked element** description: node ID, source
   location when known, CSS path within the node root, tag, visible text
   excerpt, bounding box, and a cropped screenshot.
3. Preview builds add an inert `data-ohmygame-source="index.html:12:5"`
   attribute to every element written in the node's HTML. Elements created by
   JavaScript have no such attribute; the description then relies on text,
   path, and screenshot, and the Agent finds the element in source.
4. The picked element appears as a chip in the chat composer, like the
   current selected-text reference, and is sent with the next message.

### Cinematic scenes

"Advance when the video ends" is node content, not a Runtime feature. The
Project Style includes a small `playCinematic()` component that plays a
declared video, offers skip, and emits a given Signal when the video ends or
is skipped. The Cinematic scene Preset uses it. Authors who want something
else (a choice over the last frame, a loop until input) change the node like
any other.

This keeps the Runtime free of media-ended and timer transitions while the
most common interactive-film case needs no code.

### Multi-node Agent changes

The Agent may create several nodes, Signals, and edges in one turn.

- Before each Agent turn, the editor records a checkpoint of `graph.json`,
  `editor/layout.json`, and the node, Shell, and `shared/` source files.
- After the turn, the canvas highlights the change set: new nodes and edges
  marked **New**, changed nodes marked **Edited**, removed ones listed in a
  summary bar.
- The summary bar offers **Keep** and **Undo turn**. Undo restores the
  checkpoint. Continuing to edit implicitly keeps the change.
- New nodes without a position in `editor/layout.json` are placed by the
  editor to the right of the node whose Signal leads to them, avoiding
  overlaps. The Agent does not need to compute layout.

### Asset versions

The project has no separate version concept. A project Asset ID points at
exactly one Library asset. Choosing a better image means pointing that
project Asset ID at a different Library asset with **Replace**.

- Nodes that should change together share one project Asset ID.
- A node that must keep an image while others change uses a different
  project Asset ID, for example `club-background-night`.

This gives both "update everywhere" and "keep this one" without a pinning
system.
