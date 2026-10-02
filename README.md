<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/shared/assets/ohmygame-mark-v2.svg">
  <img src="src/shared/assets/ohmygame-mark-dark-v2.svg" alt="OhMyGame" width="120">
</picture>

# OhMyGame

**The open-source studio for making games with AI.**

Everything you need to make games with AI, in one open-source app. Bring any
model.

<!-- TODO(links): real download URLs from the release feed -->
<p>
  <a href="https://TODO"><img src="https://img.shields.io/badge/Download-macOS%20(Apple%20silicon)-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  <a href="https://TODO"><img src="https://img.shields.io/badge/Download-Windows%20x64-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>
</p>

<p>
  <a href="#how-its-built"><img src="https://img.shields.io/badge/built%20on-Pi-7c3aed?style=flat-square" alt="Built on Pi" /></a>
  <a href="#any-model-your-keys"><img src="https://img.shields.io/badge/models-40%2B%20providers%20%C2%B7%20BYOK-black?style=flat-square" alt="40+ model providers, BYOK" /></a>
  <img src="https://img.shields.io/badge/local--first-yes-2ea44f?style=flat-square" alt="Local-first" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/status-alpha-orange?style=flat-square" alt="Status alpha" />
</p>

<!-- TODO(links): community, X, and Discord URLs; keep only the ones that are live -->
<p>
  <a href="https://discord.gg/TkrgvGQ2Zc">Join Discord</a> ·
  <a href="https://x.com/dihuang111">X</a>
</p>

</div>

> [!NOTE]
> OhMyGame is in early alpha (`0.0.0-alpha.3`). Expect rough edges, join us and let's build it together!

## What it is

Making a game takes 2D art, 3D models, video, code, and somewhere
to put it when it is done. Today those live in five or six different tools.
We're building one app for all of it: describe what you want, and the agent makes the assets, builds the game, plays it to check it works, and publishes it to a link you can share.

At its heart, OhMyGame is a GUI coding agent for game dev, built on
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It keeps
Pi's full toolset and sessions, and extends it for games: Equip general agent the ability to make game assets, and provide studios to build specifc games much easier.

Bring your own model. OhMyGame works with 40+ providers through Pi, from
Anthropic and OpenAI to DeepSeek and Qwen, and can sign in with a subscription you already have. Your keys stay on your machine, there are no per-run credits, and what it makes is yours.

## Demo

https://github.com/user-attachments/assets/TODO

## What you can make

### 🎮 Web games: from one sentence to something you can play

The agent builds it with Three.js, React Three Fiber, or Phaser and runs it in
a live preview. Once it runs, the agent opens the game in a
window you can watch and plays it, including real-time canvas and WebGL games.
When it finds a problem, it tries a fix and plays again.

Playtesting is open loop for now: the agent plans a batch of inputs, runs
them, then looks at the result. It has no real-time reflexes yet.

<!-- TODO(asset): GIF, Project Shell: conversation left, live preview right,
then the agent playing in the watch window with the key overlay -->
<img src="docs/assets/web-game.gif" alt="Building a web game and watching the agent play it" width="860" />

### 🎨 Asset Canvas: art, video, and 3D on one board

Generate images, video, and 3D models side by side. Nodes can use each other
as references, so one character design can lead to more
images, a video, or a textured 3D model. Results go into a shared Asset
Library that your games can use. Generation needs your own provider keys or
an OhMyGame account.

<!-- TODO(asset): GIF, Asset Canvas: text → image → 3D model chain -->
<img src="docs/assets/asset-canvas.gif" alt="Generating linked image, video, and 3D assets on the Asset Canvas" width="860" />

### 🎬 Interactive stories: one screen at a time

Create interactive films, visual novels, and story games. Each screen is a
free web page with its own
images, video, and code: a main menu, a case archive, a dialogue, a puzzle.
You connect them on a graph, and the runtime handles state, saves, and
navigation. The architecture and authoring model are documented in
[Playable Nodes](docs/playable-nodes/README.md).

