# Contributing to OhMyGame

OhMyGame is in beta. Bug reports, documentation improvements, small fixes,
plugins, and feedback from making real games are welcome.

This guide covers the path from choosing work to getting a PR reviewed.
See the [documentation index](docs/README.md) for module guides and the
[中文快速指引](docs/contributing.zh-CN.md) for a short introduction in Chinese.

## Choose something to work on

- Search [existing issues](https://github.com/WhiteTowerAI/ohmygame/issues)
  before reporting a bug. Use the bug report form and include reproduction
  steps, version, platform, and logs with credentials removed.
- Discuss new features and large changes in an issue before implementation.
  Small fixes and documentation corrections can go straight to a PR; an issue
  is useful when the intended behavior needs discussion.
- Look for [`good first issue`](https://github.com/WhiteTowerAI/ohmygame/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/WhiteTowerAI/ohmygame/labels/help%20wanted).
  If none fit, describe the contribution you have in mind in an issue.
- Ask questions and discuss ideas on [Discord](https://discord.gg/TkrgvGQ2Zc).
  Keep decisions and reproduction details in the related issue or PR so others
  can follow them.

Maintainers manage type, area, and progress labels using
[the label workflow](.github/LABELS.md). Acceptance of a feature request does
not by itself mean implementation has been scheduled.

## Fork and create a branch

`dev` is the development integration branch. Start contribution branches from
`dev` and open ordinary PRs against `dev`. `main` is the release branch;
maintainers merge release PRs from `dev` into `main`.

Fork [the repository](https://github.com/WhiteTowerAI/ohmygame/fork), then
replace `YOUR_USERNAME` below with your GitHub username:

```bash
git clone https://github.com/YOUR_USERNAME/ohmygame.git
cd ohmygame
git remote add upstream https://github.com/WhiteTowerAI/ohmygame.git
git fetch upstream
git switch --no-track -c fix/short-description upstream/dev
```

Use `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`,
`chore/<short-name>`, or `refactor/<short-name>` for your branch. The long-lived
`dev` and `main` branches are maintained separately. Contributors with write
access can use the same branch conventions in the upstream repository.

Choose the PR's base branch explicitly; GitHub may still suggest `main` during
this transition. The [maintainer guide](docs/maintaining.md) covers migration
and releases.

## Start local development

Install Git, Bun 1.4.2 or newer, and Node.js 22.19 or newer, including npm.
CI pins Bun 1.4.2 and Node.js 22.19.0. Use those versions when investigating a
difference between local checks and CI.

```bash
bun install --frozen-lockfile
bun run dev            # web renderer + local daemon
# or
bun run dev:desktop    # Electron app + local daemon
```

For browser development, open <http://127.0.0.1:43120>. Vite forwards API
requests to the daemon at `127.0.0.1:43110`.

No `.env.local`, Supabase setup, cloud repository access, or model credentials
are needed to start the app and work on its interface or run the public checks.
Development on localhost uses a local debug account when either Supabase value
is missing. Click **Sign in** to use it. Local publishing builds the game and
serves a temporary snapshot in Community while the daemon runs.

Connect a language model in **Settings → Providers & Models** when testing real
agent conversations. Image, video, and 3D generation need their corresponding
providers. Public tests use fixtures and simulated providers.

Bun installs dependencies and runs the build/test toolchain. The standalone
daemon and pinned plugin preparation use Node; desktop development runs the
daemon with Electron's Node. Game workspaces retain their own package-manager
choices. See [runtime.md](docs/runtime.md) for these boundaries.

### First-start preparation and common problems

- The development commands prepare pinned plugins and examples under `.runtime/`.
  First startup needs network access to GitHub and package registries; prepared
  resources are reused on later starts.
- Plugin preparation is required. If its download or checksum check fails,
  check the connection and run `bun run prepare:preinstalled-plugins` again.
- Example preparation clones and builds a separate repository using npm. A
  failed preparation reports unavailable examples; retry with
  `bun run prepare:examples` when the connection or npm setup is fixed.
- Browser development uses fixed ports. Stop another local instance if either
  port is occupied. Desktop development chooses a free daemon port.
- Browser development does not provide Electron's `game_use` playtest tool.
  Use `bun run dev:desktop` for desktop windows and agent playtesting.

Browser development stores project data under `.data/`. Desktop development
uses the app's user-data directory. Set `OHMYGAME_DATA_DIR` and
`PI_CODING_AGENT_DIR` to separate temporary directories when a manual test needs
isolated projects and agent settings. Neither directory belongs in a PR.

## Make and check your change

Keep each PR focused on one feature, bug fix, documentation change, chore, or
refactor. Use the [module map](docs/README.md#where-to-change-things) to find
related code, documents, and tests. Update public behavior documentation when
your change affects it.

| Change                                    | Local verification                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentation only                        | Check local links, examples, and formatting; run `git diff --check`. Application builds and tests are optional locally.                                      |
| Application behavior, dependencies, or CI | Run the public checks below. Add or update tests for new behavior and bug fixes; use a focused test while developing.                                        |
| UI or desktop behavior                    | Run the public checks and exercise the affected flow in the browser or Electron as appropriate. Include screenshots or a short recording for visual changes. |
| Plugin instructions or examples           | Check the relevant package/file contract and try the affected workflow in a project. If host behavior changes, run the public checks too.                    |
| Cloud publishing integration              | Run the public checks and describe any cloud verification still needed. Maintainers with cloud access complete the remote contract and staging checks.       |

For changes that need the public checks, run:

```bash
bun run prepare:preinstalled-plugins
bun run typecheck
bun run test
bun run build:renderer
bun run test:node-runtime
```

For example, run a focused suite with `bun run test -- test/preview.test.ts`.
The [CI workflow](.github/workflows/ci.yml) runs on PRs and pushes to `dev` and
`main`, including documentation PRs. It checks plugin preparation, types, tests,
the renderer build, and the Node daemon/player build and startup.
`test:node-runtime` builds the host and player before checking Node startup, so
this sequence covers the full application build without building them twice.

Remote publishing contract tests in `test/publish.test.ts` skip when the private
cloud repository or its dependencies are unavailable. That is expected for
public-only checkouts; mention the skips in your PR. A passing public suite
does not verify the hosted service. See [cloud integration](#cloud-integration)
and the [maintainer guide](docs/maintaining.md#review-and-merge).

## Formatting

Match the surrounding style when editing an existing file and keep formatting
changes limited to the parts you touch. The repository has not been fully
formatted with Prettier; whole-file checks are not required for existing files.

Use the repository's Prettier configuration for new supported files:

```bash
bunx --bun --no-install prettier --check <new files>
```

Keep broad formatting cleanup in a separate PR. CI does not enforce
repository-wide formatting.

## Open a pull request

Commit your change and push your contribution branch to your fork:

```bash
git push --set-upstream origin fix/short-description
```

Open a PR against **`WhiteTowerAI/ohmygame:dev`**. Use a Conventional Commit
title, such as `fix(runtime): handle missing tween state` or
`docs(contributing): clarify local setup`.

Fill in the PR template with what changed, why it changed, and how it was
checked. Link related issues; use `Closes #123` only when the PR fully resolves
the issue. Record the commands, results, skipped checks, and any manual
verification still needed. Include screenshots or a short recording for UI
changes.

Draft PRs are welcome for early feedback. Mark the PR ready when its intended
scope is complete. Respond to review comments and push follow-up changes to
the same branch. If it needs to catch up with development:

```bash
git fetch upstream
git merge upstream/dev
```

Resolve conflicts and rerun the affected checks. If you get stuck, explain the
blocker in the PR; maintainers can help narrow the remaining work. Maintainers
review scope, behavior, and verification before merging. See
[review and merge](docs/maintaining.md#review-and-merge) for that process.

## Configuration

Local development works with the defaults above. Use [.env.example](.env.example)
as a reference when an integration needs configuration; put only the settings
you need in an ignored `.env.local` and restart development after changing them.

### Sign-in (Supabase)

To test real authentication, use a Supabase project with Google and GitHub Auth
enabled. Add the renderer URL to its allowed redirect URLs and set these public
values:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key
```

Configuring both values disables debug sign-in and local debug publishing.
Production builds never enable the debug fallback. Real cloud publishing also
requires a matching Cloud API deployment.

For desktop OAuth, allow `http://127.0.0.1:*/auth/callback/**`. The app opens
the system browser and receives the result through a temporary loopback server.

### Cloud integration

The Community website and hosted Publish service are in
[`ohmygame-cloud`](https://github.com/WhiteTowerAI/ohmygame-cloud), which is
currently private. Access is optional for contributing to this repository.
The public client contract is [src/shared/publish-v1.ts](src/shared/publish-v1.ts);
[free cloud models](docs/free-cloud-models.md) documents the model/quota boundary.

If you have access, point the client at your local or preview Cloud API:

```dotenv
CLOUD_API_URL=http://127.0.0.1:43130
```

Cloud setup and the server contract are in that repository's
[`docs/publish-v1.md`](https://github.com/WhiteTowerAI/ohmygame-cloud/blob/main/docs/publish-v1.md).
Remote contract tests use an adjacent `ohmygame-cloud` checkout with its
dependencies installed, or a checkout selected by `OHMYGAME_CLOUD_ROOT`.
Contributors without access can describe the required cloud verification in
their PR so a maintainer can complete it.

### Projects, proxies, and desktop packaging

- Removing a project that uses an existing workspace folder never deletes
  that folder.
- The daemon honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (either case)
  and keeps local traffic off the proxy. See [network proxy](docs/runtime.md#network-proxy).
- The desktop app manages its own authenticated daemon; the renderer has no
  Node.js access.
- Signing, hosted update feeds, and release credentials are maintainer tasks.
  See [desktop releases](docs/desktop-releases.md).

## Security and license

Report security issues privately using [SECURITY.md](SECURITY.md).
By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
