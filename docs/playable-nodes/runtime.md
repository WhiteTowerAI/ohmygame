# Runtime

This document is the contract between node content and the Node Runtime.

## Scope

The Runtime owns everything that must survive a node:

- Project State;
- navigation and the back stack;
- asset resolution;
- the save, save slots, and each Node's position;
- music and sounds;
- the player's preferences;
- what the player has seen, for the Story Map;
- node lifecycle and loading each node's files.

Nodes own presentation and input. The Runtime never renders node content, and
nodes never own authoritative state or choose the next node.

An Interactive Story is a **web story**: it plays as its own page. The
project's `index.html` loads the Runtime from `story/`, which reads
`graph.json` and loads each node's files as they are. The editor preview,
Playtest, game_use, and the published game all open that page through the
project preview or as static files. Editor tooling (preview policy, element
picking, capture, diagnostics) is injected by the preview and never changes
what node code sees, and never ships with the game.

Stories made before web stories play the same Runtime in OhMyGame's sandbox
until the author upgrades them; see [Sandboxed stories](#sandboxed-stories).

## Project files

```text
index.html              the page that plays the story
story/                  the story runtime: readable modules, project code
story/manifest.json     the runtime version OhMyGame wrote, and each file's hash
graph.json              runtime graph and dependency manifest
nodes/<id>/             index.html, style.css, node.js for each node, and the node's own files
shared/                 ordinary modules imported by more than one node
shared/components/      UI shown on more than one node, such as a top bar
shared/style/           Project Style: theme and components
editor/layout.json      editor-only positions and canvas viewport
schemas/                JSON Schemas for graph.json and editor/layout.json
AGENTS.md, README.md    rules and reference for the Agent and authors
.ohmygame/              editor cache (thumbnails, newer runtime files); never published
```

A new project is a web story with the default Project Style and no nodes; the author
starts from a Template or the Agent from the author's description. A project
with no nodes, new or after the author deletes them all, is a valid draft:
`entryNodeId` then names nothing, and the first node added becomes the Entry
Node.

Creating a project in an existing folder adds only the files the folder does
not have and never overwrites one. A folder that already holds `graph.json`,
such as the workspace of a removed project, opens as that project with its own
graph and nodes; if they need repair, the editor reports it.

## Graph document

`graph.json` contains only runtime meaning:

```json
{
  "version": 1,
  "title": "Ash Club",
  "viewport": { "width": 1920, "height": 1080 },
  "entryNodeId": "main-menu",
  "initialState": { "roundsCompleted": 0, "foundClues": [] },
  "assets": {
    "club-background": {
      "type": "image",
      "source": { "kind": "library", "assetId": "lib_8f2c…" }
    },
    "archive-desk": {
      "type": "image",
      "source": { "kind": "workspace", "path": "assets/archive-desk.webp" }
    }
  },
  "nodes": [
    {
      "id": "main-menu",
      "title": "Main menu",
      "source": {
        "html": "nodes/main-menu/index.html",
        "css": "nodes/main-menu/style.css",
        "javascript": "nodes/main-menu/node.js"
      },
      "assets": ["club-background"],
      "signals": [
        { "id": "enter-club", "label": "进入俱乐部" },
        { "id": "open-archive", "label": "查看旧案" }
      ]
    },
    {
      "id": "archive",
      "title": "Archive",
      "source": {
        "html": "nodes/archive/index.html",
        "css": "nodes/archive/style.css",
        "javascript": "nodes/archive/node.js"
      },
      "assets": ["archive-desk"],
      "signals": [
        { "id": "home", "label": "首页", "role": "navigation" },
        { "id": "rules", "label": "规则" }
      ]
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": { "nodeId": "main-menu", "signal": "enter-club" },
      "targetNodeId": "game-lobby",
      "mode": "replace"
    },
    {
      "id": "e2",
      "source": { "nodeId": "main-menu", "signal": "open-archive" },
      "targetNodeId": "archive",
      "mode": "push"
    },
    {
      "id": "e3",
      "source": { "nodeId": "archive", "signal": "home" },
      "targetNodeId": "main-menu",
      "mode": "replace"
    },
    {
      "id": "e4",
      "source": { "nodeId": "archive", "signal": "rules" },
      "targetNodeId": "game-rules",
      "mode": "push"
    }
  ]
}
```

A Signal may have `"role": "navigation"` when it is a way around the game,
such as Home, rather than a step in the story. The editor names its target
instead of drawing a line. Routing and the compiler ignore it; the Runtime
reads it only for the [save](#save-and-session) and the
[Story Map](#story-map).

A Signal may also have a `when`, one sentence saying when the node emits it,
such as `"if trust is 3 or more"`, and the graph may have `variables`, a map
from `initialState` keys to one-line descriptions. The Agent writes both and
the editor displays them. They are never executed: the node's code decides.

A node may have `story`, which says how it shows on the
[Story Map](#story-map): `hidden` keeps it off the map, `ending` overrides
the guess of whether it is an ending, and `label` is the name players see
instead of its title. The Runtime reads it only to build the map.

`viewport` is the fixed stage every node is laid out in, in
CSS pixels. Players scale the whole stage to fit, keeping its ratio, so a node
looks the same in the Workbench preview, its thumbnail, a Playtest window of
any size, and the published game.

Editor data (positions, zoom, open panels) lives in `editor/layout.json`.
Preset names are never stored.

## Node protocol

Every node exports one function:

```js
export function mount(context) {
  const open = context.root.querySelector("[data-open]");
  const onClick = async () => {
    await context.navigation.emit(
      context.state.get("hasKey") ? "door-opened" : "door-locked",
    );
  };
  open.addEventListener("click", onClick, { signal: context.lifecycle.signal });
}
```

`mount` may be async and may return a cleanup function (sync or async). The
node is revealed after `mount` settles.

```ts
interface RuntimeContext {
  root: ShadowRoot;
  assets: { url(id: string): string };
  state: {
    get(): Readonly<JsonObject>;
    get(key: string): JsonValue;
    set(key: string, value: JsonValue): Promise<void>;
    patch(values: JsonObject): Promise<void>;
    subscribe(listener: (state: Readonly<JsonObject>) => void): () => void;
  };
  position: {
    get(): JsonValue | null;
    set(value: JsonValue | null): Promise<void>;
  };
  audio: {
    music(assetId: string | null, options?: { fade?: number }): void;
    sound(assetId: string): void;
  };
  preferences: {
    get(): Readonly<JsonObject>;
    set(values: JsonObject): Promise<void>;
  };
  session: {
    hasSave(): boolean;
    save(): Promise<void>;
    continue(): Promise<void>;
    reset(): Promise<void>;
    restart(): Promise<void>;
    slots(): SlotSummary[];
    saveSlot(id: string, note?: string): Promise<void>;
    loadSlot(id: string): Promise<void>;
    deleteSlot(id: string): Promise<void>;
  };
  story: { map(): StoryMap };
  lifecycle: { signal: AbortSignal };
}

interface NodeContext extends RuntimeContext {
  navigation: {
    emit(signal: string): Promise<void>;
    back(): Promise<void>;
    connected(signal: string): boolean;
  };
}
```

Every request is validated. An undeclared asset, unknown state key, or
undeclared Signal produces a visible runtime error instead of silently doing
nothing.

A node emits only its own declared Signals or goes back, so story flow stays
visible in the graph.

## Project State

- State is a JSON object. Values are any JSON: objects, arrays, strings,
  finite numbers, booleans, and `null`.
- The top-level keys of `initialState` are the only keys. `set` and `patch`
  cannot create new top-level keys; authors and the Agent add a key by adding
  its initial value.
- `get()` returns a read-only copy. `set` replaces one top-level key; `patch`
  replaces several atomically. There is no dot-path language; nested updates
  write back a new top-level value.
- Changes are visible immediately to the active node through `subscribe`.

## Signals and edges

A Signal says what happened; an edge says where it leads.

- A node and Signal pair has at most one edge.
- Edges carry no conditions or state effects in v1. A node reads State and
  emits the Signal that fits.
- A declared Signal may be unconnected while editing. Emitting it during
  Playtest reports an error. `navigation.connected(signal)` tells a node
  whether a Signal of its own goes anywhere, so it can show the control
  disabled instead.
- Publishing requires every story Signal to be connected. A navigation
  Signal may stay unconnected, such as a Main menu's Story map entry in a
  game without a Story map, since it is a way around the game and its node
  can show it disabled.

## Navigation

- `replace` exits the current node and enters the target.
- `push` records the current node on the back stack, then enters the target.
- `back()` returns to the most recently pushed node, which mounts fresh.

The back stack stores node IDs, not live instances. Anything that must survive
leaving a node belongs in Project State.

## UI on many nodes

There is one kind of surface. UI that appears on more than one node, such as a
top bar or a **Home** button, is a shared component under `shared/components/`.
Each node that shows it imports it and passes its own `context`; the component
emits through that context, so the node declares the component's Signals and
routes them with its own edges, like any other Signal.

```js
// nodes/archive/node.js
import { mountTopBar } from "../../shared/components/top-bar.js";

export function mount(context) {
  return mountTopBar(context, ["home", "rules"]);
}
```

A node that does not import the component does not show it, and each node can
route the same Signal somewhere different. There is no layer drawn over every
node: the component mounts fresh with each node, and whatever must continue
across nodes (a score, a timer's start time, an open chapter) lives in Project
State.

## Assets

- `graph.json` maps each project Asset ID to a type (`image`, `video`,
  `audio`) and a source: a Library asset (`kind: "library"`) or a workspace
  file (`kind: "workspace"`).
- Replacing an asset re-points the project Asset ID at another source. Every
  node using the ID follows; node code does not change.
- Nodes list the Asset IDs they use. `assets.url(id)` accepts
  only those IDs.
- An asset reference is a dependency, not a layout instruction. Node code
  decides whether it is an `<img>`, a CSS background, a video, a texture, or
  anything else.

## Background video clips

A Scene may put `data-clip-start="3.2"` and `data-clip-end="8.75"` on its
single `[data-media="backdrop"][data-type="video"][data-asset]` element.
These are finite, non-negative seconds in the original Asset, not offsets
in the edited clip. Start defaults to zero; absent End means the file's
natural end. End must exceed Start. The editor writes millisecond precision
and requires at least 0.1 seconds (or the entire file if it is shorter).
Malformed attributes, image clips and multiple backgrounds with a clip
are compile errors in both draft and publish builds.

The shared surface host observes videos created inside this background, before
calling authored `mount()`. It seeks to Start after metadata loads and
pauses at End, displaying a frame just inside the selected range. It sends
one ordinary `ended` event for an early end; Scene code still decides which
Signal to emit, if any. A video with `loop` loops inside the range instead.
The controller is removed on lifecycle abort, destroy, or failed mount.
Videos without these attributes retain their existing playback behavior.

End beyond the real duration is clamped. Start outside the real duration
reports a diagnostic once and falls back to playing the complete file.
Paused authoring seeks can inspect the entire original video; the next play
respects the clip. Clips do not add State, alter graph signatures, modify
Assets or require migration of user-authored shared helpers. Published
packages still contain the original video bytes. The same controller runs in
web stories and legacy sandboxed stories. Web stories receive it through the
normal manifest-aware runtime update; customized runtime files remain pending
for the author to merge, rather than being overwritten.

## Page and lifecycle

```text
index.html (the project preview, Playtest, or the published game)
└── story/story-web/runtime.js
    ├── Node Runtime
    └── stage, scaled to fit the window
        └── ShadowRoot → current node surface
```

- The page fetches `graph.json`, starts at `?scene=<id>` or the Entry Node,
  and keeps the stage at the project viewport, scaled to fit.
- Mounting a node fetches its HTML into a new `ShadowRoot`, links its
  stylesheet, and imports its module as a browser module, with a fresh query
  each mount so module-level variables start fresh. Its imports and stylesheet
  imports resolve like any page's; there is no bundler, so a node imports
  project files by relative path, fetches text files with
  `new URL("./script.txt", import.meta.url)`, and imports JSON with
  `with { type: "json" }`.
- Saves, slots, what was seen, and preferences are kept in the page's
  `localStorage`, under the story ID in `index.html`'s
  `<meta name="ohmygame-story">`, so they last when the game moves to a new
  address, as each itch.io upload does. A page without one uses its path. Node code runs with the page's full browser abilities,
  storage included, and may keep what belongs to the player across games
  there; a game's progress belongs in State and positions.
- Successive nodes share one JavaScript realm; `window`, `document` listeners,
  and globals are not isolated between surfaces. Node code must use
  `context.root`, cleanup, and `lifecycle.signal`.

The page reads a few query parameters: `scene`; `ohmygame-policy=report`
(the Workbench preview); `ohmygame-save=none` (keep this session's games in
memory, for Play from here); `ohmygame-new-game=1` and
`ohmygame-forget-seen=1` (Playtest's Replay and its seen reset);
`ohmygame-silent=1` (thumbnails); and `ohmygamePlaytest=1`, which exposes
`window.__OHMYGAME_PLAYTEST__` for game_use. Editor tools find the Runtime as
`window.__OHMYGAME_STORY__`.

On a node transition the Runtime:

1. rejects further navigation from the exiting node;
2. aborts its lifecycle signal and awaits its cleanup;
3. removes its ShadowRoot host;
4. updates the back stack and checkpoints the save;
5. creates a new ShadowRoot with the target's HTML and stylesheet;
6. imports the target's module;
7. calls `mount(context)` and reveals the node when it settles.

A startup or mount failure unmounts the node and puts the
Runtime in an explicit failed state.

### The story runtime in the project

`story/` is project code, written by OhMyGame from its own Runtime source as
one readable module per source file, comments kept. The Agent may change it.
`story/manifest.json` records the runtime version and each file as written.
When a web story opens in a newer OhMyGame, files nobody changed are
replaced by the newer runtime's, files the runtime dropped are removed, and
files the author or Agent changed stay: the newer file goes under
`.ohmygame/story-runtime/<version>/` and the manifest lists it as `pending`
for the Agent to merge.

### Sandboxed stories

A story without `index.html` and `story/` plays in OhMyGame's sandbox: an
iframe with exactly `sandbox="allow-scripts"`, an opaque origin, and a CSP
that denies network. The Runtime there talks to its host by messages, and the
compiler bundles each node into one module. The Story editor offers
**Upgrade**, which takes a checkpoint, copies the Library assets the story
uses into `assets/library/`, rewrites imports a browser cannot load,
adds `index.html` and `story/`, and replaces `AGENTS.md` and `README.md` if
they are still as OhMyGame wrote them. **Undo upgrade** takes back the files
changed between the two checkpoints.

## Save and session

The save is the game the player is in, written as they play:

```json
{
  "version": 1,
  "graphVersion": 1,
  "graphSignature": "…",
  "savedAt": "…",
  "currentNodeId": "chapter-2",
  "backStack": ["main-menu"],
  "state": {},
  "position": { "script": "9f3c…", "step": 14 },
  "backPositions": [null],
  "music": "rain-theme"
}
```

`position`, `backPositions`, and `music` are left out when there are none.
A save written before they existed continues with no positions and no
music, and one whose music is no longer an audio Asset of the graph
continues without it.

- The Runtime checkpoints after every successful navigation and committed
  state change; writes may be debounced. `session.save()` flushes.
- A navigation Signal is a way around the game, so following one does not
  checkpoint, and neither does going Back to where the player took it: the
  save keeps where they left the story. Home then Continue returns there,
  and looking at the Story map from a menu leaves a saved game as it was.
- `reset()` restores `initialState` and clears the back stack without
  leaving the current node. A menu starts a new game with `reset()` then its
  `start` Signal.
- `restart()` resets and enters `entryNodeId`.
- `continue()` restores the save. `graphVersion` is the graph's `version`,
  and `graphSignature` hashes `graph.json`, so a code-only edit keeps the
  save. A save whose graph version or signature no longer matches is
  reported as incompatible (`save.incompatible`) rather than loaded partially.

### Position

`context.position` is where the player is inside the current Node, as JSON
the Node chooses, such as the line a script is on. Setting it checkpoints the
save, so Continue and a loaded slot mount the Node with it, and the Node picks
up there. A Node entered by a Signal starts with `null`. A `push` keeps the
Node's position on the back stack, and `back()` restores it. `reset()` and
`restart()` clear every position. A position is at most 64 KiB of JSON.

The graph signature changes only with `graph.json`, so a save survives an
edit to a Node's code or files. A Node whose position can go stale, such as a
script that changed, recognizes that and starts over.

### Slots

Besides the save, the player can keep games in slots. `saveSlot(id, note)`
copies the game into a slot (1 to 40 letters, digits, `-`, or `_`), with an
optional note of up to 200 characters such as the current line; while the
player is away from the story through a navigation Signal, it copies where
the story is, as the save does. `loadSlot(id)` continues that game like
`continue()`, which also moves the save there. `slots()` lists them in ID
order with `savedAt`, `nodeId`, and the note; a slot from another version of
the graph is listed `incompatible` and cannot be loaded. A game keeps at most
100 slots. Hosts keep them all together beside the save (`<saveKey>:slots`),
and a write keeps slots this version cannot read.

## Music and sound

`context.audio.music(assetId)` fades to the music over `fade` seconds (1 by
default) and keeps it playing across Nodes until a Node changes it;
`music(null)` fades it out. Asking for the music already playing leaves it
playing. The Asset must be declared by the Node that starts it. The music is
kept with the save, so Continue and a loaded slot bring it back, and
`restart()` stops it. `sound(assetId)` plays an Asset once.

While a Node's own `<video>` or `<audio>` plays with sound, such as a
cinematic Scene's background, the music turns down to a quarter and comes
back when it stops. The sandbox listens for that on each Node's ShadowRoot,
so it needs nothing from Node code. Node media plays at the sound volume.

Where the browser will not start sound before the player touches the page,
music starts at their first click or key. A preview built for thumbnails
plays nothing.

## Preferences

`context.preferences` holds the player's settings. Like what the player has
seen, they are kept apart from the save and outlast new games and restarts.
`get()` returns the stored values over the defaults, `musicVolume: 0.7` and
`soundVolume: 1`; `set(values)` changes only the given keys. The Runtime reads
`musicVolume` and `soundVolume` (numbers from 0 to 1) for its volumes; any
other key, such as a text speed, belongs to the project. Settings are at most
64 KiB of JSON, and settings that cannot be read start over. Hosts keep them
beside what the player has seen (`<saveKey>:preferences`).

## Story Map

Besides the save, the Runtime keeps what the player has **seen**: when
each node was first entered and each edge first taken. It lasts across new
games, `reset()`, `restart()`, and graph edits, since it is kept by ID, apart
from the save; IDs no longer in the graph are ignored. Only play adds to it,
not the `report` preview policy. Losing it never stops the game: a record
that cannot be read starts over, and a failed write is reported once.

`context.story.map()` returns the story laid out for a player to see, with
what they have seen:

```ts
interface StoryMap {
  nodes: { id: string; label: string; row: number; column: number; rowSize: number; ending: boolean; seen: boolean }[];
  edges: { from: string; to: string; seen: boolean }[];
}
```

The layout comes from the graph alone, never from editor positions, so it
holds at any screen size and arranging the canvas does not change it:

- A step in the story is a `replace` edge from a Signal that is not
  navigation. A `push` target is on the map only when the story reaches it
  some other way.
- Nodes with `story.hidden` are left out, and the steps through them joined.
  When the Entry Node is hidden, the map starts at the nodes it leads to.
- Steps back to a node already above, such as a retry, are left out, so the
  map reads downwards.
- Each node sits one row below the lowest node that leads to it, and each
  row is ordered by where those nodes sit. `column` counts from the left of
  its row of `rowSize` nodes.
- A node is an ending when `story.ending` says so, or else when every Signal
  it declares is navigation.
- An edge is seen when the first graph edge of its step was taken and its
  target was seen.

The Story map Template draws the map. Which Scenes it shows, locked or not,
is its own code.

## Host tooling

These capabilities exist for the editor and the Agent. Node code cannot see
or call them, and a published game does not enable them. The Published
Player exposes the playtest bridge only for a draft built for `game_use`.

### Preview policy

The Runtime accepts a navigation policy:

- `follow` (Playtest and Published Player): Signals navigate.
- `report` (Workbench preview): a Signal is validated and reported to the host
  with the edge it would follow, and the node stays mounted. `back()`,
  `restart()`, and `continue()` are reported the same way. Report kinds are
  `signal`, `back`, `restart`, and `continue`. Nothing it previews adds to
  what the player has seen, and `story.map()` shows every node and edge as
  seen, so the author previews the whole map.

The Workbench preview may also start with a **preview state**: `initialState`
with author-chosen overrides, validated against the declared keys.

### Diagnostics snapshot

The Runtime publishes a serializable snapshot to the host:

```json
{
  "status": "running",
  "policy": "follow",
  "currentNodeId": "archive",
  "backStack": ["main-menu"],
  "state": {},
  "recentSignals": [
    {
      "nodeId": "main-menu",
      "signal": "open-archive",
      "edgeId": "e2",
      "at": "…"
    }
  ],
  "reports": [],
  "stateAccess": { "archive": { "read": ["roundsCompleted"], "wrote": [] } },
  "errors": [
    { "nodeId": "archive", "code": "undeclared-asset", "message": "…" }
  ],
  "save": { "present": true, "savedAt": "…" },
  "position": null,
  "music": "rain-theme"
}
```

`recentSignals`, `reports`, and `errors` are bounded histories. `reports`
holds what the `report` [preview policy](#preview-policy) reported, and stays
empty under `follow`. `stateAccess` powers the
Workbench's "State used" section; calling `get()` without a key records
`"*"`.

### Editor bridge, element picking, and capture

For an Interactive Story, the preview proxy injects an editor bridge into
every page it serves and annotates node HTML the page fetches with an inert
`data-ohmygame-source` attribute on each element. In a page the editor opened,
the bridge speaks the same messages as the sandbox: snapshots, reports,
diagnostics, element picking and text editing as defined in
[authoring.md](authoring.md#element-picking-text-editing-and-moving), and the
background video's timeline. None of it is in the project or a published
game. Node code may mark text it shows from a file of its own the same way,
pointing at where the text starts on its line, as the Visual Novel player does
for script lines. Capture uses the desktop host's page capture of the preview
frame, for thumbnails too.

## Compiler

A web story's page loads node files as they are; the compiler still builds
each node to check it and to report issues in the editor. For sandboxed
stories it turns the validated graph and workspace into one self-contained
JavaScript module and stylesheet per node.

- HTML stays authored markup.
- JavaScript and CSS are bundled, so `shared/` modules and the project's own
  `node_modules` work without a per-node build.
- Every entry and import must resolve inside the workspace after following
  symbolic links. Dependencies found in OhMyGame's installation or a parent
  directory are rejected.
- Imported images, fonts, shaders, and binary modules are embedded in the
  surface bundle. Project Assets used through `context.assets` stay governed
  by the graph.
- The result records the input files used by each surface for error reporting
  and incremental rebuilds.
- Preview builds add source-location attributes; publish builds do not.

Codebase updates from the editor are applied under one workspace lock and
rolled back as a whole if any write fails.

## Validation

Validation runs in `draft` mode for editing and Playtest and `publish` mode
for publishing. Each issue has a stable `code`, a JSON Pointer `path`, and an
actionable `message`. It checks that:

- IDs are non-empty and unique in their scope;
- `entryNodeId` and edge targets exist; with no nodes, draft accepts the
  project and publish asks for a node;
- every edge starts at a declared Signal of a node, with at most one edge per
  pair;
- every node asset dependency exists in `assets`;
- source and asset paths are relative and stay inside the workspace;
- referenced files exist;
- `initialState` is a JSON object;
- every key in `variables` exists in `initialState`;
- modes are only `replace` and `push`;
- in `publish` mode, every declared Signal other than navigation ones has an
  edge.

Limits: 500 nodes, 2,000 edges, 1,000 assets, 100 Signals per node, 500 asset dependencies per surface, 5 MiB per source file, and
16 MiB per compiled surface.

## Publishing

A web story publishes as its own page. Publishing validates in `publish`
mode, then packages `index.html`, `story/` (without its manifest),
`graph.json`, `nodes/`, `shared/`, the assets `graph.json` declares, and
other files under `assets/` that the story's code names by path. Editor
files, schemas, the editor cache, and unused assets stay out. An asset still
in the Library is refused; upgrading copies Library assets into the project.
The same static directory is the HTML zip for itch.io and the like.

A sandboxed story publishes as before: publishing validates in `publish`
mode, compiles the same definition used by Playtest, and writes a static
directory with the Player, sandbox, `playable.json`, `manifest.json`, and the
declared assets.

- Assets are stored by SHA-256 content hash; identical bytes share one file
  while keeping separate Asset IDs.
- The manifest records the definition's integrity and each asset's path,
  type, content type, size, and integrity.
- The Daemon reads the directory back and verifies it before archiving. The
  Published Player repeats the checks before starting and fails explicitly on
  any mismatch.
- Editor layout, source files, thumbnails, Library paths, and workspace
  metadata are never published.

## Deferred

These fit the model but are not in v1:

- executable conditions, priorities, and state effects on edges;
- overlays and suspended node instances;
- multiple simultaneous node regions;
- automatic media-ended or timer transitions in the Runtime;
- Subflows and a visual component tree;
- a save management UI in the editor, and slot thumbnails;
- a typed state schema;
- voice and more than one music channel;
- stronger per-surface JavaScript isolation.

Each should extend Node, Signal, State, and Runtime boundaries rather than
add node categories.
