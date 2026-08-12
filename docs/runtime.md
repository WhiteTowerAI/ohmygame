# Runtime

## Project shell

`npm run dev` starts the renderer and daemon; the daemon also owns an isolated
game server:

- the React renderer on `http://127.0.0.1:43120`
- the Fastify daemon on `http://127.0.0.1:43110`
- the game server on port `43111`, with one
  `http://<deployment-id>.localhost:43111/` origin per deployment

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
- `GET /projects/:id/conversation` returns the current Pi session branch as a
  normalized UI timeline and the SSE cursor to continue from.
- `POST /projects/:id/publish` creates an immutable deployment, verifies its
  play URL, and creates or updates its Community game.
- `GET /community/games` lists published Community games.
- `GET /projects/:id/events` streams replayable SSE events.

The event stream exposes a small runtime contract rather than Pi's internal
event objects:

- `assistant.delta`
- `agent.retrying`
- `tool.started` and `tool.completed`
- `agent.completed`, `agent.cancelled`, and `agent.error`
- preview lifecycle events
- `publish.started`, `publish.completed`, and `publish.error`

The daemon keeps the most recent 1,000 events in memory. SSE reconnects replay
events still inside that window. On Project Shell load, persisted user,
assistant, and tool activity is restored from Pi's current session branch; the
event stream then continues from the returned cursor without duplicating prior
turns.
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

Published data lives outside the mutable workspace:

```text
deployments/<deployment-id>/
└── files/

community/games/<project-id>.json
```

A project may have many immutable deployments, while its Community game points
to only the latest verified one. Community records persist deployment identity;
play URLs are derived from the current play origin, so random local ports do not
become stale after restart. Each deployment has an origin separate from the
authenticated daemon and other games. The game server only serves deployment
files; it does not expose workspaces, Pi sessions, or daemon credentials.

Publish does not require an OpenGame manifest or template. A workspace is
publishable when it either has a non-empty `scripts.build` that produces a
static `index.html` under `dist`, `build`, or `out`, or has a root
`index.html`. Hidden files, dependencies, and symbolic links are not copied.
Binary assets are copied byte-for-byte.
