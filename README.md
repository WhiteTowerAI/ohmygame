# OpenGame

The current milestone is a local-first creation and publishing loop: a Pi
coding session on the left, a live preview on the right, and a self-hosted
Community backed by immutable game deployments.

## Development

Requires Node.js 22+. Pi reads the user's existing Pi credentials.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:43120`. The renderer starts or restores a project,
connects to the local daemon, and starts its preview automatically.
The daemon honors both uppercase and lowercase `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY` variables while always keeping local runtime traffic off the proxy.

Run `npm test`, `npm run typecheck`, and `npm run build` to verify the runtime.

The daemon also exposes a standalone GPT Image 2 tool. Copy `.env.example` to
an ignored `.env.local` and set `OPENAI_API_KEY` to enable image generation:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

Existing shell environment variables take precedence over `.env.local`. The
key remains in the daemon and is never exposed to the renderer, Pi, or project
workspaces. Set `OPENAI_BASE_URL` to the `/v1` root of an OpenAI-compatible
service when using a non-OpenAI API key.

Projects, workspaces, and Pi sessions are stored under the daemon data
directory. Restarting the daemon restores the same project, Pi context, and
conversation shown in the Project Shell.

## Publishing

Project Shell exposes one Publish action. The daemon runs a project's existing
`build` script when present, or publishes a root `index.html` workspace
directly. Every successful publish creates a new immutable deployment, verifies
its playable URL, and only then creates or updates the Community game.

Development uses a separate local play server on port `43111`. Each deployment
has its own `http://<deployment-id>.localhost:43111/` origin, so root-relative
assets work and games do not share browser storage. This is a local,
self-hostable reference backend, not an official public cloud. A public host can
set `PLAY_ORIGIN` to a wildcard-routed play domain while keeping the same client
contract.

## Desktop

```bash
npm run dev:desktop
```

Electron starts a managed daemon on an available local port, waits for its
health check, and then opens the same renderer. Closing the desktop window
stops the managed daemon and its preview process. `npm run start:desktop`
builds all three parts and runs the built renderer.

The desktop daemon uses a random process-scoped access token. The preload
bridge exposes only its runtime connection. Node.js APIs are not available to
the renderer.

The renderer defaults to `http://127.0.0.1:43120` and the daemon to
`http://127.0.0.1:43110`. Pi uses the user's existing Pi credentials. See the
runtime flow, API, and trusted-local security boundary in
[docs/runtime.md](docs/runtime.md).
