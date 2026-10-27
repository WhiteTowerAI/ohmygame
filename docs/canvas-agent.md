# Canvas And The Agent

Design and Asset Canvas share a project directory the agent edits with its ordinary file tools.
The canvas renders those files and autosaves user edits into the same sources.
The agent can initialize a canvas when design or asset work needs it, without
requiring the user to open Design first.
The agent shows final media deliverables on the relevant board, reusing existing
nodes and asset IDs. Local media can reference existing project-relative paths.

Creation templates appear beside Explore as five example cards: Pixel game assets,
Character reference sheet, Character outfits & skins, Character continuous scenes,
and Character action set. Each opens an Asset Canvas board with a visible introduction text node, an
editable image generator, and a separate image upload node where a reference is
required. Opening a template does not start generation. The user describes or
uploads input on the canvas and generates there. Image input panels follow the
same selection behavior as other image nodes.

Introduction nodes reuse the existing `text` node type, carry an
`asset-canvas-template:<id>` instruction marker, and show example art and output
guidance. Character reference sheet and Character outfits & skins introductions
show text guidance only. The other introductions and all five launcher covers reuse the
bundled example images shown on the template's image nodes. Multiple
asset types, sequence modes, and actions appear together in grids; individual
images fit in full without cropping. Introduction panels size to their content, including on saved
boards with an older fixed introduction height, so all guidance is visible without
extra space below it.
Pixel game assets opens with character and style reference inputs at the top,
followed by four category groups: Characters (side-view, RPG, portrait), Creatures
(monster, animal), Environments (scene, terrain, building), and Items (prop, icon).
Each row contains the corresponding generators, all linked to both references.
The image model must accept at least two reference images. Character continuous
scenes opens with separate continuous-action and consistent-scene image nodes. Both templates lay out all
their nodes when the board is created; the examples in the introduction do not
add nodes. Character sheets and Character outfits & skins are separate templates.
The latter has separate person and clothing image inputs and a prefilled editable prompt;
its image model must accept two references. Older reskin nodes keep their
single-image behavior. Pixel art, character sheets, and character sequence
generators show their complete editable prompt in the node; generation sends
that prompt as written. Their image references remain linked to the shared
reference input. The two character sequence modes share one image reference per
board. Character continuous scenes produce a static 4×3 action sheet or 3×3 scene
grid. Action set has six prepared prompts, each producing one static action sheet from the same reference.
Its examples are arranged in two rows: idle, walk, run; then attack, hurt, down.
New template projects show bundled example images on every image node. Pixel game
assets, Character outfits & skins, Character continuous scenes, and action set
use a bundled character sheet in their replaceable reference node. Pixel assets
also include a style example; Character outfits & skins include a clothing example. Each output node displays the image matching its preset or action.
Character sheets have no reference node. They prefer a 16:9 output with a
dominant main portrait on the left and smaller front/side/back turnaround, three
distinct expressions, and costume or equipment details on the right. Generation
only runs when requested and an image model is available. Each new template board places all example inputs
and outputs inside one group named **Template examples** (localized in the UI).
Pixel assets contain the four category subgroups within this outer group.
The introduction stays outside the group. Grouping preserves the node references
and their positions on the canvas.
Model, resolution, aspect ratio, and prompt controls stay in the shared image
generator. The example art illustrates formats rather than guaranteed model output.
Existing boards retain their earlier
`asset-canvas-template:free-image:<style>` markers and can still be read without
rewriting saved nodes.

```text
canvas/
  AGENTS.md
  README.md
  index.json
  boards/<board-id>.json
  documents/<document-id>.md
  tables/<table-id>.json
  assets.json
  editor/<board-id>.json
  schemas/{index,board,layout,assets,table}.schema.json
  jobs.json
assets/
```

`index.json` names boards, documents and optional tables. A board contains stable node IDs,
optional `title` and `description`, content, and references. Markdown bodies
are shared between document nodes. Connections for prompts and media are
derived from `promptSource`, `images`, `references`, and `source`.

Boards may also contain `group` nodes with `data.name`. A grouped node stores
`parentId` pointing to a group on the same board, and its layout position is
relative to that parent. Groups can be nested, but parent chains cannot form a
cycle. Group frames have width and height in `editor/<board-id>.json`. The editor
supports grouping selected nodes, ungrouping, dragging nodes between groups,
copying group trees, and undo/redo. Deleting a group deletes its descendants.
Media toolbars move below the node when there is insufficient room above it.
When the generation form is open, the lower toolbar sits after the form and
follows its height and canvas zoom so it does not cover the inputs.
Select two or more nodes and use Group in the floating selection toolbar or Cmd/Ctrl+G to group them;
selecting one group shows a toolbar beside its frame with Run group (starts generation
for executable descendants, including nested groups) and Ungroup. The floating toolbar
also shows Ungroup when multiple selected nodes include a group.
Run group executes up to three ready nodes concurrently, including text nodes.
Nodes wait only for their own generation references; media jobs must finish and
their saved outputs must be synchronized before dependent nodes can start.
Failed or cancelled nodes cause their dependents to be skipped; independent nodes
still run. Circular generation references prevent the batch from starting.
Text nodes use their own selected model, falling back to the default text model.
Shift+Cmd/Ctrl+G ungroups selected frames. Double-click a group heading to name
it, and drag the heading to move its entire tree. The empty frame interior
allows marquee selection of its children. Dropping a node with its center
inside a frame adds it to the deepest containing group; dropping completely outside
removes it from that group. A frame expands after a child is moved across its
edge, up to the 4096 × 4096 layout limit. Frames also support manual resizing.
Shrinking a frame stops at the bounds of its children; resizing from the top or
left keeps the children fixed in canvas coordinates.

