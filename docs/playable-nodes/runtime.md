# Runtime

This document is the contract between node content and the Node Runtime.

## Scope

The Runtime owns everything that must survive a node:

- Project State;
- navigation and the back stack;
- asset resolution;
- the save slot;
- what the player has seen, for the Story Map;
- node lifecycle;
- the sandbox that hosts node code.

Nodes own presentation and input. The Runtime never renders node content, and
nodes never own authoritative state or choose the next node.

The editor preview, Playtest, and the Published Player use the same Runtime,
graph, and compiled surfaces. Editor tooling (preview policy, element picking,
capture, diagnostics) is layered on by the host and never changes what node
code sees.

## Project files

```text
graph.json              runtime graph and dependency manifest
nodes/<id>/             index.html, style.css, node.js for each node
shared/                 ordinary modules imported by more than one node
shared/components/      UI shown on more than one node, such as a top bar
shared/style/           Project Style: theme and components
editor/layout.json      editor-only positions and canvas viewport
schemas/                JSON Schemas for graph.json and editor/layout.json
AGENTS.md, README.md    rules and reference for the Agent and authors
.ohmygame/              editor cache (thumbnails); never published
```

A new project contains the default Project Style and no nodes; the author
starts from a Template or the Agent from the author's description. A project
with no nodes, new or after the author deletes them all, is a valid draft:
`entryNodeId` then names nothing, and the first node added becomes the Entry
Node.

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
instead of drawing a line. The Runtime, routing, and compiler ignore it.

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
  session: {
    hasSave(): boolean;
    save(): Promise<void>;
    continue(): Promise<void>;
    reset(): Promise<void>;
    restart(): Promise<void>;
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

## Sandbox and lifecycle

One Player instance runs one sandbox:

```text
Player host (editor, Playtest, or Published Player)
└── iframe sandbox="allow-scripts"   (opaque origin, strict CSP)
    └── sandbox document
        ├── Node Runtime
        └── Node layer    → ShadowRoot → current node surface
```

- The iframe has exactly `sandbox="allow-scripts"`; it never gets
  `allow-same-origin`. The CSP denies network, objects, forms, and base URLs,
  and allows only the data/blob media and inline styles compiled surfaces
  need.
- The Runtime lives inside the sandbox and talks to the host only by
  messages: initialization with the compiled definition and asset bytes, save
  requests, snapshots, and diagnostics.
- Each surface gets its own `ShadowRoot`, so markup and CSS are scoped.
- Each mount imports the node's compiled module from a fresh blob URL, so
  module-level variables start fresh on every mount.
- Successive nodes share one JavaScript realm. `window`, `document`
  listeners, and globals are not isolated between surfaces. Node code must use
  `context.root`, cleanup, and `lifecycle.signal`, and must not rely on
  globals surviving or being absent. This is a documented limitation, not a
  guarantee.

On a node transition the Runtime:

1. rejects further navigation from the exiting node;
2. aborts its lifecycle signal and awaits its cleanup;
3. removes its ShadowRoot host;
4. updates the back stack and checkpoints the save;
5. imports the target's compiled module;
6. creates a new ShadowRoot, injects compiled CSS and HTML;
7. calls `mount(context)` and reveals the node when it settles.

A startup or mount failure unmounts the node and puts the
Runtime in an explicit failed state.

## Save and session

One save slot:

```json
{
  "version": 1,
  "graphVersion": 1,
  "graphSignature": "…",
  "savedAt": "…",
  "currentNodeId": "archive",
  "backStack": ["main-menu"],
  "state": {}
}
```

- The Runtime checkpoints after every successful navigation and committed
  state change; writes may be debounced. `session.save()` flushes.
- `reset()` restores `initialState` and clears the back stack without
  leaving the current node. A menu starts a new game with `reset()` then its
  `start` Signal.
- `restart()` resets and enters `entryNodeId`.
- `continue()` restores the save. `graphVersion` is the graph's `version`,
  and `graphSignature` hashes `graph.json`, so a code-only edit keeps the
  save. A save whose graph version or signature no longer matches is
  reported as incompatible (`save.incompatible`) rather than loaded partially.

## Story Map

Besides the save slot, the Runtime keeps what the player has **seen**: when
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
  "save": { "present": true, "savedAt": "…" }
}
```

`recentSignals`, `reports`, and `errors` are bounded histories. `reports`
holds what the `report` [preview policy](#preview-policy) reported, and stays
empty under `follow`. `stateAccess` powers the
Workbench's "State used" section; calling `get()` without a key records
`"*"`.

### Element picking and capture

In preview builds, the compiler adds an inert `data-ohmygame-source`
attribute to each element written in node HTML. On request, the sandbox host
enters pick mode and returns the picked element description defined in
[authoring.md](authoring.md#element-picking). Capture uses the desktop host's
page capture of the preview frame.

## Compiler

The compiler turns the validated graph and workspace into one self-contained
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

Publishing validates in `publish` mode, compiles the same definition used by
Playtest, and writes a static directory with the Player, sandbox,
`playable.json`, `manifest.json`, and the declared assets.

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
- multiple save slots and save management UI;
- a typed state schema;
- persistent audio and media services;
- network access from node code;
- stronger per-surface JavaScript isolation.

Each should extend Node, Signal, State, and Runtime boundaries rather than
add node categories.
