# Playable Nodes Project

This project is made of one graph plus ordinary browser source files. Every Node has the same capabilities; names such as menu, scene, archive, or puzzle are authoring ideas rather than runtime types.

## Files

- `graph.json` is the runtime graph and dependency manifest.
- `nodes/<id>/` contains a Node's HTML, CSS, and JavaScript.
- `shared/` contains ordinary modules imported by more than one Node.
- `shared/components/` contains UI shown on more than one Node, such as a Home button.
- `shared/style/` is the Project Style: `theme.css` tokens, `components.css` classes, and `components.js` components such as `playScene()`.
- `editor/layout.json` contains editor-only positions and viewport state.
- `schemas/` contains the exact persisted JSON contracts.
- `.ohmygame/` is OhMyGame's own data, such as asset records and Node thumbnails. It is never published; leave it alone.

## Node API

Background videos support optional `data-clip-start` / `data-clip-end`
attributes on their `data-media="backdrop"` element. Values are non-negative
seconds in the original video, end greater than start; omitted values mean
zero and the natural end. Trimming is per Scene, does not modify the original
Asset, and does not reduce its published size. The shared runtime plays this range
and emits `ended` at its end. Remove the attributes to restore the full video.

Each Node module exports `mount(context)`. The Runtime supplies:

- `context.root`: the Node's isolated ShadowRoot.
- `context.assets.url(id)`: a URL for an Asset declared by this Node.
- `context.state.get(key)`, `set(key, value)`, `patch(values)`, and `subscribe(listener)`.
- `context.navigation.emit(signalId)`, `back()`, and `connected(signalId)`, which is true when this Node declares the Signal and an edge routes it.
- `context.session.hasSave()`, `save()`, `continue()`, `restart()`, and `reset()`; save slots with `slots()`, `saveSlot(id, note)`, `loadSlot(id)`, and `deleteSlot(id)`.
- `context.position.get()` and `set(value)`: where the player is inside this Node, as JSON the Node chooses. It is kept with the save and on the back stack; a Node entered by a Signal starts with `null`.
- `context.audio.music(assetId | null, { fade })` and `sound(assetId)`: music plays on across Nodes until a Node changes it, and turns down while a Node's video or audio plays with sound.
- `context.preferences.get()` and `set(values)`: the player's settings, kept across games. `musicVolume` and `soundVolume` (0 to 1) set the volumes; other keys are the project's.
- `context.story.seen()`: what the player has seen across every game, as `{ nodes, edges }` mapping each Node ID first entered and edge ID first taken to when. A preview gives every Node and edge.
- `context.story.seenBefore`: true when the player entered this Node before, earlier in this game or in another one, so a Scene can offer to skip it. Always false in a preview.
- `context.lifecycle.signal`: aborted before cleanup when the Node exits.

A shared component receives the Node's context from the Node that mounts it, so it emits that Node's Signals: every Node that shows it declares them in `graph.json`.

The mount function may return a synchronous or asynchronous cleanup function.

In a web story (with `index.html` and `story/`), the page loads each Scene's files as they are: modules import local files by relative path, text files are fetched, and JSON imports use `with { type: "json" }`. The runtime under `story/` is the project's own and can be changed; `story/manifest.json` records the version OhMyGame wrote. Publishing packages the page, `story/`, `graph.json`, `nodes/`, `shared/`, and the assets the story uses.