<!-- TODO(asset): screenshot or GIF, Node Graph with two finished screens,
made with OhMyGame. Leave out until there is a real one. -->

### 🔗 Publish: one click, one link

OhMyGame builds the game and uploads only the static output. Each publish is a
new immutable deployment under the same link, and the game shows up in the
[Community](https://TODO) where others can play it.

## How it's built

The idea that holds this together: one agent drives every part of the studio.

**1 · A full Pi agent with a GUI.** OhMyGame runs
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) with its
full toolset and persistent sessions, in a GUI built for watching results
rather than reading diffs. Close the app, come back, and the project,
conversation, and context are still there. You describe, review, and steer;
editing by hand is always possible, but it is not the main path.

**2 · Every workspace is files.** A web game is a normal web project. An Asset
Canvas is a `canvas.json`. An interactive story is a node graph on disk. Each
comes with an `AGENTS.md` and JSON schemas, so the agent edits them the same
way it edits code, and the visual editors read and write the same files.

**3 · Game-specific tools.** On top of Pi's coding tools, the agent can play
the game it built (`game_use`), generate images, video, and 3D models, add and
check story nodes, search the web, and install plugins, all as ordinary tool
calls.

## Any model, your keys

OhMyGame does not lock you into one model or charge per run.

- **Coding models from 40+ providers** through Pi, including Anthropic,
  OpenAI, Google, DeepSeek, Qwen, Kimi, GLM, MiniMax, xAI, Mistral, Groq,
  OpenRouter, Amazon Bedrock, and Vercel AI Gateway.
- **Sign in with a subscription you already have**, such as ChatGPT Plus/Pro or
  GitHub Copilot, or paste an API key.
  <!-- TODO(legal): check each provider's terms before naming more subscriptions -->
- **Media models** for images, video, and 3D through OpenAI, Gemini, fal,
  OpenRouter, and Meshy.
- **Or use an OhMyGame account** if you would rather not manage keys.
  <!-- TODO(copy): pricing link for the OhMyGame account -->

Keys stay in the local daemon. They never reach the agent's workspace, your
game, or the renderer.

## Extend it

- **Skills.** The built-in Web Game Studio plugin ships skills for game
  foundations, Three.js, React Three Fiber, Phaser, sprite and 3D asset
  pipelines, game UI, and playtesting. The built-in Three.js World plugin
  expands a scene idea into a detailed design and builds an explorable world.
- **Plugins.** Install OhMyGame plugins, or reuse the Codex and Claude Code
  plugins you already have.
- **MCP.** Connect MCP servers to give the agent more tools.

## What's next

<!-- TODO(roadmap): confirm the list and link each item to an issue -->

- First-run setup that walks you through connecting a model
- Plain-language playtest reports you can read without looking at code
- More platforms: Intel Macs and Linux