Generation nodes use these semantic board fields (runtime state and visual size
do not belong in the board file):

- `speech`: `text`, optional `promptSource`, `model`, `voiceId`, `speed`, and
  generated `assetId`;
- `sound-effect`: `prompt`, optional `promptSource`, `model`, `durationSeconds`,
  `loop`, `negativePrompt`, and generated `assetId`;
- `music`: `prompt`, `instrumental`, optional `promptSource`, `model`, `lyrics`,
  `durationSeconds`, `loop`, and generated `assetId`.

The editor's Add menu and the agent's active tools expose an audio operation only
when the current audio catalog has a configured, enabled model advertising that
operation. Existing nodes remain valid if that provider later becomes unavailable.

Text and Document nodes accept up to 14 connected Text, Document, Image or image
Asset nodes in `references` (`{ "type": "node", "nodeId": "..." }`). These
connections supply source material to AI generation. Connecting an image to a
Document adds a generation reference; use Insert image to put it in the Markdown.
Generation saves the current board and documents first, then reads the referenced
nodes' saved text, Markdown and actual image output from the workspace. Image
references require a language model that accepts images. A node cannot reference
itself or, for Document nodes, another node pointing to the same document.

Positions, zoom and the width/height of text, document, table and group nodes live in
`editor/`. Media and generation nodes size to their content: the editor ignores
a width/height on them and canvas_check reports it. New nodes get positions
automatically.
The agent usually edits only the semantic files. Deleting a board or node
keeps its documents, tables and media.

Table nodes reference `tableId`; the JSON table is shared across boards. Each
column has a stable ID, title, type (`text`, `number`, `boolean`) and optional
width. Each row has a stable ID and `cells` keyed by column ID. Missing cells
and `null` mean empty. Keep IDs stable when changing data. Tables support up to
1,000 rows and 100 columns. Different cells merge independently; competing
cell edits, deletion versus editing, or incompatible type changes require a
version choice. Invalid or removed files preserve unsaved local table drafts.

The editor supports wrapping cells, fixed headers, column resizing, table
undo/redo, CSV import/export and rectangular TSV paste from spreadsheets. CSV
imports replace the contents and keep values as text to preserve leading zeros;
change column types explicitly when needed. Table undo is separate from board
layout undo. Text, document and table nodes can be resized in pointer mode,
reset to their default size, or opened for expanded editing.

Table cards show a read-only preview with the same header, reading frame and
footer as document nodes. Edit opens the expanded spreadsheet; Expand opens a
larger preview with an edit toggle. Selected nodes and expanded tables share an
AI instruction composer and model settings. Complete, validated AI output is
applied only when the saved source is unchanged. Otherwise it remains a candidate
for explicit adoption. Invalid or incomplete output preserves the table, and AI
instructions and valid candidates survive reloads. Adopting an AI draft is one
table undo step.

Canvas generation prompts use Enter to generate and Shift+Enter for a new line.
Enter confirms an active input-method composition or a video `@` reference
suggestion before it can generate. Text and document content, negative prompts,
and lyrics keep ordinary multiline editing.

`assets.json` maps asset IDs to readable names and project-relative paths.
Descriptions describe purpose; prompts record generation instructions.
Neither is a verified description of image pixels. The agent reads local
images when it needs to inspect appearance. The shared canvas reference type
`library` resolves through this project manifest; `libraryAssetId`
records the origin of an imported or generated file.

Canvas media downloads use the node's custom `title` as the filename, falling
back to the original asset name when the title is blank or unusable. The preview
and context menu use the same name. Downloads retain the asset extension, remove
unsafe filename characters, handle reserved device names and limit the full name
to 200 UTF-8 bytes. Renaming a node does not rename the workspace file or shared
Library asset; adding the asset to another project still uses its asset name.

The editor supplies the current board path and selected node IDs as a
removable chat context. The agent reads current files before making changes.
Concurrent edits to different fields merge; competing edits require the user
to choose a version. A node type change is adopted as a whole when the other
version of that node is unchanged; competing edits during a type change require
a version choice. If combined edits create invalid node references, the editor
also requires a version choice and preserves the local recovery draft.
Invalid external edits leave the last valid canvas
visible with diagnostics. External node changes enter the canvas undo history.

Asset Canvas has **Canvas** and **Code** navigation. Code shows the workspace
files and stays accessible when canvas loading or saving fails. Switching
views keeps the canvas session, document generation state and local drafts.

