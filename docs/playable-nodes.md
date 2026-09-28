# Playable Nodes Architecture

## Status

This document defines the architecture and intended first product version of
Playable Nodes. It replaces the current Interactive Drama runtime model rather
than extending it. Existing Interactive Drama documents do not need to remain
compatible.

The public feature name is **Playable Nodes**. A project is structured as a
**Playable Graph**, and the code that runs it is the **Flow Runtime**.

## Product idea

A Playable Graph is a collection of programmable screens connected by signals.
Each screen is a Playable Node.

A node can be a cinematic scene, menu, archive, dialogue, investigation board,
puzzle, QTE, settings screen, ending, or small game. These are not different
runtime types. They are templates that create the same kind of node with
different starting content.

Every node is a browser-runnable surface. The default authoring format uses:

- HTML describes its interface;
- CSS describes its appearance;
- JavaScript describes its behavior;
- project assets provide images, video, and audio;
- signals describe the outcomes that can leave the node.

HTML, CSS, and JavaScript are a default browser target, not the limit of what a
node can express. A node may use Canvas, WebGL, Three.js, Phaser, React, or
other project-level libraries as long as its built module follows the same
surface protocol. V1 does not give every node an independent package,
dependency graph, or development server.

The Flow Runtime owns everything that must survive a node:

- project state;
- navigation;
- the back stack;
- asset resolution;
- save data;
- node lifecycle;
- the optional persistent Shell.

The central boundary is:

> Nodes own presentation and input. The Runtime owns state and flow.

## Why the current model changes

The current Interactive Drama implementation already has useful pieces: a
graph, code-backed surfaces, variables, assets, playtesting, saving, and static
publishing. The limitation is that they are divided among special node types.

Open UI, Scene, Interaction, Choice, Story Map, Settings, and Ending each carry
different rules and runtime behavior. Condition and Update State exist only to
support that model. The player also maintains separate surface protocols for
different node types.

This makes common creative ideas unnecessarily special. A case archive, custom
main menu, interactive book, and investigation interface all use similar web
capabilities, but the author must choose a predefined category and work within
its rules.

The new architecture removes those categories from the runtime. Presets remain
useful in the editor, but they do not create permanent differences in the
saved format or player.

## Relationship to the original idea

The architecture preserves the original design intent:

- all primary player-visible nodes use one runtime model;
- every node can freely combine media, interface, code, and interaction;
- a node may be as simple as one video or as expressive as a small browser
  game;
- nodes connect through explicit logic instead of fixed narrative categories;
- different nodes share one project state and reusable project code.

The freedom is intentionally bounded at the host boundary. A node is not an
independent application with its own server and save system. It is a powerful
browser surface hosted by the Flow Runtime. Inside the node, presentation and
interaction are flexible. Between nodes, signals, state, assets, and lifecycle
remain explicit so the project can be inspected, saved, tested, and published.

## Design principles

### One playable node type

Every player-visible node has the same data shape and runs through the same
surface host. A node's purpose comes from its content, not a runtime enum.

### One node protocol

Every node exports the same `mount(context)` function. There is no separate
`render`, `update`, or `run` contract for menus, scenes, and interactions.

The protocol fixes how a node communicates with the Runtime, not how the node
implements its content.

### Explicit signals

A node reports what happened by emitting a named signal. It does not choose or
name the next node in its JavaScript. The graph maps that signal to a target.

### Runtime-owned state

Nodes never own authoritative game state. They read and update a serializable
Project State through the Runtime API. This makes switching, saving,
playtesting, and debugging deterministic.

### Stable asset IDs

The project defines assets by stable ID, and each node declares the assets it
depends on. Node code decides how those assets are rendered. File names and
storage paths are not the public runtime API.

### Shared modules are fundamental

Nodes may import project-level JavaScript, CSS, UI, themes, and utility code.
Code reuse is part of the base authoring model and does not require a component
framework.

### The contract is sufficient and the implementation is inspectable

An author or coding Agent must be able to build normal content from the public
contract alone. Because OhMyGame is open source, the reference Runtime, tests,
and examples also remain easy to find and read when deeper understanding or
debugging is needed. Internal implementation details are informative, but are
not additional hidden requirements for node code.

### Editor data stays separate

