# Authoring

This document describes what creating a Playable Nodes project feels like. The
Runtime contract is described separately; this document is about the editor.

It uses the editor's words: a node is a **Scene**, a Signal with its edge is
an **Exit**, the Entry Node is the **Start**, and a Preset is a
**Template**, and Project State is the **Variables**
([Variables](#variables)). The engine
term follows in parentheses where it matters; code, schemas, and tools keep
the engine terms ([vocabulary](README.md#vocabulary)).

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
│ Header: Project ▾ · Home           Playtest · chat · Publish │
├───────────────┬──────────────────────────────────────────────┤
│               │                                              │
│  Chat with    │   Flow canvas                                │
│  the Agent    │     or                                       │
│  (left/right, │   Scene Workbench (opened from a Scene)      │
│  collapsible) │                                              │
│               │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

- The chat panel keeps its existing placement preference and collapse
  behavior.
- The main area shows either the Flow canvas or the Workbench of one Scene,
  with a breadcrumb (`Canvas › Case archive`) to return, as the current
  editor does.
- The **Project ▾** menu holds **Screen size**, **Variables**, **Export**,
  and **Show technical details**. **Home** returns
  to the project list. **Playtest** opens the real Runtime; the chat toggle
  and **Publish** follow it.

### Technical details

The editor hides engine details by default. **Show technical details** in
the Project ▾ menu reveals IDs, file paths, raw Variable values, the Playtest
**History** (back stack) and **State**, and the **Code** tab. The setting is shared by
every editor window.

## Flow canvas

The canvas answers one question: how can the player move through the
project?

Each Scene card shows:

- a live thumbnail of the Scene, rendered by the Runtime, so the canvas looks
  like the game rather than like a diagram;
- the Scene title;
- one output port per Exit, labeled with the Exit name (Signal label) and,
  when the Exit depends on progress, its condition in small text
  ([Variables](#variables));
- a **Start** badge on the Scene the player starts in (**Set as Start**
  moves it);
- an issue marker when the Scene fails to build, emits an undeclared Signal,
  or has an Exit that goes nowhere.

The canvas shows only Scenes. A top bar shown on several Scenes adds its
Exits to each of those Scene cards; there is no separate card for it.

A connection links an Exit port to a target Scene. Exits with **Allow Back**
(`push` edges) are drawn differently from ordinary ones (`replace`).

Connections always leave an Exit on the right of its Scene and enter the
target on the left. An Exit marked **Navigation** is a way around the game
rather than a step in the story, such as a **Home** Exit on many Scenes. It
has no line; its Exit row names the target instead, such as `→ Platform`.
Clicking that label selects the connection and opens the connection panel.
The author turns **Navigation** on or off there or in the Workbench's Exits;
the agent sets it for Exits that come from a shared component. It only
changes how the canvas draws the connection, never where the Exit goes.

The canvas keeps the current editor's mature interactions: Add Scene menu,
context menu, selection, alignment guides, copy and paste, zoom controls,
and fit view.

Connecting can happen two ways, and both produce the same edges:

- drag from an Exit port to a Scene;
- ask the Agent, for example "connect Start to the lobby, and let Archive
  open the case archive with Back allowed".

## Creating a Scene

1. The author chooses **Add Scene** on the canvas.
2. Under **Start from a template** they pick a Template (Blank, Main menu,
   Cinematic scene, Dialogue choice, Archive, Investigation, Ending) or write
   a short description.
3. The Scene appears on the canvas with working starter content, and the
   Workbench opens.
4. The chat is focused with the new Scene as context, ready for "make this
   the Ash Club start screen, with a dark stone background and four entries".

A Template (Preset) is starter content plus instructions for the Agent. It is
not stored as a type, and a Scene created from "Main menu" can later become
anything.

## Scene Workbench

Opening a Scene shows its Workbench: a live preview that fills the page, with
a tool bar, short messages, and popovers floating over it. Every Scene gets
the same Workbench. There is no inspector: the Agent changes the Scene, the author
points at, edits, or draws on the preview to say what to change, and
**Open code** is the way to read it.

```text
┌──────────────────────────────────────────────────────────────┐
│ Scenes / [Title]                      Replay · Play from here │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│               ( Would open Club lobby  [Open] )              │
│                                                              │
│                        Live preview                          │
│                  (real Runtime, real assets)                 │
│                                                              │
│      ┌──────────────────────────────────┐ ┌──────────┐       │
│      │ ▶ Play · ⌖ Select · T Text · ✎ Draw │ │ 2 issues │       │
│      └──────────────────────────────────┘ └──────────┘       │
└──────────────────────────────────────────────────────────────┘
```

The title is edited in place in the breadcrumb (Enter keeps it, Esc reverts).

### Live preview

The preview runs the Scene in the real Node Runtime. It is interactive:
clicking "进入俱乐部" in the preview takes the `enter-club` Exit. Instead of
leaving the Scene, a short message over the preview says where it would go,
such as "Would open Club lobby", with **Open** to go there; it fades after a
few seconds. Back, Replay, and Continue show the same way.

The header offers:

- **Replay** to play the Scene again from the start;
- **Play from here** to open Playtest at this Scene.

Both start from a new game, so every Scene must look right without earlier
progress. To see a Scene as it would be later in the game, play there in
Playtest or ask the Agent to show it.

### Preview tools

The tool bar at the bottom of the preview decides what the pointer does. Esc
always returns to **Play**.

- **Play** plays the Scene.
- **Select** picks an element for the chat; the picks show as chips in the
  composer. Shift-, ⌘- or Ctrl-click picks more, or removes one already
  picked. A picked image or video gets a small bar next to it to replace it
  from the Library, by uploading a file, or by asking the Agent to generate
  one; the asset is declared on the Scene and the Agent is asked to
  show it there.
- **Text** edits text in place. Enter keeps the change, Esc discards it.
  When the element was written in the Scene's HTML and holds only text, the
  change is written straight to that file, an Exit whose name was that text
  is renamed too, and a short message confirms it. Otherwise (text set by a
  script, or mixed content) the change is sent to the Agent, and the chat
  shows it working.
- **Draw** draws freehand over the preview. The drawing is sent with the next
  chat message, on a screenshot of the preview.

There is no comment tool: saying what to change in the chat, with picks or a
drawing attached, does the same job.

### Issues

Nothing shows while the Scene is fine. When it has problems, an **N issues**
badge appears beside the tool bar; it opens a list of the Scene's issues,
errors from the preview, and Exits that go nowhere, each Exit with
**Connect…** and **Ask AI to create it**.

There are no type-specific forms. What used to be a Choice's options or a
Scene's duration now lives in the Scene's own content and is changed by
describing the change.

### Talking to the Agent about a Scene

When a Scene is open, the composer shows it as a chip, and the next message
carries it as context: its ID, source files, Signals and their targets, and
declared assets. Each element picked with **Select** adds a chip, and a
drawing adds one more. The message carries their descriptions and one
screenshot of the preview with the picks outlined and the drawing on it.
Removing a chip leaves it out of the message; the chips clear once sent. The
conversation shows only the chip labels; the Agent receives the full context.
The Agent edits the Scene's files; the preview reloads when the change is
saved; new or removed Exits appear on the canvas immediately, and an Exit
that goes nowhere shows up under the issues badge.

Typical requests:

- "Make the right page an index of three cases; choosing one changes the left
  page."
- "Show the number of completed rounds on the left page."
- Picking "打开博弈笔记" and saying "this should lead to a new notes
  Scene".
- Picking a title and saying "use the pixel typeface from the main
  menu".

Small edits use the same loop. Direct text editing inside the preview is a
possible later improvement, not a v1 requirement.

### Code, when it is really needed

The Workbench overflow menu contains **Open code**, which opens the Scene's
files in the **Code** tab. The Code tab appears only with technical details
shown; it is not part of the Workbench and it is never the default view.

## Project Style

The Project Style is the project's shared visual language: the tokens in
`shared/style/theme.css`, the classes in `components.css`, and the behaviour
in `components.js`. It is stored as ordinary shared source files that every
Scene imports. The editor has no Style panel: a read-only view could not
change anything, so the style is changed in conversation, or in those files
from the Code view with technical details on.

- The Agent reads and uses the Project Style whenever it builds a Scene.
- Authors can change the style through conversation ("make the whole game
  warmer, like lamp light on old paper").
- Changing the style updates every Scene that uses it.

Project Style is how two different screens, such as the Ash Club menu and
archive, stay recognizably part of one game.

## UI on many Scenes

UI that appears on several Scenes, such as the Ash Club top bar or a **Home**
button, is a shared component (`shared/components/`). The author asks for it
in chat ("add a Home button to every chapter Scene"), and the Agent writes the
component once and imports it into each Scene that should show it.

Its buttons are that Scene's own Exits. They appear on the Scene's card and in
its Workbench, and are connected like any other Exit, so **Home** can lead to
the menu from one Scene and to the chapter list from another. A Scene that
does not import the component does not show it. There is no layer over every
Scene and nothing extra on the canvas; anything that must carry over between
Scenes, such as a score, is remembered by the game.

## Variables

A Variable is something the game remembers from Scene to Scene and keeps in
the save, such as a trust score or the items the player carries. Progress
inside one Scene, such as which hotspots were clicked, stays in that Scene;
content such as item definitions lives in shared code.

The author asks for them in chat ("a trust of three or more leads to the
good ending"), and the Agent adds each one with a starting value and a
one-line description. **Project ▾ → Variables** lists them read-only:

```text
Variables                                         ×
What the game remembers from Scene to Scene...
  trust          How much the guard trusts you   Starts 0
  inventory      What the player carries         Starts empty
  boarded        Whether the player boarded      Starts No
Ask the AI to add or change them.
```

Starting values read in author words (Yes/No, empty, "3 items"); technical
details add the raw value. There is no form to add, delete, or edit them.

A branch shows as Exits. A Scene that goes different ways declares one Exit
per outcome, and the Agent writes when each is taken. The canvas shows it on
the Exit row:

```text
Final talk
  ├─ Trusted ending    if trust is 3 or more   → Good ending
  └─ Not enough trust  if trust is below 3     → Bad ending
```

The condition is a description (Signal `when`), not a rule the editor runs:
the Scene decides which Exit to take, and the Agent updates the words when it
changes the logic. There are no Condition or Update State Scenes. Playtest
shows what the game remembers with technical details, for when a branch goes
the wrong way.

## Playtest

Playtest runs the real Runtime from the saved game or the Start Scene, or
from a chosen Scene with a new game (**Play from here** in a
Workbench). A chosen start runs without saving, so the saved game is
untouched. It keeps the current Playtest entry point and adds a compact
debug drawer, which collapses to a pill showing the current Scene and the
error count:

- current Scene, with **Open in editor**, which focuses the editor window and
  opens that Scene's Workbench;
- **History** (back stack), with technical details;
- Exits taken and where they led;
- **State** changes and values, with technical details;
- Runtime and build errors;
- **Play from a Scene…**.

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
- With Agent-first authoring, the Agent can find or generate the media a
  Scene needs, so the author does not need both on one canvas.

Separation must not make the authoring loop longer. Three bridges keep it
short:

1. **One Asset Library with stable project Asset IDs.** Asset Canvas results
   enter the Library. A project Asset ID such as `club-background` points at
   one Library asset, and Scenes use only the project Asset ID. **Replace**
   re-points that ID at a better Library asset, which updates every Scene that
   uses it without changing code.
2. **Media from the Workbench.** A picked image or video can be replaced from
   the Library, by upload, or by asking the Agent for a single generation.
   Complex generation opens the asset in Asset Canvas and returns to the Scene
   afterwards.
3. **Where used.** Asset Canvas can show which Scenes use an asset. This can
   come after v1.

If real use shows authors constantly switching between the two workspaces,
an asset side panel on the Flow canvas can be reconsidered then.

## Reuse from the current editor

| Current editor part                                   | In Playable Nodes                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Workspace header, chat placement, breadcrumb          | Keep                                                                  |
| Flow canvas interactions (menu, guides, clipboard)    | Keep, with one Scene card and Exit ports                              |
| `NodeWorkbenchLayout` (preview, inspector, resizing)  | Story editor only; Scenes use a preview-only Workbench with tools     |
| Library asset picker and upload                       | Keep, to replace a picked image or video                              |
| Playtest entry point                                  | Keep, driven by the Node Runtime, with the debug drawer               |
| Variables dialog                                      | Read-only list in Project ▾; the Agent adds and changes Variables     |
| Story issue banners                                   | Become Scene issue markers and validation messages                    |
| Per-type forms (Open UI, Scene, Choice, Ending, …)    | Remove; replaced by conversation and Scene content                    |
| Condition and Update State nodes                      | Remove; Scenes read State and take distinct Exits                     |
| Story Map and Settings system nodes                   | Remove; ordinary Scenes and shared components                         |
| Text, Image, Video, and 3D generation nodes           | Stay in Asset Canvas only                                             |

The detailed inventory and PR order belong in `roadmap.md`.

## Design decisions

### Templates

v1 ships seven Templates (Presets). Each contains starter source that
already uses the Project Style, its expected Signals, and a short brief that
tells the Agent what the author usually wants next.

| Template         | Starter content                                                  | Starter Signals        |
| ---------------- | ---------------------------------------------------------------- | ---------------------- |
| Blank            | An empty full-screen stage                                       | none                   |
| Main menu        | Title, subtitle, a list of entries, background image slot        | `start`                |
| Cinematic scene  | Full-screen video with skip; advances when the video ends        | `next`                 |
| Dialogue choice  | Background, speaker line, and options that can read State        | `option-a`, `option-b` |
| Archive          | A book or folder with an index that changes the visible page     | `leave`                |
| Investigation    | An image with hotspots that record findings in State             | `done`                 |
| Ending           | Ending title and text, replay and return-to-menu actions         | none                   |

Starter Signals are ordinary declared Signals; the author or Agent renames
and adds them freely. QTE and other small games start from Blank plus a
description; they are too varied for one useful starting point.

Templates live in OhMyGame, not in projects. Creating a Scene copies the
Template's source into `nodes/<id>/`; later Template changes do not affect
existing Scenes.

### Scene thumbnails

Thumbnails are screenshots of the real Scene, never a separate rendering.

- The canvas captures every Scene that has no thumbnail, or one of an older
  build, without it being opened: the desktop app runs the Scene in a hidden
  window, one Scene at a time, as the Workbench preview runs it.
- The Scene is captured through the desktop `capturePage` capability, the
  same mechanism that captures Web Game project covers, about one second
  after it reports ready. A run with errors is not captured. Captures keep
  the display's pixel density, up to 1280 pixels wide.
- Thumbnails are editor cache stored under `.ohmygame/thumbnails/` in the
  workspace. They are not part of `graph.json`, `editor/layout.json`, or the
  published project.
- A thumbnail records the hash of the Scene's compiled output. When the source
  changes, the card keeps the old image with a *stale* marker until the next
  capture replaces it.
- A Scene that has no thumbnail yet, or whose run fails, shows its first
  declared image asset, or a neutral card with its title.
- A Scene that fails to build shows its last good thumbnail dimmed with an
  error marker; opening it shows the error in the Workbench.
- When the capture capability is unavailable (for example in the browser
  development build), the canvas uses the same fallbacks.

The same capture is attached to Agent requests about that Scene.

### Element picking and text editing

Picking (**Select**) and in-place editing (**Text**) are editor tooling
implemented by the sandbox host, not by node code, and they are disabled in
the Published Player.

1. **Select** or **Text** puts the preview into pick mode. The sandbox host
   draws a hover outline inside the node's surface and blocks node input.
2. With **Select**, clicking returns a **picked element** description: node
   ID, source location when known, CSS path within the node root, tag,
   visible text excerpt, bounding box, and the Exit (`data-signal`) it
   belongs to. Shift-, ⌘- or Ctrl-click adds it to the picks.
3. Preview builds add an inert `data-ohmygame-source="index.html:12:5"`
   attribute to every element written in the node's HTML. Elements created by
   JavaScript have no such attribute; the description then relies on text,
   path, and screenshot, and the Agent finds the element in source.
4. With **Text**, clicking makes the element editable. On Enter the host
   reports the text before and after, and whether the element holds only text
   and came from the node's HTML. The editor then replaces that element's
   text in the source file, only if the file still reads the old text;
   anything else goes to the Agent.
5. Picks and a drawing appear as chips in the chat composer and are sent with
   the next message together with one screenshot of the preview. The chips
   clear once sent.

### Cinematic scenes

"Advance when the video ends" is Scene content, not a Runtime feature. The
Project Style includes a small `playCinematic()` component that plays a
declared video, offers skip, and emits a given Signal when the video ends or
is skipped. The Cinematic scene Template uses it. Authors who want something
else (a choice over the last frame, a loop until input) change the Scene like
any other.

This keeps the Runtime free of media-ended and timer transitions while the
most common interactive-film case needs no code.

### Multi-node Agent changes

The Agent may create several Scenes and Exits in one turn. Turn
review below comes after the MVP
([roadmap](roadmap.md#after-the-mvp)).

- Before each Agent turn, the editor records a checkpoint of `graph.json`,
  `editor/layout.json`, and the node and `shared/` source files.
- After the turn, the canvas highlights the change set: new Scenes and
  connections marked **New**, changed Scenes marked **Edited**, removed ones
  listed in a
  summary bar.
- The summary bar offers **Keep** and **Undo turn**. Undo restores the
  checkpoint. Continuing to edit implicitly keeps the change.
- New Scenes without a position in `editor/layout.json` are placed by the
  editor to the right of the Scene whose Exit leads to them, avoiding
  overlaps. The Agent does not need to compute layout.

### Asset versions

The project has no separate version concept. A project Asset ID points at
exactly one Library asset. Choosing a better image means pointing that
project Asset ID at a different Library asset with **Replace**.

- Scenes that should change together share one project Asset ID.
- A Scene that must keep an image while others change uses a different
  project Asset ID, for example `club-background-night`.

This gives both "update everywhere" and "keep this one" without a pinning
system.