Missing media files do not prevent the workspace from opening or the board
from being saved. The affected node keeps its ID and references, shows the
missing path, and can check the file again. Restoring the file also refreshes
its preview automatically. Generation, image insertion and export validate
the files needed for that operation; unrelated missing assets do not block it.
Deleting a node keeps the resource registration and file for reuse and undo.
An unused registration for a missing file does not block the editor. Remove
such a registration only after checking other boards and document links.
`canvas_check` still reports missing files as diagnostics.

Loading, background synchronization and saving have separate recovery actions.
An initial load failure can reload the canvas. A failed background read keeps
the last valid board interactive and retries synchronization. A failed save
keeps the local recovery draft and can retry saving. Competing edits show
version choices without covering the canvas; choosing a version runs through
the same serialized storage session as saving and synchronization. Missing
document files or index entries also preserve unsaved Markdown drafts until
their sources are restored.

Document AI generation saves complete output only when the source document has
not changed. Truncated or interrupted text stays in an editable candidate draft,
with the specific failure reason, and never replaces the document automatically.
Candidates can be copied, discarded or explicitly adopted through the normal save
flow. Instructions, model settings and candidates are kept locally across reloads.
Retrying keeps the current candidate until another text result arrives; retry
results also require review. Responses with no document text preserve the document
and instruction and allow retrying or choosing another model. Thinking and tool
output are never used as document Markdown.

Three tools supplement ordinary file editing:

- `canvas_initialize` creates the file contract and an empty board on demand,
  preserving existing content. It is unavailable in planning mode.
- `canvas_check` validates schemas, document/table references, asset paths and media
  types. It is read-only and available in planning mode.
- `generate_canvas_media(boardId, nodeId)` executes the saved node settings
  when generation is requested, including necessary media for a game-creation
  request unless the user limits its scope. It shares canvas jobs, cancellation and
  history, materializes output in the project, and writes the output ID back
  to the node. Changing a file does not start generation.

## Migrating Existing Projects

Stop OhMyGame, then run the migration against its data directory:

```sh
bun scripts/migrate-canvas-workspaces.ts .data
```

The script backs up old Design directories and Asset Canvas files under
`<data-directory>/canvas-backups/`, separates layout files and materializes
Library references. IDs, Markdown, media and layout are preserved. It leaves
current projects alone. The application only reads the current format.

Both editors share nodes, documents, metadata, generation, history, clipboard,
file uploads and external file synchronization. Asset Canvas starts with one
board and supports additional boards for separate asset workflows. The main
home page, below Recent Projects, and the Asset Canvas home show examples for
Game Assets, Character Sequences, and Character Action Set. Opening one creates a board
without starting image generation. Each board has a guide and editable
generation nodes. The Game Assets board lays out ten pixel-style generators,
and Character Sequences lays out its continuous-frame and consistent-scene
generators beside a shared character reference. Every node is present when the
board opens; the guide examples only explain the output formats. Model, size,
and prompt settings remain in each generator and its form follows normal node
selection. The result is
a static image grid that can be split into frames and composed as a GIF. Character
Action Set uses one reference image across six separate sprite-sheet image nodes.
These outputs are static images and require an image provider that supports
references. A selected image can start either action workflow on a new board in
the same project. Asset Canvas retains automatic covers and sending assets to
projects. Game projects expose multiple boards and an optional main game design
document.

Dropping, pasting or uploading files imports Markdown and text files as
documents (up to 1 MB) and CSV or TSV files as tables (up to 4 MB). Images
(PNG, JPEG, GIF, WebP, AVIF, SVG), video (MP4, MOV, WebM), audio (MP3, WAV,
Ogg, M4A) and GLB models go to the Library as asset nodes, up to 200 MB each;
`src/shared/media-files.ts` lists the media types, and the daemon checks each
file's data against its type. Any other file, such as a source file, font,
archive or editor project, is copied into the project under `assets/files/`
(a repeated name gets a `-2` suffix) and shown as a file node whose
`data.path` is that project-relative path. File nodes stay in their project:
pasting one into another project is refused. `canvas_check` reports a file
node whose file is missing. System files such as `.DS_Store`, `__MACOSX` and
hidden entries inside a dropped folder are left out.

Dropping or pasting a folder asks first, because a folder is easy to drop by
mistake. **Import folder** copies it into `assets/files/<folder>/` with its
structure intact, so files that refer to each other by relative path (a glTF
with its textures, a sprite atlas, an engine asset pack) keep working, and adds
one folder node (`data.directory: true`). A repeated folder name gets a `-2`
suffix. Folder imports take up to 5,000 files and 2 GB at a time.
**Import files separately** imports each file as above, and **Cancel** imports
nothing.

Hold Option (Alt on Windows and Linux) when starting a node drag to pull out
copies. Copies keep node content and Library resources, use new IDs, and drop
all connections, including connections within a copied selection. The originals
stay in place. Releasing at the starting position cancels the copies; a completed
drag is one board undo step. If the copies would exceed the 2,000-node limit,
the editor rejects the drag and keeps the originals in place.
