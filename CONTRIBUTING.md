# Contributing to OhMyGame

Thanks for helping. OhMyGame is in early alpha, so the most useful
contributions right now are bug reports with clear steps, small fixes, and
feedback from making real games with it.

## Before you start

- For a bug, search [existing issues](https://github.com/WhiteTowerAI/ohmygame/issues)
  first, then open one with the bug report template.
- For a new feature or a large change, open an issue to discuss it before
  writing code so implementation and product direction stay aligned.
- Issues labeled `good first issue` or `help wanted` are good places to start.
- Maintainers classify issues and PRs with shared type and area labels. See
  [.github/LABELS.md](.github/LABELS.md) for the workflow and label definitions.

## Development setup

Requires Bun 1.4.2 or newer for the toolchain and Node.js 22.19+ for the daemon.

```bash
bun install --frozen-lockfile
bun run dev            # web renderer + local daemon
bun run dev:desktop    # Electron app
```

See [Configuration](#configuration) for sign-in, publishing, and proxy
settings, and [docs/runtime.md](docs/runtime.md) for how the renderer,
daemon, and agent fit together.

## Configuration

### Sign-in (Supabase)

Product sign-in uses Supabase Auth with Google and GitHub. Enable both
providers in Supabase, add the renderer URL to the allowed redirect URLs, and
set these public values in `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key
```

When either value is missing, `bun run dev` and `bun run dev:desktop` on
localhost automatically use a local debug account. Click **Sign in** to sign in
immediately; signing out and restoring the session on reload also work.
Publishing builds the actual game and serves a temporary local snapshot, which
appears in Community. No Supabase or cloud service is needed. These games and
their local links are available only while the daemon is running; they are not
uploaded or publicly shared. Configuring both values restores real authentication
and cloud publishing. Production builds never enable the debug fallback.

For desktop OAuth, add
`http://127.0.0.1:*/auth/callback/**` to the redirect allow list. The desktop
app opens OAuth in the system browser and receives the result through a
temporary loopback server.

### Publishing against a local cloud

The Community website and Publish v1 service live in
[`ohmygame-cloud`](https://github.com/WhiteTowerAI/ohmygame-cloud). Point the
client at a local or preview deployment in `.env.local`:

```dotenv
CLOUD_API_URL=http://127.0.0.1:43130
```

The server contract is in
[`ohmygame-cloud/docs/publish-v1.md`](https://github.com/WhiteTowerAI/ohmygame-cloud/blob/main/docs/publish-v1.md).

### Projects, proxies, and the desktop daemon

- Projects, workspaces, and Pi sessions live in the daemon data directory. In
  the desktop app a project can use an existing folder as its workspace;
  removing the project never deletes that folder.
- The daemon honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (either case)
  and always keeps local traffic off the proxy.
- The desktop app starts a managed daemon on a free port with a random
  process-scoped access token. The renderer has no Node.js access.
- Desktop release signing and the update feed:
  [docs/desktop-releases.md](docs/desktop-releases.md).

## Checks

Run these before opening a PR:

```bash
bun run test
bun run typecheck
bun run build
bun run test:node-runtime
```

Add or update tests in `test/` when you fix a bug or add behavior.

## Formatting

When editing an existing file, match the surrounding style and keep formatting
changes limited to the code you touch. The repository has not been fully formatted
with Prettier, so a whole-file `prettier --check` is not required for edits to
existing files.

Use the repository's Prettier configuration for new files that Prettier supports.
Check those files before opening a PR:

```bash
bunx --bun --no-install prettier --check <new files>
```

Keep broad formatting cleanup in a separate PR. CI does not currently enforce
repository-wide formatting.

## Pull requests

- Keep each PR focused on one feature, one bug fix, one chore, or one
  refactor.
- Branch names: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`,
  `refactor/<short-name>`, or `docs/<short-name>`.
- PR titles use Conventional Commits, for example
  `fix(runtime): handle missing tween state`.
- The PR description says what changed, why it changed, and how it was
  checked. The PR template has these sections.
- Include a screenshot or short recording for UI changes.

## Security

Do not report security issues in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
