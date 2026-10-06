<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/shared/assets/ohmygame-mark-v2.svg">
  <img src="src/shared/assets/ohmygame-mark-dark-v2.svg" alt="OhMyGame" width="120">
</picture>

# OhMyGame

**The open-source studio for making games with AI.**

Everything you need to make games with AI, in one open-source app. Support BYOK.

<p>
  <a href="https://ohmygame.ai/download/mac"><img src="https://img.shields.io/badge/Download-macOS%20(Apple%20silicon)-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  <a href="https://ohmygame.ai/download/windows"><img src="https://img.shields.io/badge/Download-Windows%20x64-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>
</p>

<p>
  <a href="#how-its-built"><img src="https://img.shields.io/badge/built%20on-Pi-7c3aed?style=flat-square" alt="Built on Pi" /></a>
  <a href="#any-model-your-keys"><img src="https://img.shields.io/badge/models-40%2B%20providers%20%C2%B7%20BYOK-black?style=flat-square" alt="40+ model providers, BYOK" /></a>
  <img src="https://img.shields.io/badge/local--first-yes-2ea44f?style=flat-square" alt="Local-first" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/status-beta-orange?style=flat-square" alt="Status beta" />
</p>

<p>
  <a href="https://discord.gg/TkrgvGQ2Zc">Join Discord</a>
</p>

</div>

> [!NOTE]
> OhMyGame is in beta (`0.0.0-beta.1`). Expect rough edges, join us and let's build it together!

## What it is

Making a game takes design docs, 2D art, 3D models, video, code, and somewhere
to put it when it's done. Today those live in five or six different tools.
OhMyGame puts them in one app: describe your game, and the agent designs it,
makes the assets, builds it, plays it to check it works, and publishes it to a
link you can share.

Two core design ideas shape it:

1. **Everything lives on a canvas.** Design docs, concept art, 3D models, and
   video sit side by side and reference each other, so you and the agent always
   see the same picture of the game.
2. **The agent does the work.** It drives the canvas the way you would:
   drafting the design doc, turning a character sketch into a rigged 3D model,
   writing the code, and playtesting the result.

It's open source and works with 40+ model providers through Pi, from Anthropic
and OpenAI to DeepSeek and Qwen. Your keys stay on your machine, there are no
per-run credits, and what you make is yours.

## Features

### 🎮 Web games: from one sentence to something you can play

The agent builds it with Three.js, React Three Fiber, or Phaser and runs it in
a live preview. Once it runs, the agent opens the game in a
window you can watch and plays it, including real-time canvas and WebGL games.
When it finds a problem, it tries a fix and plays again.

Playtesting is open loop for now: the agent plans a batch of inputs, runs
them, then looks at the result. It has no real-time reflexes yet.

<!-- TODO(asset): GIF, Project Shell: conversation left, live preview right,
then the agent playing in the watch window with the key overlay -->
<!-- <img src="docs/assets/web-game.gif" alt="Building a web game and watching the agent play it" width="860" /> -->

### 🎨 Asset Canvas: art, video, and 3D on one board

Generate images, video, and 3D models side by side. Nodes can use each other
as references, so one character design can lead to more
images, a video, or a textured 3D model. Results go into a shared Asset
Library that your games can use. Generation uses your own provider keys.

<!-- TODO(asset): GIF, Asset Canvas: text → image → 3D model chain -->
<!-- <img src="docs/assets/asset-canvas.gif" alt="Generating linked image, video, and 3D assets on the Asset Canvas" width="860" /> -->

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
[Community](https://ohmygame.ai/) where others can play it.

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
calls. Connect MCP servers for more tools, or reuse the Codex and Claude Code
plugins you already have.

## Any model, your keys

OhMyGame does not lock you into one model or charge per run.

- **Coding models from 40+ providers** through Pi, including Anthropic,
  OpenAI, Google, DeepSeek, Qwen, Kimi, GLM, MiniMax, xAI, Mistral, Groq,
  OpenRouter, Amazon Bedrock, and Vercel AI Gateway.
- **Sign in with a subscription you already have**, such as ChatGPT Plus/Pro or
  GitHub Copilot, or paste an API key.
  <!-- TODO(legal): check each provider's terms before naming more subscriptions -->
- **Media models** for images, video, and 3D through OpenAI, Gemini,
  OpenRouter, and Meshy.

Keys stay in the local daemon. They never reach the agent's workspace, your
game, or the renderer.

## Quick start

### Download

Grab the installer from the buttons at the top or from
[Releases](https://github.com/WhiteTowerAI/ohmygame/releases). Builds are
available for macOS (Apple silicon) and Windows (x64).

Open the app, connect a model provider under **Providers & Models**, and describe your
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

See [CONTRIBUTING.md](CONTRIBUTING.md#configuration) for configuration.

## Privacy

Everything runs on your machine except publishing, which uploads only your
game's static build. Release builds send anonymous usage events (PostHog,
no session recording) and crash reports (Sentry, no personal data). Builds
from source send nothing.

<!-- TODO(copy): how to turn telemetry off in the desktop app, once there is a
setting for it -->

## Roadmap

<!-- TODO(links): link "roadmap" to the pinned Roadmap issue once the repo is public -->

We're working on first-run setup, plain-language playtest reports, and
Intel Mac / Linux builds. See the [roadmap](https://TODO) for what's next,
and vote with 👍 on what matters to you. Want to help? Look for
[`help wanted`](https://github.com/WhiteTowerAI/ohmygame/labels/help%20wanted)
issues.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
checks, and PR conventions, and [SECURITY.md](SECURITY.md) for reporting
security issues.

## License

[Apache-2.0](LICENSE). The OhMyGame name and logo are not covered by the
license. <!-- TODO(legal): confirm trademark wording -->
