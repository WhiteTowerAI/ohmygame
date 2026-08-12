# Runtime

## Project shell

`npm run dev` starts two local processes:

- the React renderer on `http://127.0.0.1:43120`
- the Fastify daemon on `http://127.0.0.1:43110`

Vite proxies the renderer's `/api` requests to the daemon. On load, the
renderer restores the last project ID from local storage or creates a new
project, subscribes to its event stream, and leaves the preview waiting until
the workspace becomes runnable. After a successful Pi turn creates a
`package.json` with a non-empty `scripts.dev`, the daemon starts the workspace
preview. Pi events populate the conversation on the left while preview
lifecycle events control the iframe on the right.

The daemon configures Node's HTTP dispatcher from uppercase or lowercase proxy
environment variables and excludes localhost. The outer renderer ignores
`.data` and `dist` changes so workspace edits and verification builds do not
reload the project shell. A generated workspace still updates its own preview.

## API

- `POST /projects` creates an empty workspace.
- `GET /projects/:id` returns authoritative current state.
- `POST /projects/:id/preview` starts or restarts the development server and
  returns `409` while the workspace has no `package.json` `scripts.dev`.
- `POST /projects/:id/prompts` starts a Pi coding turn.
- `POST /projects/:id/cancel` aborts the active turn.
- `GET /projects/:id/events` streams replayable SSE events.

The event stream exposes a small runtime contract rather than Pi's internal
event objects:

- `assistant.delta`
- `agent.retrying`
- `tool.started` and `tool.completed`
- `agent.completed`, `agent.cancelled`, and `agent.error`
- preview lifecycle events

The daemon keeps the most recent 1,000 events in memory. SSE reconnects can
replay events still inside that window, but the renderer timeline intentionally
starts empty after a daemon restart. Pi's own session remains persistent.
Preview dependencies are installed the first time a runnable workspace starts; restarts
reuse the existing installation.

This milestone runs Pi in trusted-local mode. The workspace is Pi's working
directory, but `cwd` is not an operating-system security boundary.

## Electron shell

`npm run dev:desktop` starts Vite and Electron. Electron starts the compiled
daemon itself on an available loopback port, waits for `/health`, and passes
the daemon address plus a random process-scoped token through the isolated
preload bridge. The renderer connects directly with the token while the
browser-only development mode continues to use Vite's `/api` proxy.

Electron main owns only desktop lifecycle. Pi sessions, projects, previews,
and events remain in the daemon. Closing the last window quits the application
and gives the daemon time to stop active Pi and preview processes before it
exits.

## Persistence and recovery

Each project is self-contained under the daemon data directory:

```text
projects/<project-id>/
├── project.json
├── workspace/
└── session/
```

`project.json` stores project identity, Pi owns the append-only files inside
`session/`. On startup the daemon scans these directories, migrates older
workspace-only projects by writing missing metadata, and initializes runtime
state as idle and waiting. The renderer waits briefly for the daemon,
reconnects to the in-memory event stream, and refreshes authoritative project
state.