Node positions, graph zoom, open panels, and other editor choices have no
runtime meaning and remain outside the playable document.

### Start small

The first version deliberately avoids a component framework, expression
language, multiple renderers, and parallel active scenes. New abstractions
should be introduced only after real projects demonstrate the need.

## Vocabulary

| Name           | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| Playable Nodes | The user-facing feature                                    |
| Playable Graph | The saved graph of nodes and edges                         |
| Playable Node  | One independently presented and operated screen            |
| Signal         | A named outcome emitted by a node                          |
| Edge           | A graph connection from one node signal to another node    |
| Project State  | Serializable data shared by the project                    |
| Shell          | Optional project-wide UI that remains mounted across nodes |
| Destination    | A stable project-wide name for a commonly opened node      |
| Flow Runtime   | The state, navigation, lifecycle, save, and surface host   |
| Preset         | Starter content for a node; it has no runtime meaning      |

## Architecture layers

The word "vanilla" refers to the small stable core, not every feature planned
for the first usable product.

### Playable Nodes Core

- Playable Node;
- browser surface protocol;
- Signal;
- Edge;
- Project State;
- Flow Runtime;
- Asset Manifest and explicit node asset dependencies;
- Shared Modules.

### Product v1

- one Entry Node;
- node presets in the editor;
- static preview and publishing;
- one save slot;
- `replace` and `push/back` navigation;
- an optional Persistent Shell;
- named Destinations used by the Shell.

### Later extensions

Conditions and effects on edges, overlays, Subflows, visual components,
multiple active node regions, multiple save slots, typed state schemas, and
additional renderer services remain later work.

## Product v1 model

The playable document contains only:

```text
Playable Graph
├── project metadata
├── viewport
├── entry node
├── initial state
├── assets
├── optional Shell
├── named destinations
├── Playable Nodes
└── edges
```

A representative `graph.json` is:

```json
{
  "version": 1,
  "title": "Ash Club",
  "viewport": { "width": 1920, "height": 1080 },
  "entryNodeId": "main-menu",
  "initialState": {
    "hasKey": false,
    "suspicion": 0,
    "foundClues": [],
    "charactersUnlocked": false
  },
  "assets": {
    "club-background": {
      "type": "image",
      "source": {
        "kind": "workspace",
        "path": "assets/club-background.webp"
      }
    },
    "rain-loop": {
      "type": "video",
      "source": {
        "kind": "workspace",
        "path": "assets/rain-loop.mp4"
      }
    }
  },
  "shell": {
    "assets": [],
    "source": {
      "html": "shell/index.html",
      "css": "shell/style.css",
      "javascript": "shell/shell.js"
    }
  },
  "destinations": {
    "home": "main-menu",
    "lobby": "game-lobby"
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
        { "id": "start", "label": "Start game" },
        { "id": "open-archive", "label": "Open archive" }
      ]
    },
    {
      "id": "game-lobby",
      "title": "Game lobby",
      "source": {
        "html": "nodes/game-lobby/index.html",
        "css": "nodes/game-lobby/style.css",
        "javascript": "nodes/game-lobby/node.js"
      },
      "assets": ["rain-loop"],
      "signals": []
    },
    {
      "id": "archive",
      "title": "Case archive",
      "source": {
        "html": "nodes/archive/index.html",
        "css": "nodes/archive/style.css",
        "javascript": "nodes/archive/node.js"
      },
      "assets": ["club-background"],
      "signals": []
    }
  ],
  "edges": [
    {
      "id": "menu-start",
      "source": { "nodeId": "main-menu", "signal": "start" },
      "targetNodeId": "game-lobby",
      "mode": "replace"
    },
    {
      "id": "menu-archive",
      "source": { "nodeId": "main-menu", "signal": "open-archive" },
      "targetNodeId": "archive",
      "mode": "push"
    }
  ]
}
```

This example shows the complete runtime structure, not a partial layer that
depends on hidden node categories.

## Playable Nodes

A node contains five things:

```text
Node
├── stable ID
├── editor-facing title
├── browser-runnable source
├── declared asset dependencies
└── declared signals
```

The title helps authors understand the graph. It has no automatic visual
meaning. The node decides whether and how to render a title.

Signals are declared so the editor and validator can expose real output ports.
For example, a locked door node might declare:

