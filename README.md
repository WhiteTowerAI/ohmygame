# OpenGame

The current milestone is a local-first creation loop with remote publishing: a
Pi coding session on the left, a live preview on the right, and a public
Community backed by immutable game deployments.

## Development

Requires Node.js 22.5+. Pi reads the user's existing Pi credentials.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:43120`. The renderer starts or restores a project,
connects to the local daemon, and starts its preview automatically.
The daemon honors both uppercase and lowercase `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY` variables while always keeping local runtime traffic off the proxy.

Run `npm test`, `npm run typecheck`, and `npm run build` to verify the runtime.

The daemon also exposes an image generation tool. Connect OpenGame Portal or
OpenAI under Providers, then choose an available image model in the Images
tool. Provider credentials remain in the daemon and are never exposed to the
renderer or project workspaces.

Product sign-in uses Supabase Auth with Google and GitHub. To enable it in the
web renderer, enable both providers in Supabase, add the renderer URL to the
allowed redirect URLs, and set these public browser values in `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key
```

Without these values the app remains usable while signed out. For desktop
OAuth, add `http://127.0.0.1:*/auth/callback/**` to the Supabase redirect allow
list. The desktop app opens OAuth in the system browser and receives the result
through a temporary loopback server; Google and GitHub use the same Supabase
configuration as Web.

Projects, workspaces, and Pi sessions are stored under the daemon data
directory. Restarting the daemon restores the same project, Pi context, and
conversation shown in the Project Shell.

## Publishing

Project Shell exposes one Publish action. The daemon runs a project's existing
`build` script when present, or publishes a root `index.html` workspace
directly. It archives only the static output and uploads it to the configured
Publish v1 service. Later publishes reuse the same remote Game while creating a
new immutable Deployment.

For local development, this repository includes a minimal Publish v1 service.
Set the client and server settings in the ignored `.env.local`:

```dotenv
PUBLISH_API_URL=http://127.0.0.1:43130
SUPABASE_URL=https://your-project.supabase.co
```

Then start it alongside `npm run dev`:

```bash
npm run dev:publish
```

The public Community is a separate web app. During development, start it after
the Publish service and open `http://127.0.0.1:43140`:

```bash
npm run dev:community
```

It reads the public `/v1/community` API directly and provides shareable
`/games/:gameId` pages without requiring the local daemon. In production,
serve `dist/community-web` with history fallback and proxy `/v1` to the Publish
service. The included `vercel.json` configures the production build, API proxy,
and shareable game routes.

It listens on `http://127.0.0.1:43130` by default. Creator routes verify the
signed-in user's Supabase access token and use its `sub` as the publisher ID;
Community routes and published games are public. Data is stored under
`.data/publish`. This server implements the public protocol in
[docs/publish-v1.md](docs/publish-v1.md). `PUBLISH_API_URL` may instead point
the daemon at a separately hosted implementation. The user token is forwarded
only for the active publish request and is never stored by the daemon, written
to a project, sent to Pi, or included in the uploaded artifact.

The included `railway.toml` builds and starts the Publish service, uses
Railway's `PORT`, and checks `/health`. For a persistent deployment, attach a
volume at `/data`, set `PUBLISH_DATA_DIR=/data`, and configure the API domain
plus a wildcard play domain as described in [docs/publish-v1.md](docs/publish-v1.md).

## Desktop

```bash
npm run dev:desktop
```

Electron starts a managed daemon on an available local port, waits for its
health check, and then opens the same renderer. Closing the desktop window
stops the managed daemon and its preview process. Publishing uses the remote
service configured through the desktop process environment. `npm run start:desktop`
builds the desktop runtime and renderer without building the separate Community
Web app.

The desktop daemon uses a random process-scoped access token. The preload
bridge exposes only its runtime connection. Node.js APIs are not available to
the renderer.

The renderer defaults to `http://127.0.0.1:43120` and the daemon to
`http://127.0.0.1:43110`. Pi uses the user's existing Pi credentials. See the
runtime flow, API, and trusted-local security boundary in
[docs/runtime.md](docs/runtime.md).
