# Canvas And The Agent

Design and Asset Canvas share a project directory the agent edits with its ordinary file tools.
The canvas renders those files and autosaves user edits into the same sources.

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

Two tools supplement ordinary file editing:

- `canvas_check` validates schemas, document references, asset paths and media
  types. It is read-only and available in planning mode.
- `generate_canvas_media(boardId, nodeId)` executes the saved node settings
  when generation is requested. It shares canvas jobs, cancellation and
  history, materializes output in the project, and writes the output ID back
  to the node. Changing a file does not start generation.

## Migrating Existing Projects

Stop OhMyGame, then run the migration against its data directory:

```sh
npx tsx scripts/migrate-canvas-workspaces.ts .data
```

The script backs up old Design directories and Asset Canvas files under
`<data-directory>/canvas-backups/`, separates layout files and materializes
Library references. IDs, Markdown, media and layout are preserved. It leaves
current projects alone. The application only reads the current format.

Both editors share nodes, documents, metadata, generation, history, clipboard,
file uploads and external file synchronization. Asset Canvas uses one default
board and retains automatic covers and sending assets to projects. Game
projects expose multiple boards and an optional main game design document.
