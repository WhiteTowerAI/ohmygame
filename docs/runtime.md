# Runtime

## Project shell

`npm run dev` starts two local processes:

- the React renderer on `http://127.0.0.1:43120`
- the Fastify daemon on `http://127.0.0.1:43110`

Vite proxies the renderer's `/api` requests to the daemon. On load, the
renderer restores the last project ID from local storage or creates a new
project, subscribes to its event stream, and starts the workspace preview. Pi
events populate the conversation on the left while preview lifecycle events
control the iframe on the right.

The daemon configures Node's HTTP dispatcher from uppercase or lowercase proxy
environment variables and excludes localhost. The outer renderer ignores
`.data` and `dist` changes so workspace edits and verification builds do not
reload the project shell. A generated workspace still updates its own preview.

## API

- `POST /projects` creates a workspace from `template/starter`.
- `GET /projects/:id` returns authoritative current state.
- `POST /projects/:id/preview` starts or restarts Vite.
- `POST /projects/:id/prompts` starts a Pi coding turn.
- `POST /projects/:id/cancel` aborts the active turn.
- `GET /projects/:id/events` streams replayable SSE events.

The event stream exposes a small runtime contract rather than Pi's internal
event objects:

- `assistant.delta`
- `agent.retrying`
- `tool.started` and `tool.completed`
- `agent.completed`, `agent.cancelled`, and `agent.error`
- project and preview lifecycle events

The daemon keeps the most recent 1,000 events in memory and appends the full
normalized stream to each project's `events.jsonl`. Reconnects inside the hot
window use memory; older cursors replay from disk. Preview dependencies are
installed the first time a workspace starts; restarts reuse the existing
installation.

This milestone runs Pi in trusted-local mode. The workspace is Pi's working
directory, but `cwd` is not an operating-system security boundary.

## Electron shell

`npm run dev:desktop` starts Vite and Electron. Electron starts the compiled
daemon itself on an available loopback port, waits for `/health`, and passes
the daemon address plus a random process-scoped token through the isolated
preload bridge. The renderer connects directly with the token while the
browser-only development mode continues to use Vite's `/api` proxy.

Electron main owns only desktop lifecycle and native IPC. Pi sessions,
projects, previews, and events remain in the daemon. Closing the last window
quits the application and gives the daemon time to stop active Pi and preview
processes before it exits.

## Persistence and recovery

Each project is self-contained under the daemon data directory:

```text
projects/<project-id>/
├── project.json
├── events.jsonl
├── workspace/
├── session/
└── snapshots/
    ├── pending/
    └── previous/
```

`project.json` stores project identity, Pi owns the append-only files inside
`session/`, and `events.jsonl` is the renderer's bounded normalized timeline. On
startup the daemon scans these directories, migrates older workspace-only
projects by writing missing metadata, and resets stale runtime state to idle or
stopped. The renderer waits briefly for the daemon, reconnects with an event
cursor, and then refreshes authoritative project state.

Before each Pi turn, the daemon writes `snapshots/pending` without
`node_modules`. When the turn ends, a content digest promotes it to
`snapshots/previous` only if workspace files changed; a conversation-only turn
therefore does not consume the existing undo. Undo restores that one snapshot,
preserves installed dependencies, restarts the preview, and then consumes the
snapshot. This is intentionally one-level workspace undo, not a version
history system and not a rewind of Pi's conversation.