```json
[
  { "id": "door-opened", "label": "Door opened" },
  { "id": "door-locked", "label": "Door locked" }
]
```

Its code reads Project State and emits one of those signals. The code still
does not know which nodes are connected to the outputs.

The default source consists of HTML, CSS, and a JavaScript module. More complex
authoring tools may compile to the same browser-runnable output. The project
uses one dependency and build environment; individual nodes do not introduce
independent package managers or development servers in v1.

## Node protocol

Every node JavaScript module exports one function:

```js
export function mount(context) {
  const button = context.root.querySelector("[data-open]");
  const open = async () => {
    if (context.state.get("hasKey")) {
      await context.navigation.emit("door-opened");
    } else {
      await context.navigation.emit("door-locked");
    }
  };

  button.addEventListener("click", open);

  return () => {
    button.removeEventListener("click", open);
  };
}
```

`mount` may return a cleanup function. The Runtime also aborts the lifecycle
signal when a node exits. Node code must use cleanup or the abort signal for
listeners, timers, and asynchronous work.

The v1 context contains:

```ts
interface RuntimeContext {
  root: Document;

  assets: {
    url(id: string): string;
  };

  state: {
    get(): Readonly<JsonObject>;
    get(key: string): JsonValue;
    set(key: string, value: JsonValue): Promise<void>;
    patch(values: JsonObject): Promise<void>;
    subscribe(listener: (state: Readonly<JsonObject>) => void): () => void;
  };

  session: {
    hasSave(): boolean;
    reset(): Promise<void>;
    continue(): Promise<void>;
    save(): Promise<void>;
    restart(): Promise<void>;
  };

  lifecycle: {
    signal: AbortSignal;
  };
}

interface NodeContext extends RuntimeContext {
  navigation: {
    emit(signal: string): Promise<void>;
    back(): Promise<void>;
  };
}

interface ShellContext extends RuntimeContext {
  navigation: {
    back(): Promise<void>;
    open(destination: string, mode?: "replace" | "push"): Promise<void>;
  };
}
```

The Runtime validates every request received from the isolated node surface.
An unknown asset, state key, signal, or destination produces a visible runtime
error instead of silently doing nothing.

Nodes can emit declared signals or go back, but cannot open an arbitrary
destination. The persistent Shell can open named destinations, but cannot emit
a node-owned signal. This keeps ordinary story flow visible in the graph.

## Project State

The current Variable system becomes Project State. Its essential purpose is
preserved: shared data belongs to the Runtime, survives node changes, and is
included in saves.

State starts as ordinary JSON:

```json
{
  "hasKey": false,
  "suspicion": 0,
  "playerName": "",
  "foundClues": [],
  "cases": {
    "case01": {
      "unlocked": true,
      "completed": false
    }
  }
}
```

V1 supports all JSON values: objects, arrays, strings, finite numbers,
booleans, and `null`. It does not accept functions, DOM objects, `undefined`,
`NaN`, `Infinity`, `Date`, `Map`, or other process-owned objects.

`get()` returns a read-only copy. Mutating that value does not mutate Runtime
state. All authoritative changes go through `set()` or `patch()` so the Runtime
can validate, notify subscribers, and persist them.

`set(key, value)` replaces one top-level key. `patch(values)` atomically replaces
several top-level keys. V1 deliberately has no dot-path language. To update a
nested object, code reads that top-level value and writes back a new value.

The top-level keys in `initialState` define the available keys. `set()` and
`patch()` cannot create undeclared top-level keys in v1. Authors add a new key
by adding its initial value to the graph document.

The first version does not require separate variable declarations or a JSON
Schema. Initial values provide useful types for authoring. A later optional
schema can improve validation and editor controls without changing the runtime
API.

State changes become visible immediately to the active node and Shell. They do
not wait for the node to complete.

## Signals and edges

A signal says what happened. An edge says where that outcome leads.

```text
Node code: emit("open-archive")
Graph:     main-menu.open-archive -> archive
Runtime:   exit main-menu, enter archive
```

V1 allows at most one edge for each node and signal pair. This keeps routing
deterministic and makes a missing or duplicate connection easy to explain.

V1 does not put conditions or state effects on edges. A node reads state and
emits the appropriate signal. For example, it emits either `door-opened` or
`door-locked`.

