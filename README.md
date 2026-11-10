<div align="center">

<a href="https://ohmygame.ai"><img src="docs/assets/banner.webp" alt="OhMyGame — the open-source studio for making games with AI" width="100%" /></a>

<p><b>The open-source studio for making games with AI.</b></p>

<p>
  <a href="https://github.com/WhiteTowerAI/ohmygame/releases"><img alt="Release" src="https://img.shields.io/github/v/release/WhiteTowerAI/ohmygame?include_prereleases&style=flat-square&label=release" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" /></a>
  <a href="https://discord.gg/TkrgvGQ2Zc"><img alt="Discord" src="https://img.shields.io/badge/discord-join-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

<p><b>English</b> | <a href="README.zh-CN.md">简体中文</a></p>

<p>
  <a href="https://ohmygame.ai">Website</a> ·
  <a href="https://ohmygame.ai/docs/">Docs</a> ·
  <a href="https://ohmygame.ai/community/">Community games</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p><a href="https://ohmygame.ai"><img src="docs/assets/screenshot.webp" alt="OhMyGame: chat with the agent on the left, the game it built running on the right" width="100%" /></a></p>

</div>

Describe a game, and the agent designs it, makes the art, writes the code,
plays it to check it works, and publishes it to a link anyone can open.
Design docs, images, video, 3D, and audio live on one canvas next to the code,
instead of across five different apps.

> [!NOTE]
> OhMyGame is in beta. Expect rough edges, and tell us what breaks.

## Download

| Platform              | Download                                                   |
| --------------------- | ---------------------------------------------------------- |
| macOS (Apple silicon) | [OhMyGame for Mac](https://ohmygame.ai/download/mac)       |
| Windows (x64)         | [OhMyGame for Windows](https://ohmygame.ai/download/windows) |

Older builds and release notes are on [Releases](https://github.com/WhiteTowerAI/ohmygame/releases).
The Windows build isn't code-signed yet, so SmartScreen may warn on first install.
Intel Mac and Linux are [on the roadmap](https://github.com/WhiteTowerAI/ohmygame/issues).

OhMyGame ships without a model. On first launch, connect a provider or a
coding agent you already use: [first run](https://ohmygame.ai/docs/first-run/).

## Features

- **An agent that plays its own game.** It drafts the design doc, writes the
  code, runs the game in a live preview, then plays it and tries a fix when something breaks.
- **One canvas for every asset.** Turn a character sketch into more art, a
  video, a voice line, or a rigged 3D model, ready to use in the game.
- **Publish to a link.** Anyone can play it in the browser, and it shows up in
  the [Community](https://ohmygame.ai/community/). Republishing keeps the link.
- **Plugins for the tools you know.** Godot, Unity, Unreal Engine, Cocos
  Creator, Blender, Aseprite, Tiled, and platforms like TapTap, WeChat and
  Douyin Mini Games. Or [make your own](https://ohmygame.ai/docs/plugins/make/).
- **Any model, your keys.** 40+ providers through
  [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), a
  subscription you already have, or Claude Code, Codex, and OpenCode as the
  agent. No per-run credits. [Models](https://ohmygame.ai/docs/models/).
- **Works from other agents too.** Turn on the MCP server to use OhMyGame's
  canvas, media, and playtesting from Claude Code or Codex.
  [External agents](docs/external-agents.md).

## What you can make

Three games our team made with OhMyGame:

<table>
  <tr>
    <td width="33%"><img src="docs/assets/showcase/interactive-film.webp" alt="An interactive film made with OhMyGame" width="100%" /></td>
    <td width="33%"><img src="docs/assets/showcase/island-builder.webp" alt="An island builder made with OhMyGame" width="100%" /></td>
    <td width="33%"><img src="docs/assets/showcase/deckbuilding-roguelike.webp" alt="A deckbuilding roguelike made with OhMyGame" width="100%" /></td>
  </tr>
  <tr>
    <td align="center">Interactive film</td>
    <td align="center">Island builder</td>
    <td align="center">Deckbuilding roguelike</td>
  </tr>
</table>

**Web games** (Phaser, Three.js, React Three Fiber) are the best place to
start. **Interactive stories** cover visual novels, interactive films, and
story games. **General games** work with any engine or stack.
[Play what others made](https://ohmygame.ai/community/).

## Documentation

Guides for using OhMyGame are at **[ohmygame.ai/docs](https://ohmygame.ai/docs/)**:
[install](https://ohmygame.ai/docs/install/),
[first run](https://ohmygame.ai/docs/first-run/),
[models](https://ohmygame.ai/docs/models/), and
[plugins](https://ohmygame.ai/docs/plugins/).

Technical references live in this repo under [`docs/`](docs/README.md), such as
the [runtime](docs/runtime.md), [coding agents](docs/coding-agents.md),
[custom models](docs/custom-models.md), and the
[plugin contract](docs/plugins.md).

## Build from source

Requires [Bun](https://bun.sh) 1.4.2+ and Node.js 22.19+.

```bash
git clone https://github.com/WhiteTowerAI/ohmygame.git
cd ohmygame
bun install --frozen-lockfile
bun run dev            # web renderer + local daemon
bun run dev:desktop    # or the Electron app
```

Builds from source send no telemetry. For branches, checks, and optional cloud
setup, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy

Your projects and API keys stay on your machine, and prompts go straight to the
providers you choose. You only need an account to publish. Release builds send
usage data and crash reports, which you can turn off in **Settings → About**.
See [logs and diagnostics](docs/diagnostics.md).

## Contributing

Issues and pull requests are welcome. Branch from `dev` and open PRs against
`dev`; `main` holds releases. Read [CONTRIBUTING.md](CONTRIBUTING.md), pick up a
[`help wanted`](https://github.com/WhiteTowerAI/ohmygame/labels/help%20wanted)
issue, and report security problems privately through [SECURITY.md](SECURITY.md).

## Community

[Discord](https://discord.gg/TkrgvGQ2Zc) ·
[QQ group 460706923](https://qun.qq.com/universal-share/share?ac=1&authKey=65LzSf96ttluVSAPzPKJvrsoQ0NSQHPJnhgJImnnqIik9uK64ljVd%2FzkRWb8Xanz&busi_data=eyJncm91cENvZGUiOiI0NjA3MDY5MjMiLCJ0b2tlbiI6InNUNWR3U05OeVlMZEVCK0YxNUNKckplazliYklGRnV6ZUZGM1NlV29vYVdKNGkrR2g2c28zNG1kdDFFcHllczMiLCJ1aW4iOiIyNDUxMjQwODEifQ%3D%3D&data=CQ5T4W2Ac1NWWg56dH_HQwixT7faVMm5Xq5kZsLgx9TDBGxeqs3mwXNLVUpO83oOUobc1qXBosRKYmWnziWboA&svctype=4&tempid=h5_group_info) ·
[Issues](https://github.com/WhiteTowerAI/ohmygame/issues)

## Star History

<a href="https://www.star-history.com/?repos=whitetowerai%2Fohmygame&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=whitetowerai/ohmygame&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=whitetowerai/ohmygame&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=whitetowerai/ohmygame&type=date&legend=top-left" />
  </picture>
</a>

## License

[Apache-2.0](LICENSE). The OhMyGame name and logo are not covered by the license.
