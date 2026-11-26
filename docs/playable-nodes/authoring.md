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

The editor also reuses the parts of the current Interactive Story editor that
already work well. The redesign removes node-type-specific forms; it does not
replace the whole interface.

## Older stories and Library media

Interactive Stories play as their own web page (see
[runtime.md](runtime.md#page-and-lifecycle)). A story made before that was
made for a sandbox OhMyGame no longer has, and this version can't open it:
the Story canvas says so, and that opening it once in OhMyGame beta.5.11 or
earlier upgrades it.

A published story cannot reach media left in the Library, so while a story
still uses any, the Story canvas names them in a warning and offers **Copy
into project**.

## Workspace

An Interactive Story is a web game whose flow is drawn on the Story canvas.
It opens in the project frame with a web game's panels and the Story panel
in front:

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar: project name ▾                      Play · Publish  │
├───────────────┬──────────────────────────────────────────────┤
│ Chat          │ Story · Game · Design · Canvas · Code · Assets│
│               │                                              │
│  Chat with    │   Story (the flow canvas)                    │
│  the Agent    │                                              │
│               │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

- **Chat**, **Story**, **Game**, **Design**, **Canvas**, **Code** and
  **Assets** are panels: they drag to another side or beside each other,
  close from their tab, and come back from an area's **+** menu. The
  arrangement is shared with every project; see
  [workspace panels](../runtime.md#workspace-panels).
- The Story panel is the flow canvas. Everything else is a web game's: the
  **Game** panel, **Play** in the top bar, Publish and the exports play the
  story's own page, `index.html`, through the project preview. Design is the
  game design document and Canvas the asset canvas.
- The screen size is the `viewport` in `graph.json`; ask the Agent to change
  it.
- The project name's menu returns to the page used to open the project,
  retaining project-list filters, search, and sorting. Opening a project link
  directly uses **Projects** as the return destination.
- **Publish → Export web build** downloads a build that players can play
  anywhere. **Export project** in the project name's menu downloads the
  editable project: its source files without
  `node_modules/`, `.git/` or `.ohmygame/local/`, with
  each Library asset copied to `assets/library/` and `graph.json` pointing at
  the copy. Copied filenames avoid collisions between letter case variants
  and canonically equivalent Unicode spellings, so extracting on Windows
  or macOS preserves distinct Library assets.
  Choosing the unzipped folder in **New project** opens the same
  project on another computer.
  Both exports compress source text and store already compressed media, such
  as videos and PNG images, directly in the ZIP to avoid recompressing them.

### Source files

The **Code** panel shows the project's files and their contents. Scene cards
use readable names.

The **Assets** panel, as in a web game, shows the project's images, videos,
audio, and models in one grid, with filters and search. **Show in Code** opens
an asset's file in the Code panel.

## Flow canvas

The canvas answers one question: how can the player move through the
project?

Each Scene card shows:

- its first image Asset, else the first frame of its first video, else a
  neutral card with its title;
- the Scene title;
- one output port per Exit, unlabeled so the picture stays clear; hovering
  the port names the Exit (Signal label);
- a **Start** badge on the Scene the player starts in (**Set as Start**
  moves it);
- an issue marker when the Scene fails to build, emits an undeclared Signal,
  or has an Exit that goes nowhere.

The canvas shows only Scenes. A top bar shown on several Scenes adds its
Exits to each of those Scene cards; there is no separate card for it.

A connection links an Exit port to a target Scene. Connections always leave
an Exit on the right of its Scene and enter the target on the left, and every
connection is drawn the same plain line, as on the Story Board. Whether an
Exit allows **Back** (`push` edges) or is **Navigation**, a way around the game
such as a **Home** Exit, is kept in `graph.json` and the canvas doesn't show it.

Clicking a line selects the connection; Delete removes it, and dragging from
the Exit again points it elsewhere. There is no connection panel. **Allow
Back** and **Navigation** are the Agent's to set: the author asks for them in
their own words ("let Archive open the case archive with Back allowed"), and
the Agent marks Exits that come from a shared component, such as Home, as
Navigation.

The canvas keeps the current editor's mature interactions: Add Scene menu,
context menu, selection, alignment guides, copy and paste, zoom controls,
and fit view. Double-clicking a Scene, or **Open in Code** in its menu, opens
the Scene's HTML in the Code panel.

Connecting can happen two ways, and both produce the same edges:

- drag from an Exit port to a Scene;
- ask the Agent, for example "connect Start to the lobby, and let Archive
  open the case archive with Back allowed".

## Creating a Scene

A new project opens with an empty Story canvas. Use the toolbar's **Add Scene**
control or describe the story in the chat; the first Scene added becomes the
Start.

1. The author chooses **Add Scene** on the canvas.
2. The **Add a Scene** window shows each Template (Blank, Main menu,
   Choice, QTE, Hotspot, Ending, Story map, Visual Novel) as a
   picture with one line of summary, and they pick one. The right-click
   menu offers the same Templates as a list.
3. The Scene appears on the canvas with working starter content.
4. The author says in the chat what it should become, such as "make the new
   main menu the Ash Club start screen, with a dark stone background and four
   entries".

A Template (Preset) is starter content plus instructions for the Agent. It is
not stored as a type, and a Scene created from "Main menu" can later become
anything.

Template content is ordinary files under `src/daemon/assets/story-templates/`:
`project/` is the Project Style the Templates import (a new story gets its own
copy from the Interactive Story plugin's `blank` template), `<id>/scene/` is the
Scene a Template creates, and `<id>/project/` holds shared files the Template
adds when a project lacks them. `{{title}}` in a Scene's HTML becomes its
title and `{{id}}` its ID. `src/daemon/playable-presets.ts` keeps each
Template's name, summary, brief, and Signals. The files are copied into
projects as they are, so Prettier skips them.

## Working on a Scene

There is no Scene editor. The Agent changes a Scene; the author says what to
change in the chat, naming the Scene by its title, and sees the result in the
**Game** panel, which plays the story from its Start like any web game's
preview. To look at a later Scene, play to it, or ask the Agent to make it the
Start for a while.

The Game panel's own tools work on the story's page as on any web game's:
picking an element puts it in the chat for the Agent to find in the Scene's
source. When the Agent's turn completes, the canvas reads the project again:
new or removed Exits appear, and a Scene with a problem shows an issue marker.

There are no type-specific forms. What used to be a Choice's options or a
Scene's duration lives in the Scene's own content and is changed by
describing the change. A Scene's files are in the **Code** panel for the rare
edit by hand.

## Project Style
## Project Style

The Project Style is the project's shared visual language: the tokens in
`shared/style/theme.css`, the classes in `components.css`, and the behaviour
in `components.js`. It is stored as ordinary shared source files that every
Scene imports. The editor has no Style panel: a read-only view could not
change anything, so the style is changed in conversation, or in those files
from the Code view.

- The Agent reads and uses the Project Style whenever it builds a Scene.
- Authors can change the style through conversation ("make the whole game
  warmer, like lamp light on old paper").
- Changing the style updates every Scene that uses it.

The default Project Style looks like an interactive film: black bars, a
vignette, and film grain over the background, dialogue as subtitles, answers
as dark bars across the screen, a ring for timed presses, and pulsing dots
for hotspots. Sizes follow the screen width (`cqw`), so a Scene looks the
same at any size. Until the author sets a background, each Template shows a
still from Last Bus: the cover, bus stop, phone, cabin, stop bell, or store
interior. Small project-owned stylesheets under `shared/templates/` reference
separate WebP files under `shared/templates/lastbus/`, copied only on first use.
Their `data-template-artwork` selector scopes the illustration and zero
letterbox to that Scene; other Scenes keep their own Project Style. Replacing
the WebP changes the illustration without editing CSS. Setting an image or
video background in the editor replaces the illustration.

The artwork was generated and developed by the OhMyGame team and is provided
under Apache License 2.0. Template creation also copies `NOTICE.txt` and
`LICENSE.txt` into `shared/templates/lastbus/`; project archives retain these
files. Keep the applicable notices when redistributing the artwork. Adding
another Template supplies missing notices to an existing project without
overwriting its existing files.

Project Style is how two different screens, such as the Ash Club menu and
archive, stay recognizably part of one game.

## UI on many Scenes

UI that appears on several Scenes, such as the Ash Club top bar or a **Home**
button, is a shared component (`shared/components/`). The author asks for it
in chat ("add a Home button to every chapter Scene"), and the Agent writes the
component once and imports it into each Scene that should show it.

Its buttons are that Scene's own Exits. They appear on the Scene's card and are connected like any other Exit, so **Home** can lead to
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
one-line description, in `graph.json`. The editor does not list them; ask
the Agent what a playtest found them to be.

A branch shows as Exits. A Scene that goes different ways declares one Exit
per outcome, and the Agent writes when each is taken in `graph.json`, such as
"trust is 3 or more". The canvas doesn't show it.

The condition is a description (Signal `when`), not a rule the editor runs:
the Scene decides which Exit to take, and the Agent updates the words when it
changes the logic. There are no Condition or Update State Scenes. When a
branch goes the wrong way, the Agent's playtest reads what the game
remembers.

## Playing the story

**Play** and the **Game** panel run the story's own page with the real Runtime
from the Start, with the saved game available through the game's Continue
action, as a player would. The page remembers which Scenes were seen and which
Exits were taken, across new games, as players' games do; a
[Story map](#story-map) shows it.

The Agent playtests the story with `game_use`, as it does a web game: the page
opened with `ohmygamePlaytest=1` gives it the full record (current Scene, back
stack, Exits taken, State, errors, save) in serializable form, so it can
verify a flow it just built.

## Story map

Interactive films and visual novels often show players a map of the story:
the branches they have found, the ones still locked, and the endings
collected. The **Story map** Template is that screen. It is an ordinary
Scene; the author reaches it from a menu, a pause button, or an ending
through an Exit with **Allow Back**, and its **Back** returns there.

A Main menu always has a **Story map** entry and Exit. Dragging that Exit
to a Story map Scene makes the entry work; until then it shows disabled,
the way Continue does before there is a save. It is a Navigation Exit, so a
game can be published while it goes nowhere; an author who does not want it
asks the Agent to remove it.

The map is drawn from the canvas's connections, not from where cards sit on
the canvas, so arranging the canvas never changes what players see. It
reads from the Start down: each Scene sits one row below the Scenes that
lead to it, and branches spread side by side. What it leaves out:

- Exits with **Allow Back** lead to side screens, such as an archive, and
  Navigation Exits lead around the game, so neither is a step in the story;
- connections back up the story, such as retrying after a failed QTE;
- Scenes the Story map Scene lists as off the map: by default the Main menu
  and itself, by their Template IDs. The Scenes before and after one are
  joined, so a menu between two Scenes links them directly.

Players see the Scenes they have reached, by name, and the Scenes one step
past them as locked **???**, with a line for each way they went and a count
of Scenes and endings found. What they have seen lasts across new games.

A Scene with no Exits other than Navigation ones is guessed to be an ending.
Everything the map cannot guess, such as which Scenes are off it, which are
endings, and names players should see instead of titles, is the Story map
Scene's own code, like how it looks: the author asks the Agent. The canvas
shows none of it; OhMyGame keeps only what the player has seen.

The Game panel shows what the author has played.

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
2. **Media through the chat.** The author attaches a file or names a Library
   asset in the chat and says where it goes; the Agent declares it on the
   Scene and shows it there.
3. **Where used.** Asset Canvas can show which Scenes use an asset. This can
   come after v1.

If real use shows authors constantly switching between the two workspaces,
an asset side panel on the Flow canvas can be reconsidered then.

## Design decisions

### Templates

v1 ships eight Templates (Presets). Each contains starter source that
already uses the Project Style, its expected Signals, a one-line summary
for the author, and a brief that tells the Agent what the author usually
wants next. The brief is not shown to the author. Each Template's picture in
**Add a Scene** is a capture of the Scene it creates: the starter source
with the default Project Style and its bundled Last Bus artwork. The Story
map picture shows a sample story partly played, since a new one has nothing
seen to show, and the Visual Novel picture shows its first line of dialogue.

| Template  | Starter content                                        | Starter Signals        |
| --------- | ------------------------------------------------------ | ---------------------- |
| Blank     | The background; a click or the video's end continues   | `next`                 |
| Main menu | Title, tagline, entries, Load, and Settings over the background | `start`, `story-map`   |
| Choice    | A subtitle line and answer bars that can read State    | `option-a`, `option-b` |
| QTE       | A key to press before a ring runs out                  | `success`, `fail`      |
| Hotspot   | A picture with pulsing spots, one Signal per spot      | `door`, `window`       |
| Ending    | Stamped ending title, closing lines, and Play again    | none                   |
| Story map | The branches seen so far, locked ones, endings found   | none (Back)            |
| Visual Novel | Lines from `script.txt` with names and characters, then answers | `option-a`, `option-b`, `title` |

Starter Signals are ordinary declared Signals; the author or Agent renames
and adds them freely. The set follows the old editor's story nodes: Open UI
became Main menu, Scene and the Continue interaction folded into Blank, and Start,
Condition, and Update State are not Templates because the Start badge, Scene
code, and Exit conditions cover them. Other screens, such as an archive or a
small game, start from Blank plus a description.

Templates live in OhMyGame, not in projects. Creating a Scene copies the
Template's source into `nodes/<id>/`; later Template changes do not affect
existing Scenes. The shared files a Template brings, such as the Visual Novel
player, are written only when the project lacks them, and OhMyGame never
updates them afterwards: like the Scene's own files, they are the author's.

### Main menu

The Main menu is the game's title screen: **Start**, **Continue**, **Load**,
**Story map**, and **Settings**. Start begins a new game; Continue returns to
the saved game and shows disabled until there is one.

- **Load** lists the slots that hold a game, with when each was saved and
  its note, such as the line a Visual Novel was on. Picking one continues
  that game. Load shows disabled until a slot holds a game, and a slot saved
  by another version of the game shows but cannot be loaded.
- **Settings** has a slider for each of the player's preferences: music and
  sound volume, which the Runtime applies everywhere. A game that reads more,
  such as a Visual Novel's text speed, can have a slider for it here too.

Load and Settings open over the menu and close with **Back** or Esc. They are
the Scene's own code, with no Exit, so the author asks the Agent to change or
remove them like any other part of the Scene.

### One story, many kinds of Scene

A Visual Novel chapter, a film shot with a choice, a QTE, and a phone the
player looks through are all Scenes. They connect by Exits in any order, and
they share what the game remembers: Variables, the save and its slots, the
music, and the player's settings. A story can open on a film Scene, continue
into a Visual Novel chapter, and end on a QTE without anything to switch.

### Visual Novel Scenes

A Visual Novel Scene plays its own script, so a chapter of dialogue is one
Scene and its answers are its Exits. The author writes the lines in
`nodes/<id>/script.txt`, edited in the **Code** tab or through the Agent:

```text
@bg street
@show mio smile left
@music rain
The rain had not stopped since noon.
mio: You came alone.
? [trust >= 3] I trust you. -> trust-her {trust += 1}
? Who else would come? -> walk-away
```

Each line is one step: a command (`@bg`, `@show`, `@hide`, `@music`, `@sfx`,
`@set`), a line of dialogue (`who: words`), narration, an answer (`? words ->
exit`), or an exit (`-> exit`). Answers and exits may carry a condition on a
Variable, and answers may change Variables. The full format is at the top of
`shared/vn/player.js`. Characters, with the name players see, its colour,
and a picture (an image Asset) for each look, are listed once in
`shared/vn/characters.json`.

The player is ordinary shared project source under `shared/vn/`, like the
Project Style: the first Visual Novel Scene adds it, and from then on it is
the author's. OhMyGame never updates it, so a project keeps the player it
started with; ask the Agent for anything a newer one does. Changing
`player.css` restyles every Visual Novel Scene. It types each line out and advances on a click, Space, or
Enter. Its quick menu has:

- **Save** and **Load**: twelve slots, each showing when it was saved and
  the line it was saved on. Only a slot that holds a game this version can
  play can be loaded.
- **Auto**, **Skip**, and **Log**, the Scene's lines so far.
- **Settings**: music and sound volume, text speed, and how long Auto waits.
  They are the player's, kept across games.
- **Title**: the Scene's `title` navigation Exit, usually to the Main menu.
  It shows disabled until it is connected.

An answer whose Exit is not connected shows disabled. A script mistake, or an
Asset, Variable, or character the script uses but the project does not
declare, stops the Scene when it opens, naming the line.

The game saves at every line, so Continue or a loaded slot returns to the
line the player was on, with the background, characters, and music as they
were. Variables the script changes are saved when the Scene is left; until
then the Scene works them out again from its start, so nothing is counted
twice. A save made before the script was edited starts the Scene over.

Music from `@music` plays on into later Scenes until a script changes it, and
turns down while a video with sound plays, such as a cinematic Scene's
background, so Visual Novel and interactive film Scenes mix in one game.

### Video and image Scenes

"Advance when the video ends" is Scene content, not a Runtime feature. The
Project Style includes a small `playScene()` component that shows the
Scene's background and emits a given Signal when the player moves on. A Scene
another Scene opened with Allow Back can pass `onDone` instead, such as
`(context) => context.navigation.back()`, to return there:

- A video plays to its end, as in an interactive film. A click does not cut
  it short. Over a video the player has seen before
  (`context.story.seenBefore`), the Scene's `[data-skip]` button shows and
  moves on.
- A still image, or no background, moves on with a click, and the Scene's
  `.continue-hint` shows.
- A video that fails to load or cannot start playing falls back to a click,
  so the player is never stuck.

Blank uses it, with its hint and Skip button in its HTML so they can be
reworded in the project's language. Authors who want something else (a
choice over the last frame, a loop until input) change the Scene like any
other.

This keeps the Runtime free of media-ended and timer transitions while the
most common interactive-film case needs no code.

Every Scene has one background: a `.backdrop` element
(`data-media="backdrop"`) whose `data-asset` and `data-type` say what it
shows. Blank is only the background; the other Templates put their content
over it. The Agent sets the background by writing those two attributes in the
Scene's HTML. `showBackdrop()` plays it the same way
everywhere: a video plays once with sound and stops on its last frame, an
image stays still. Exits decide when to move on.

### Trimming a background video

The Agent trims a Scene's background video when asked: “Keep 3.2 through 8.75
seconds of this Scene's background video.” It writes `data-clip-start` and
`data-clip-end` on the Scene's `.backdrop`; no new video is generated or
transcoded, and a range that isn't valid fails the Scene's check.

The trim belongs only to this Scene. Other Scenes using the same video and
the Library original stay intact. At the out point a Blank Scene takes its
existing next Exit. A Choice or other Scene keeps its existing behavior,
usually holding the last frame while waiting for input. The same range plays
in the Game panel and the published game. Publishing includes the original
video, so trimming does not reduce the download size.

### Multi-Scene Agent changes

The Agent may create several Scenes and Exits in one turn. The turn
review below is not built yet.

- Before each Agent turn, the editor records a checkpoint of `graph.json`,
  `editor/layout.json`, and the Scene and `shared/` source files.
- After the turn, the canvas highlights the change set: new Scenes and
  connections marked **New**, changed Scenes marked **Edited**, removed ones
  listed in a
  summary bar.
- The summary bar offers **Keep** and **Undo turn**. Undo restores the
  checkpoint. Continuing to edit implicitly keeps the change.
- New Scenes without a position in `editor/layout.json` are placed in the
  next free grid slot when the project is read. Slots fit the Scene card's
  screen shape and title, with a gap, and skip any position that would overlap
  an existing card, including cards moved off the grid. Saved positions stay
  where they are, and positions of removed Scenes are dropped. The Agent does
  not need to compute layout.

### Asset versions

The project has no separate version concept. A project Asset ID points at
exactly one Library asset. Choosing a better image means pointing that
project Asset ID at a different Library asset with **Replace**.

- Scenes that should change together share one project Asset ID.
- A Scene that must keep an image while others change uses a different
  project Asset ID, for example `club-background-night`.

This gives both "update everywhere" and "keep this one" without a pinning
system.