This is intentionally simple. Guard expressions, edge priorities, and edge
effects can be added later without changing the node protocol or Project State.

## Navigation

V1 has two edge modes:

- `replace` exits the current node and enters the target without adding a new
  back-stack entry;
- `push` records the current node as a return location, exits it, and enters the
  target.

`navigation.back()` returns to the most recent pushed location.

The stack stores navigation data, not live browser instances. When a node is
pushed away, its iframe is destroyed. Returning mounts a new instance of that
node. Anything that must survive must live in Project State; temporary DOM and
JavaScript closure state is intentionally discarded.

This keeps memory use, lifecycle behavior, and saving straightforward. A later
version may add overlays or suspended node instances if real projects require
them.

## Destinations

Destinations give stable names to commonly opened nodes:

```json
{
  "home": "main-menu",
  "rules": "game-rules",
  "characters": "character-archive"
}
```

They are primarily useful to the Shell. A persistent toolbar can call
`navigation.open("characters", "push")` without knowing a node ID and without
requiring identical outgoing edges on every node.

Destinations are not a second graph. They are project-wide aliases for entry
points that can be opened from persistent UI.

## Shared content and the Shell

There are two distinct forms of sharing.

### Shared Modules

Multiple nodes may import the same local JavaScript or CSS module. This is the
right choice when they should reuse appearance or behavior but do not need to
preserve one live UI instance.

```text
shared/
└── action-bar/
    ├── action-bar.js
    └── action-bar.css
```

The build step resolves local module imports into the isolated node bundle.
Shared Modules are a core capability, not a special runtime object. They may
contain UI, themes, animation, formatting, or general utilities. V1 does not
require a component manifest, dependency injection, or a visual component
tree.

### Persistent Shell

The optional Shell is project-wide HTML, CSS, and JavaScript mounted above the
current node. It remains alive while nodes change. It is suitable for a HUD,
navigation bar, persistent controls, or other global interface.

```text
Player
├── Shell
└── Current Playable Node
```

The Shell uses the same assets, state, navigation, session, and lifecycle
foundations. Its navigation capability is deliberately different: it opens
named destinations and cannot emit a node-owned signal.

The Shell is not another node type and is not part of the graph. A project that
does not need persistent UI omits it entirely.

Shared Modules and the Shell solve different problems. Shared Modules reuse
source but are mounted and destroyed with each node. The Shell preserves one
live interface instance while nodes change. A shared action bar can therefore
be imported into each node, while an action bar that must never flash, restart,
or lose temporary UI state belongs in the Shell.

## Assets

The project Asset Manifest defines resources once by stable ID. Each node and
the Shell explicitly list the asset IDs they depend on. Code then decides how
to use those resources:

```js
const imageUrl = context.assets.url("club-background");
```

The Runtime or build process decides how that ID maps to a local preview URL or
published file. Nodes do not depend on library database paths or generated
file names.

An asset reference is a dependency declaration, not a layout instruction.
Adding an image to a node does not automatically render it. Node code may use
it as an `<img>`, CSS background, Canvas input, WebGL texture, or in any other
browser-supported way.

The Node Editor shows the assets declared by the selected node, including
previews, stable IDs, missing-file status, and an action to insert an asset ID
into source. At runtime, `assets.url(id)` accepts only assets declared by that
node or Shell. This keeps dependencies visible, enables validation and
preloading, and gives the coding Agent a precise node context.

V1 does not provide a media layer system. Nodes render assets directly with
standard web primitives such as `<img>`, `<video>`, `<audio>`, CSS backgrounds,
Canvas, or WebGL. Shared playback, preloading, and persistent audio services
can be introduced later if repeated needs justify them.

Asset generation is separate from playable flow. Text, image, video, and 3D
generation may remain in the Library or Asset Canvas, but those creation nodes
do not participate in runtime navigation edges.

## Save behavior

V1 has one save slot. A save contains only serializable Runtime data:

```json
{
  "version": 1,
  "graphVersion": 1,
  "graphSignature": "...",
  "savedAt": "...",
  "currentNodeId": "archive",
  "backStack": ["main-menu"],
  "state": {}
}
```

