# OpenGame

The current milestone is a minimal local project shell: a Pi coding session on
the left and a live Vite preview of its isolated workspace on the right.

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

Projects, workspaces, and Pi sessions are stored under the daemon data
directory. Restarting the daemon restores the same project and Pi context. The
renderer timeline is intentionally kept in memory and starts empty after a
daemon restart.

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