Want to help with one of these? Look for
[`help wanted`](https://github.com/WhiteTowerAI/ohmygame/labels/help%20wanted)
issues.

## Quick start

### Download

Grab the installer from the buttons at the top or from
[Releases](https://github.com/WhiteTowerAI/ohmygame/releases). Builds are
available for macOS (Apple silicon) and Windows (x64).

Open the app, connect a model provider under **Providers**, and describe your
first game.

<!-- TODO(copy): short first-run guide once the BYOK onboarding lands:
which providers are supported, where to get a key, rough cost of one game -->

### Run from source

Requires Node.js 22.19+.

```bash
git clone https://github.com/WhiteTowerAI/ohmygame.git
cd ohmygame
npm install
npm run dev            # web renderer + local daemon
# or
npm run dev:desktop    # Electron app
```

The web renderer opens at `http://127.0.0.1:43120`. See
[Development](#development) for configuration.

## Made something?

We'd love to see it. Share it in [Discussions](https://TODO) with the prompt
you used.

<!-- TODO(asset): once there are 3+ real community games, replace this with a
"Made with OhMyGame" table: thumbnail, name, playable link, original prompt -->

## How it works

```text
┌──────────── Desktop app / web renderer ─────────────┐
│  Conversation            │  Live preview / watch    │
└──────────────┬──────────────────────────────────────┘
               │ local HTTP + SSE (127.0.0.1)
┌──────────────┴──────── Local daemon ────────────────┐
│  Pi agent · playtest · Asset Canvas · plugins · MCP │
│  project workspaces · preview dev server            │
└──────────────┬──────────────────────────────────────┘
               │ Publish (static build only)
┌──────────────┴──────── OhMyGame Cloud ──────────────┐
│  immutable deployments · Community                  │
└─────────────────────────────────────────────────────┘
```

The agent is built on the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
Everything except publishing runs locally. Details: [docs/runtime.md](docs/runtime.md).

## Privacy and telemetry

- Model and provider keys stay in the local daemon.
- Publishing uploads only the static build output. Your sign-in token is used
  for that request only and is never stored or sent to the agent.
- Builds with analytics configured send anonymous usage events (PostHog,
  session recording off) and crash reports (Sentry, no PII). Builds from
  source send nothing unless you set the keys yourself.

<!-- TODO(copy): how to turn telemetry off in the desktop app, once there is a
setting for it -->

## Development

Run `npm test`, `npm run typecheck`, and `npm run build` before sending a PR.

<details>
<summary>Sign-in (Supabase)</summary>

Product sign-in uses Supabase Auth with Google and GitHub. Enable both
providers in Supabase, add the renderer URL to the allowed redirect URLs, and
set these public values in `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key
```

Without them the app stays usable while signed out. For desktop OAuth, add
`http://127.0.0.1:*/auth/callback/**` to the redirect allow list. The desktop
app opens OAuth in the system browser and receives the result through a
temporary loopback server.

</details>

<details>
<summary>Publishing against a local cloud</summary>

The Community website and Publish v1 service live in
[`ohmygame-cloud`](https://github.com/WhiteTowerAI/ohmygame-cloud). Point the
client at a local or preview deployment in `.env.local`:

```dotenv
CLOUD_API_URL=http://127.0.0.1:43130
```

The server contract is in
[`ohmygame-cloud/docs/publish-v1.md`](https://github.com/WhiteTowerAI/ohmygame-cloud/blob/main/docs/publish-v1.md).

</details>

<details>
<summary>Projects, proxies, and the desktop daemon</summary>

- Projects, workspaces, and Pi sessions live in the daemon data directory. In
  the desktop app a project can use an existing folder as its workspace;
  removing the project never deletes that folder.
- The daemon honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (either case)
  and always keeps local traffic off the proxy.
- The desktop app starts a managed daemon on a free port with a random
  process-scoped access token. The renderer has no Node.js access.
- Desktop release signing and the update feed:
  [docs/desktop-releases.md](docs/desktop-releases.md).

</details>

## Follow along

We're building OhMyGame in public.

<!-- TODO(links): list only the channels that are live -->

- Changelog: [Releases](https://github.com/WhiteTowerAI/ohmygame/releases)
- Feedback and games: [Discussions](https://TODO)
- Updates: [X](https://x.com/TODO)

<!-- TODO(badge): enable once there is some history to show
[![Star History](https://api.star-history.com/svg?repos=WhiteTowerAI/ohmygame&type=Date)](https://star-history.com/#WhiteTowerAI/ohmygame&Date)
-->

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
checks, and PR conventions, and [SECURITY.md](SECURITY.md) for reporting
security issues.

## Acknowledgements

OhMyGame's agent runs on
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
<!-- TODO(copy): other projects and asset sources worth crediting -->

## License

[Apache-2.0](LICENSE). The OhMyGame name and logo are not covered by the
license. <!-- TODO(legal): confirm trademark wording -->