The Runtime checkpoints after a successful navigation or committed state
change. Writes may be debounced, and `session.save()` forces the latest
checkpoint to storage.

No DOM nodes, renderer objects, timers, media elements, JavaScript closures, or
iframe state enter the save. Continuing recreates the Shell and current node
from saved Runtime data.

`session.reset()` resets Project State from `initialState` and clears the back
stack without leaving the active node. A main-menu preset starts a new game by
awaiting `reset()` and then emitting its normal `start` signal.
`session.restart()` resets state and returns directly to `entryNodeId`.
`session.continue()` restores the one valid save.

## Surface and lifecycle

The Flow Runtime uses one isolated surface implementation for all nodes. On a
node transition it performs these steps:

1. reject additional navigation from the exiting node;
2. abort the node lifecycle signal;
3. invoke the cleanup returned by `mount`;
4. destroy the old surface;
5. resolve and load the target node source;
6. create a new isolated surface;
7. provide the validated context bridge;
8. call `mount(context)`;
9. reveal the node after it reports readiness or mounts successfully.

The editor preview and published player use the same graph, state, navigation,
and surface implementation. Editor tooling belongs to the host and should not
encourage node code to implement separate editor, playtest, and published
behavior.

The surface Content Security Policy denies network access by default. Project
assets are available only through the Runtime asset service. Local ES module
imports are resolved by the build pipeline so reusable source works without
giving the surface unrestricted filesystem or network access.

## Editor model

The main canvas contains Playable Nodes and navigation edges. It answers one
question: how can the player move through the project?

The first product version has these authoring surfaces:

- **Flow** shows node previews, declared Signal ports, edges, Entry, and
  Destination badges;
- **Node Editor** shows a live node preview, source, Signals, and that node's
  declared assets;
- **Project State** edits initial JSON state and shows current state changes
  during playtest;
- **Shell Editor** edits the optional persistent project UI and its named
  Destination actions;
- **Assets** selects project resources and assigns stable IDs;
- **Playtest** runs the real Flow Runtime and can reveal current node, back
  stack, recent Signals, state changes, and runtime errors.

Users normally create a node from a Preset, describe or edit its visual and
interactive behavior, declare the outcomes as Signals, and connect those ports
on the Flow canvas. They do not choose a permanent Scene, Menu, Choice, or
Interaction node type.

Creating a node may start from presets such as:

- blank;
- cinematic scene;
- dialogue choice;
- main menu;
- archive;
- investigation hotspot;
- QTE;
- ending.

After creation they are all ordinary Playable Nodes. A preset name is not
stored as a runtime type.

The node editor exposes source, signals, declared asset dependencies, and a live
preview. The asset section shows exactly what the selected node can request at
runtime. The edge editor exposes only `replace` or `push` in v1.

Editor state remains separate:

```json
{
  "version": 1,
  "nodes": {
    "main-menu": { "x": 120, "y": 180 }
  },
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "view": "canvas"
}
```

## Workspace layout

```text
graph.json
assets/
nodes/
  main-menu/
    index.html
    style.css
    node.js
  archive/
    index.html
    style.css
    node.js
shell/
  index.html
  style.css
  shell.js
shared/
  action-bar/
    action-bar.js
    action-bar.css
editor/
  layout.json
schemas/
  graph.schema.json
  editor-layout.schema.json
```

`shell/` is absent when the project has no Shell. `shared/` is a normal source
directory and has no special runtime format.

## Agent-facing open-source design

Playable Nodes uses ordinary, inspectable project files. A coding Agent can
read and edit the graph, Node source, Shared Modules, optional Shell, State,
and asset declarations directly. It does not require an Agent-specific runtime
or hidden editing API.

Exported public types define the Node and Shell APIs. JSON Schema defines the
persisted graph and editor data. These are the authoritative contract. The
open-source Runtime, behavior tests, and examples remain available when an
Agent or developer needs to understand an edge case, but normal content
creation must not depend on internal helpers.

Each generated project includes a short `AGENTS.md` containing only the stable
authoring rules: use the common Node protocol, emit declared Signals instead of
naming targets, keep authoritative State in the Runtime, declare asset
dependencies, use Shared Modules for reuse, and reserve the Shell for
persistent project UI.

