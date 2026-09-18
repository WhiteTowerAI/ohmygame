# Runtime

## Project shell

`npm run dev` starts the renderer and daemon:

- the React renderer on `http://127.0.0.1:43120`
- the Fastify daemon on `http://127.0.0.1:43110`

Vite proxies the renderer's `/api` requests to the daemon. On load, the
renderer restores the last project ID from local storage or creates a new
project, subscribes to its event stream, and leaves the preview waiting until
the workspace becomes runnable. After a successful Pi turn creates a
`package.json` whose `scripts.dev` starts a web server, the daemon starts the
workspace preview. Commands clearly used for formatting, linting, testing, or
building are not run as previews. Pi events populate the conversation on the
left while preview lifecycle events control the iframe on the right.

The daemon configures Node's HTTP dispatcher from uppercase or lowercase proxy
environment variables and excludes localhost. The outer renderer ignores
`.data` and `dist` changes so workspace edits and verification builds do not
reload the project shell. A generated workspace still updates its own preview.

## API

- `POST /projects` creates an empty workspace.
- `GET /tools` lists the fixed local tool catalog.
- `POST /tools/generate-image/runs` generates one image with GPT Image 2 and
  stores the completed run outside project workspaces.
- `POST /tools/image-to-3d/runs` submits a PNG or JPEG to Meshy and stores the
  resulting textured GLB.
- `GET /tool-runs/:runId/files/:fileName` returns a generated tool output.
- `GET /projects/:id` returns authoritative current state.
- `POST /projects/:id/preview` starts or restarts the development server and
  returns `409` while the workspace has no `package.json` `scripts.dev` that
  starts a preview server.
- `POST /projects/:id/prompts` starts a Pi coding turn.
- `POST /projects/:id/cancel` aborts the active turn.
- `GET /projects/:id/conversation` returns the current Pi session branch as a
  normalized UI timeline and the SSE cursor to continue from.
- `POST /projects/:id/publish` builds and uploads static output to the remote
  Publish v1 service, then lists the resulting Game.
- `GET /community/games` proxies the public remote Community list.
- `GET /projects/:id/events` streams replayable SSE events.

The local API above is the current single-user runtime. The separate public
publishing contract is documented in [`publish-v1.md`](publish-v1.md). It keeps
immutable deployments and Community discovery as distinct remote resources and
does not expose Pi or workspace data.

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
directory, but `cwd` is not an operating-system security boundary. Enabled Pi
tools execute without an OhMyGame approval prompt; the Tools page controls
which custom tools are exposed to the session.

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

`project.json` stores project identity and the latest remote publication
identity. Pi owns the append-only files inside `session/`. On startup the daemon
scans these directories, migrates older
workspace-only projects by writing missing metadata, and initializes runtime
state as idle and waiting. The renderer waits briefly for the daemon,
reconnects to the in-memory event stream, and refreshes authoritative project
state.

Published artifacts and Community data live in the remote Publish v1 service.
The local project stores only:

```text
publication: { gameId, deploymentId, playUrl, publishedAt }
```

A project may have many immutable remote Deployments, while its Game points to
only the latest one. The daemon receives absolute play URLs from the
service and never sends the workspace, Pi session, conversation, or credentials.

Publish does not require an OhMyGame manifest or template. A workspace is
publishable when it either has a non-empty `scripts.build` that produces a
static `index.html` under `dist`, `build`, or `out`, or has a root
`index.html`. Hidden files, dependencies, and symbolic links are not archived.
Binary assets are preserved byte-for-byte.

Standalone tool runs are stored separately:

```text
tools/runs/<run-id>/
├── run.json
└── output.webp
```

Image generation uses the selected `provider + model` through the provider's
OpenAI-compatible Images API. The available models are the intersection of the
provider's `/v1/models` response and OhMyGame's supported image model
definitions. Provider credentials stay in the daemon. Tool runs are not added
to project workspaces until the user chooses Add to Project. Enabled tools are
also available to Pi through the existing custom-tool integration.

Image to 3D uses the authenticated OhMyGame account connection and New API's
provider-independent 3D endpoint. Meshy 7 supports text and one-to-four-image
generation; Meshy T2 supports single-image generation. Meshy credentials,
including Meshy 7's private preview/refine stages, remain inside New API and
are never exposed to the desktop application.
The completed `model.glb` is downloaded into the local tool-run directory, so
downloads and project assets do not depend on an expiring provider URL.
