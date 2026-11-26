# Playable Nodes Project

This workspace is the source of truth for an OhMyGame Playable Nodes project.

- `graph.json` declares the viewport, initial State, Assets, Nodes, Signals, and navigation edges.
- Every Node follows the same protocol. Its HTML, CSS, and JavaScript are ordinary source files referenced by `node.source`.
- Node JavaScript exports `mount(context)`. Render into `context.root` and optionally return a cleanup function.
- Emit only Signals declared by the current Node: `context.navigation.emit(signalId)`. Signals describe outcomes; they do not name target Nodes.
- Read and update authoritative project State through `context.state`. Do not keep navigation-critical state only in the DOM.
- A top-level State key is a Variable: something that crosses Nodes or belongs in the save, such as `trust` or an `inventory` list. Progress inside one Node stays in that Node's code, and content such as item definitions goes in `shared/` modules.
- When you add a Variable, give it a starting value in `initialState` and a one-line description in `variables`, such as `"trust": "How much the guard trusts the player"`. The user sees them read-only in Project → Variables.
- To branch on progress, read State in the Node and emit a different Signal for each outcome. Give each such Signal a `when`: one short sentence saying when it is taken, such as `"if trust is 3 or more"` or `"needs the brass key"`. The canvas shows it on the Exit.
- `variables` and `when` are display only; the Node's code decides. Update them in the same change whenever that logic changes, and remove a description when you remove its Variable.
- Every Node must show something sensible with the initial State, because the editor previews each Node from a new game.
- A Node may use only Assets listed in its `assets` array. Resolve them with `context.assets.url(assetId)`.
- Build every screen with the Project Style in `shared/style/`: import `shared/style/components.css` from a Node's CSS and use its tokens and classes. Add a token or component there instead of hard-coding values in a Node, and restyle the game by changing `shared/style/` first.
- A Node's background is one `<div class="backdrop" data-media="backdrop" data-asset="ID" data-type="video|image">` inside a `.has-backdrop` container. The author sets `data-asset` and `data-type` from the editor, so keep exactly one such element in the Node's HTML and never replace it; to change the background, change those two attributes. `showBackdrop(context)` from `shared/style/components.js` shows it: a video plays once with sound and stops on its last frame, an image stays still. It returns `{ video, cleanup }`.
- Music that should carry on across Scenes, such as a chapter's theme, goes through `context.audio.music(assetId)`, not an `<audio>` element in a Node: it keeps playing into the next Scene, is kept with the save, and turns down while a Scene's own video plays with sound. A Node that reads a long sequence one step at a time, such as a script, keeps its place with `context.position`, so Continue returns there.
- `playScene(context, { signal })` from the same file shows the background and emits the Signal when its video ends; a click does not cut a video short. A still, no background, or a video that cannot play moves on with a click and shows the Node's `.continue-hint`. A `[data-skip]` button shows over a video the player has seen before. The Blank Template uses it; change or replace it freely.
- Use normal modules under `shared/` for code shared by Nodes. Imports must remain inside this workspace; project dependencies resolve from this project's own `node_modules`.
- Files a Template added, such as the Project Style in `shared/style/` and the Visual Novel player in `shared/vn/`, are this project's source like any other: change them freely. OhMyGame writes them only when they are missing and never updates them.
- UI that appears on more than one Node, such as a top bar or a Home button, is a shared component under `shared/components/`. Each Node that shows it imports it, and declares and routes the Signals it emits like its own. There is no layer drawn over every Node; State carries whatever must continue across Nodes.
- A Signal that is a way around the game rather than a step in the story, such as Home, Menu, or Settings, has `"role": "navigation"`. The editor names its target on the Exit instead of drawing a line; routing is the same.
- Use `replace` for forward progression and `push` only when the player should be able to return with `navigation.back()`.
- A Story Map Scene (the `story-map` Preset) lays the story out from graph.json in its own `layout.js` and shows what the player has seen with `context.story.seen()`. Its `node.js` lists the IDs of Scenes that are not steps in the story, such as menus and settings, in `OFF_MAP`, so the map leaves them out and joins the Scenes on either side; names players see instead of titles in `LABELS`; and which Scenes count as endings in `isEnding` (by default, those with no Exits other than navigation ones). Change them there when the author asks what the map shows. Reach it with a `push` edge from a menu, a pause button, or an ending; it returns with `navigation.back()`. A Main menu's `story-map` navigation Exit is the usual way in; connect it to the Story Map Scene.
- An entry, button, or link whose Signal may go nowhere checks `context.navigation.connected(signalId)` and shows disabled instead of emitting. Publishing requires every Signal other than navigation ones to be connected.
- A new project has no Nodes. `playable_add_node` makes the first Node the Entry Node; when you add the first Node to graph.json yourself, set `entryNodeId` to it.
- Keep IDs and source paths stable when editing existing objects. You do not need to edit `editor/layout.json`; the editor places new Nodes.
- Read `README.md` and the schemas in `schemas/` before changing the contract.

## Web stories

A project with `index.html` and `story/` is a web story: it plays as its own page, and `story/` holds the story runtime that reads `graph.json` and loads each Scene's files as they are. A project without them was made before web stories and cannot play, build, or publish until the Story editor upgrades it, which it does when the user opens the story there; ask the user to open it.

- The runtime under `story/` is project code. Change it when the game needs something it does not do, and keep what the editor relies on: `graph.json` as the story's flow, the `context` every Scene's `mount` receives, the `scene` query parameter, and the one `data-media="backdrop"` background per Scene.
- `story/manifest.json` records the runtime OhMyGame wrote. When it lists `pending` files, a newer runtime changed files you or the author changed; the newer ones are under `.ohmygame/local/story-runtime/<version>/`. Merge them into the project's files, keeping the project's changes, then remove `pending` from the manifest.
- A Scene's code loads as a browser module, with no bundler: import project files by relative path, read text with `await (await fetch(new URL("./script.txt", import.meta.url))).text()`, and import JSON with `with { type: "json" }`. Packages from `node_modules` are not available.
- The page may use browser storage for what belongs to the player across every game, such as lines read or pictures unlocked. Keep a game's progress in `context.state` and `context.position`, so saves, slots, and Continue stay right.
- Media a Scene uses goes in `graph.json` `assets` as a project file, so publishing includes it.

## Words the editor uses

To trim a background video, set `data-clip-start` and/or `data-clip-end` on its
single `data-media="backdrop"` element with `data-type="video"`. Times are
non-negative seconds in the original file; end must be after start. Missing
start means zero, missing end means the natural end. Remove both when changing
the background. The shared runtime enforces the range and emits the video's normal
`ended` event at an early end; keep navigation in the Scene's code. Do not
rewrite shared helpers or modify the original Asset for a trim.

The user sees the editor, not this contract. Talk to them in its words: say "the `trust` Variable" and "the Exit is taken if trust is 3 or more", not keys, values, and code.

| Editor | Contract |
| --- | --- |
| Scene | Node |
| Exit | Signal and the edge that routes it |
| Start | `entryNodeId` |
| Variables | `initialState` keys, described in `variables` |
| Exit condition | Signal `when` |
| Allow Back | edge `mode: "push"` |
| Template | Preset |
