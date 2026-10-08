# Canvas And The Agent

Design and Asset Canvas share a project directory the agent edits with its ordinary file tools.
The canvas renders those files and autosaves user edits into the same sources.
The agent can initialize a canvas when design or asset work needs it, without
requiring the user to open Design first.

```text
canvas/
  AGENTS.md
  README.md
  index.json
  boards/<board-id>.json
  documents/<document-id>.md
  assets.json
  editor/<board-id>.json
  schemas/{index,board,layout,assets}.schema.json
  jobs.json
assets/
```

`index.json` names boards and documents. A board contains stable node IDs,
optional `title` and `description`, content, and references. Markdown bodies
are shared between document nodes. Connections for prompts and media are
derived from `promptSource`, `images`, `references`, and `source`.

Positions and zoom live in `editor/`. New nodes get positions automatically.
The agent usually edits only the semantic files. Deleting a board or node
keeps its documents and media.

`assets.json` maps asset IDs to readable names and project-relative paths.
Descriptions describe purpose; prompts record generation instructions.
Neither is a verified description of image pixels. The agent reads local
images when it needs to inspect appearance. The shared canvas reference type
`library` resolves through this project manifest; `libraryAssetId`
records the origin of an imported or generated file.

The editor supplies the current board path and selected node IDs as a
removable chat context. The agent reads current files before making changes.
Concurrent edits to different fields merge; competing edits require the user
to choose a version. Invalid external edits leave the last valid canvas
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
- `canvas_check` validates schemas, document references, asset paths and media
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
file uploads and external file synchronization. Asset Canvas uses one default
board and retains automatic covers and sending assets to projects. Game
projects expose multiple boards and an optional main game design document.