The full Flow Runtime is not copied into every authored project. Keeping one
open-source implementation avoids accidental engine edits, incompatible
project forks, unnecessary Agent context, and difficult upgrades. Runtime
source should remain clearly organized and searchable, without requiring a
particular package or file layout before implementation.

Creating a menu, archive, puzzle, or scene should only require changes to
project content and public declarations. Runtime changes are engine work. A
contract change to the Runtime must update its public types, relevant Schema,
tests, and documentation together.

The workspace provides one non-interactive validation path and uses the same
Flow Runtime for preview and published play. Validation errors must be specific
and actionable. For example:

```text
Node "archive" requests asset "archive-book", but that asset is not listed in
nodes[archive].assets. Add the dependency or use a declared asset ID.
```

Playtest should make current Node, State, navigation, recent Signals, and
Runtime errors inspectable in a compact serializable form. This benefits human
debugging and lets an Agent verify behavior alongside visual output.

The design rule is:

> The public contract should be sufficient; the implementation should remain
> inspectable.

## Validation rules

Before preview or publish, v1 validates that:

- IDs are non-empty and unique in their scope;
- `entryNodeId`, destinations, and edge targets reference existing nodes;
- every edge source references an existing declared signal;
- a node and signal pair has at most one edge;
- every node and Shell asset dependency references an Asset Manifest entry;
- source and asset paths are relative and stay inside the workspace;
- referenced files exist;
- initial and current state are JSON-serializable objects;
- asset IDs are unique and asset types match supported formats;
- `replace` and `push` are the only navigation modes.

A signal may intentionally have no edge while a project is being edited.
Playtest reports an error if that signal is emitted, and publish requires every
declared signal to have one edge.

## Runtime algorithm

At its core, v1 does only this:

1. clone `initialState` and enter `entryNodeId` for a new game;
2. mount one node in the isolated surface;
3. expose assets, state, navigation, session, and lifecycle services;
4. receive a declared signal from the active node;
5. find exactly one matching edge;
6. update the back stack according to the edge mode;
7. unmount the current node and mount the target;
8. persist state, current node, and back stack.

Everything else is authored inside a node or optional Shell.

## Explicitly deferred

The following ideas are compatible with the model but are not part of Product
v1:

- guard expressions, edge priorities, and fallback edges;
- state effects attached to edges;
- overlay navigation and suspended live node instances;
- multiple simultaneous node regions;
- node-local persistent state as a separate system;
- automatic media-ended and timer transitions;
- a component manifest or visual component tree;
- reusable Subflows;
- multiple save slots and save-game management UI;
- a typed state schema and generated state controls;
- project-defined permissions;
- persistent media and audio services;
- built-in 2D or 3D engines;
- multiplayer and synchronized state;
- arbitrary network access from node code.

These features should extend the stable Node, Signal, State, and Runtime
boundaries rather than introduce new special node categories.

## What is removed from the current runtime

The replacement does not preserve these runtime concepts:

- Start node: replaced by `entryNodeId`;
- Open UI, Scene, Interaction, Choice, and Ending types: replaced by Playable
  Nodes and editor presets;
- Story Map and Settings system nodes: replaced by ordinary nodes and named
  destinations;
- Condition node: branching is authored with distinct signals in v1;
- Update State node: nodes use the State API;
- separate screen, scene, and interaction iframe protocols: replaced by one
  surface protocol;
- type-specific progress such as selected choices and unlocked endings:
  projects record the state they need in Project State;
- runtime navigation edges mixed with asset-generation connections: asset
  creation stays outside the Playable Graph.

## Definition of a successful v1

The architecture is proven when the same node type and protocol can build and
publish all of the following without runtime-specific exceptions:

- a custom main menu;
- a cinematic node that advances from authored code;
- a branching choice;
- an interactive case archive with internal page changes;
- a puzzle that updates Project State;
- a persistent shared toolbar implemented by the Shell;
- push and back navigation;
- a new game and a restored save;
- a node that shares source modules with another node.

If one of these requires adding a new node category, the v1 abstraction has
failed.

The Agent-facing architecture is successful when a coding Agent can create,
connect, validate, visually inspect, and debug those examples by changing only
project content and public declarations. It may inspect the open-source Runtime
for understanding, but should not need to modify it or depend on an unexported
helper to express a new creative idea.
