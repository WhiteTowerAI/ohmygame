# Documentation

Start with [CONTRIBUTING.md](../CONTRIBUTING.md) for your first contribution.
The [中文快速指引](contributing.zh-CN.md) summarizes the same workflow in Chinese.
[maintaining.md](maintaining.md) covers triage, review, the `dev`/`main` transition,
and release preparation.

## Where to change things

The React renderer talks to a local Fastify daemon over HTTP and SSE. The daemon
owns Pi sessions, workspaces, assets, previews, and publishing. Electron owns
desktop lifecycle and native game windows; shared modules define contracts.

| Area                             | Code to start with                                                                                                                            | Read first                                                                                                              | Example tests                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Agent, chat, and model requests  | `src/daemon/agent.ts`, `src/daemon/pi-agent.ts`, `src/daemon/session-images.ts`, `src/renderer/agent-timeline.tsx`                            | [Runtime](runtime.md), [agent errors](agent-errors.md), [image history](model-image-history.md)                         | `test/agent.test.ts`, `test/agent-errors.test.ts`, `test/session-images.test.ts`                                                    |
| Design and Asset Canvas          | `src/daemon/canvas-workspace.ts`, `src/daemon/canvas-routes.ts`, `src/renderer/canvas-workspace.tsx`, `src/renderer/asset-canvas-nodes.tsx`, `src/shared/canvas-workspace.ts`        | [Canvas file contract](canvas-agent.md)                                                                                 | `test/canvas-api.test.ts`, `test/asset-canvas-document.test.ts`, `test/canvas-table.test.ts`                                        |
| Preview and game use             | `src/daemon/preview.ts`, `src/daemon/preview-proxy.ts`, `src/desktop/web-game-player.ts`, `src/desktop/playtest-driver.ts`                    | [Preview lifecycle](preview-runtime.md), [service recovery](runtime-recovery.md), [game use](runtime.md#agent-game-use) | `test/preview.test.ts`, `test/web-game-player.test.ts`, `test/playtest-driver.test.ts`                                              |
| Coding agents (Claude Code, Codex, OpenCode) | `src/daemon/agent-runtimes/`, `src/renderer/coding-agents-settings.tsx`, `src/renderer/approval-card.tsx`, `src/shared/agent-runtimes.ts` | [Coding agents](coding-agents.md)                                                                                         | `test/agent-runtime-session.test.ts`, `test/agent-runtime-drivers.test.ts`, `test/agent-runtime-routes.test.ts`                    |
| External agents (OhMyGame as an MCP server) | `src/daemon/external-mcp.ts`, `src/daemon/external-agent-clients.ts`, `src/desktop/external-mcp-launcher.ts`, `src/renderer/external-agents-settings.tsx` | [External agents](external-agents.md) | `test/external-mcp.test.ts`, `test/external-mcp-launcher.test.ts`, `test/external-agent-clients.test.ts` |
| Providers and media              | `src/daemon/provider-model-settings.ts`, `src/daemon/provider-settings-routes.ts`, `src/daemon/provider-models3d.ts`, `src/daemon/cloud-models.ts`, `src/renderer/provider-models.tsx`  | [Custom models](custom-models.md), [3D workflows](3d-providers.md), [free cloud models](free-cloud-models.md)           | `test/provider-model-settings.test.ts`, `test/model3d-workflows.test.ts`, `test/cloud-models.test.ts`                               |
| Audio providers                  | `src/shared/audio.ts`, `src/daemon/audio-generation.ts`, `src/daemon/volcengine-tts-provider.ts`, `src/daemon/volcengine-seed-audio-provider.ts`, `src/daemon/canvas-workspace.ts` | [Audio providers](audio-providers.md) | `test/volcengine-tts-provider.test.ts`, `test/volcengine-tts-settings.test.ts`, `test/volcengine-seed-audio-provider.test.ts`, `test/volcengine-seed-audio-settings.test.ts`, `test/tools.test.ts`, `test/game-design.test.ts` |
| Interactive Stories              | `src/shared/playable-*.ts`, `src/story-web/`, `src/daemon/story-web-project.ts`, `src/daemon/playable-project.ts`, `src/renderer/playable-editor-workspace.tsx` | [Playable Nodes](playable-nodes/README.md)                                                                              | `test/playable-graph.test.ts`, `test/playable-runtime.test.ts`, `test/story-web-project.test.ts`                                     |
| Plugins, Skills, and MCP         | `src/daemon/plugin-capabilities.ts`, `src/daemon/plugin-runtime.ts`, `src/daemon/plugin-authoring.ts`, `src/renderer/plugins.tsx`, `plugins/` | [Plugin package and runtime contract](plugins.md)                                                                       | `test/plugin-capabilities.test.ts`, `test/plugin-builder.test.ts`, `test/bundled-plugins.test.ts`                                   |
| Desktop lifecycle and updates    | `src/desktop/main.ts`, `src/desktop/daemon-supervisor.ts`, `src/desktop/updater.ts`, `src/desktop/update-check-scheduler.ts`, `src/renderer/changelog-panel.tsx`, `src/shared/changelog.ts`                                                           | [Runtime](runtime.md), [service recovery](runtime-recovery.md), [desktop releases](desktop-releases.md)                 | `test/daemon-supervisor.test.ts`, `test/desktop-updater.test.ts`, `test/desktop-update-scheduler.test.ts`, `test/desktop-runtime-packaging.test.ts`, `test/desktop-release-notes.test.ts`, `test/changelog-panel.test.tsx`                          |
| Publishing and Community         | `src/daemon/publish/`, `src/shared/publish-v1.ts`, `src/renderer/publish-dialog.tsx`                                                          | [Cloud integration](../CONTRIBUTING.md#cloud-integration), [runtime publishing](runtime.md#publishing)                  | `test/publish-client.test.ts`, `test/publish-dialog.test.tsx`; remote contracts in `test/publish.test.ts` need private cloud access |
| Shared UI and project navigation | `src/renderer/app.tsx`, `src/renderer/projects.tsx`, `src/renderer/project-shell.tsx`, `src/renderer/styles.css`                              | [Local setup](../CONTRIBUTING.md#start-local-development), [project navigation](runtime.md#project-navigation)            | `test/projects-page.test.ts`, `test/project-card.test.ts`, `test/project-types.test.ts`                                             |
| Project export and import       | `src/daemon/project-archive.ts`, `src/daemon/archive-extraction.ts`, `src/shared/project-archive.ts`, `src/renderer/project-card.tsx`, `src/renderer/projects.tsx` | [Project archives](project-archives.md) | `test/project-archive.test.ts`, `test/project-archive-assets.test.ts`, `test/project-archive-ui.test.tsx` |
| First-run setup                  | `src/renderer/onboarding.tsx`, `src/renderer/onboarding-demo.tsx`, `src/renderer/use-onboarding.ts`, `src/renderer/use-model-provider-auth.ts`, `src/renderer/custom-provider-dialog.tsx`, `src/daemon/onboarding.ts`       | [First run](../README.md#first-run), [setup state](runtime.md#first-run-setup)                                             | `test/onboarding.test.ts`, `test/onboarding-renderer.test.tsx`                                                                         |
| Logs and diagnostics             | `src/desktop/log-file.ts`, `src/shared/log-redaction.ts`, `src/desktop/console-log.ts`, `src/desktop/diagnostics-export.ts`, `src/daemon/activity-log.ts`, `src/daemon/request-log.ts`, `src/daemon/diagnostics.ts`, `src/renderer/settings-page.tsx` | [Logs and diagnostics](diagnostics.md) | `test/desktop-log-file.test.ts`, `test/activity-log.test.ts`, `test/request-log.test.ts`, `test/diagnostics.test.ts`, `test/desktop-diagnostics-export.test.ts`, `test/diagnostics-settings-ui.test.tsx` |

These are entry points, not an exhaustive ownership map. HTTP API and event
definitions live in the code; use the corresponding shared types and tests
when changing a contract.

## Architecture and feature guides

The main sidebar opens **Plugins** for the plugin library, plugin details, and
Plugin Builder. Earlier Settings → Plugins links still open the same plugin
on this page.

[Git changes in Code](workspace-git.md) covers the read-only project changes
view, its comparison baseline and refresh behavior.

[Turn file changes and Undo](checkpoints.md) covers message checkpoints, file
conflicts, workspace versions, and recovery. Start with `src/daemon/checkpoints.ts`,
`src/daemon/agent.ts`, and `src/renderer/turn-changes.tsx`; the focused suites
are `test/checkpoints.test.ts`, `test/turn-checkpoints.test.ts`,
`test/checkpoint-routes.test.ts`, and `test/checkpoint-references.test.ts`.

[Project archives](project-archives.md) covers **Export project** and
**Import project**: the archive layout and manifest, what an export leaves out,
and how an import becomes a new project.

| Document                                         | Purpose                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [runtime.md](runtime.md)                         | Process boundaries, toolchains, proxies, trust boundary, game use, persistence, and publishing.                                |
| [agent-runtimes.md](agent-runtimes.md) | Native runtime architecture, accepted design decisions, and validation boundaries. |
| [preview-runtime.md](preview-runtime.md)         | Startup modes, dependency installation, leases, browser storage, and diagnostics.                                              |
| [runtime-recovery.md](runtime-recovery.md)       | Preview isolation, daemon supervision, reconnect behavior, and recovery scenarios.                                             |
| [canvas-agent.md](canvas-agent.md)               | Canvas files, concurrent editing, agent tools, media, and migration.                                                           |
| [coding-agents.md](coding-agents.md)             | Coding agent CLIs: discovery, sessions, tools, approvals, isolation, and adding an agent.                                      |
| [external-agents.md](external-agents.md)         | OhMyGame as an MCP server for Claude Code, Codex, and other external agents: setup, launcher, tools, and contract.            |
| [plugins.md](plugins.md)                         | Plugin packages, configuration, credentials, MCP sessions, authoring, and migration.                                           |
| [custom-models.md](custom-models.md)             | Provider protocols, capabilities, visibility, model definitions, and defaults.                                                 |
| [3d-providers.md](3d-providers.md)               | 3D operations, provider compatibility, paid-task recovery, and GLB validation.                                                 |
| [free-cloud-models.md](free-cloud-models.md)     | Account models, personal quotas, and the desktop/cloud contract. Cloud deployment sections need access to the private service. |
| [agent-errors.md](agent-errors.md)               | Error classification, diagnostics, redaction, and the Pi compatibility patch.                                                  |
| [model-image-history.md](model-image-history.md) | Request image budgets, recall, OpenAI continuation, and file lifecycle.                                                        |
| [desktop-releases.md](desktop-releases.md)       | Maintainer packaging, signing, update feeds, publishing, and rollback.                                                         |
| [ui-languages.md](ui-languages.md)               | Renderer translations, language selection, what stays in English, and terminology.                                             |
| [diagnostics.md](diagnostics.md)                 | Desktop log files, redaction, rotation, and the diagnostics export for bug reports.                                            |

[Video trimming](video-trimming.md) covers Library and Asset Canvas video
trimming, the shared preview controls, encoding, and the Library record.

[Playable Nodes](playable-nodes/README.md) has its own vocabulary and index:
[runtime](playable-nodes/runtime.md) is the node contract,
[authoring](playable-nodes/authoring.md) describes the editor, and
[agent](playable-nodes/agent.md) describes agent context and tools.
[vision](playable-nodes/vision.md) preserves the rationale for the redesign.

## Contribution and repository policies

| Document                                           | Purpose                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [README.md](../README.md)                          | Product overview, installation, and first-run instructions.                        |
| [CHANGELOG.md](../CHANGELOG.md)                    | User-visible changes collected during release preparation.                        |
| [CONTRIBUTING.md](../CONTRIBUTING.md)              | Setup, branches, verification, PRs, and optional integrations.                     |
| [中文快速指引](contributing.zh-CN.md)              | A short Chinese entry point; the full contribution rules are in `CONTRIBUTING.md`. |
| [maintaining.md](maintaining.md)                   | Maintainer triage, reviews, repository settings, and releases.                     |
| [AGENTS.md](../AGENTS.md)                          | Repository instructions for coding agents.                                         |
| [Issue and PR labels](../.github/LABELS.md)        | Label definitions, progress states, and automation.                                |
| [PR template](../.github/PULL_REQUEST_TEMPLATE.md) | Change rationale, related issues, verification, and limitations.                   |
| [SECURITY.md](../SECURITY.md)                      | Private vulnerability reporting and supported versions.                            |
| [LICENSE](../LICENSE)                              | Apache 2.0 contribution and distribution terms.                                    |

Issue forms and CI configuration live in `.github/`. Toolchain versions and
commands live in `package.json`; environment examples are in `.env.example`.

## Bundled plugin instructions and asset licenses

These instructions are shipped with the product and guide its game-making
agent. Editing them changes a plugin workflow; see the plugin verification
guidance in [CONTRIBUTING.md](../CONTRIBUTING.md#make-and-check-your-change).
For the additional engine, mini-game, and asset-tool Beta packages, use the
[manual acceptance checklist (中文)](plugin-beta-testing.zh-CN.md).

- [Blender Assets](../plugins/blender/skills/blender-assets/SKILL.md),
  [Godot Game](../plugins/godot/skills/godot-game/SKILL.md),
  [TapTap Maker](../plugins/taptap-maker/skills/taptap-maker/SKILL.md), and
  [TapTap Release](../plugins/taptap-maker/skills/taptap-release/SKILL.md).

- [Game Studio](../plugins/game-studio/skills/game-studio/SKILL.md),
  [Game Foundations](../plugins/game-studio/skills/game-foundations/SKILL.md),
  and [Game QA](../plugins/game-studio/skills/game-qa/SKILL.md).
- [Web Game Studio](../plugins/web-game-studio/skills/web-game-studio/SKILL.md),
  [Web Game Foundations](../plugins/web-game-studio/skills/web-game-foundations/SKILL.md),
  [Game Playtest](../plugins/web-game-studio/skills/game-playtest/SKILL.md),
  [Game UI Frontend](../plugins/web-game-studio/skills/game-ui-frontend/SKILL.md),
  [Phaser 2D](../plugins/web-game-studio/skills/phaser-2d-game/SKILL.md),
  [React Three Fiber](../plugins/web-game-studio/skills/react-three-fiber-game/SKILL.md),
  [Three.js](../plugins/web-game-studio/skills/three-webgl-game/SKILL.md),
  [Sprite Pipeline](../plugins/web-game-studio/skills/sprite-pipeline/SKILL.md),
  and [Web 3D Assets](../plugins/web-game-studio/skills/web-3d-asset-pipeline/SKILL.md).
- [Three.js World](../plugins/threejs-world/skills/threejs-world/SKILL.md) and
  its references: [world contract](../plugins/threejs-world/skills/threejs-world/references/world-contract.md),
  [world expansion](../plugins/threejs-world/skills/threejs-world/references/world-expansion.md),
  [presentation](../plugins/threejs-world/skills/threejs-world/references/presentation.md),
  [validation](../plugins/threejs-world/skills/threejs-world/references/validation.md),
  and [expansion example](../plugins/threejs-world/skills/threejs-world/references/expansion-example.txt).
- Beta engine and platform workflows:
  [Cocos Creator](../plugins/cocos-creator/skills/cocos-creator/SKILL.md),
  [WeChat Mini Games](../plugins/wechat-minigame/skills/wechat-minigame/SKILL.md),
  [Douyin Mini Games](../plugins/douyin-minigame/skills/douyin-minigame/SKILL.md),
  [Unity](../plugins/unity/skills/unity-game/SKILL.md), and
  [Unreal Engine](../plugins/unreal-engine/skills/unreal-game/SKILL.md).
- Beta asset tools: [Aseprite](../plugins/aseprite/skills/aseprite-assets/SKILL.md)
  and [Tiled](../plugins/tiled/skills/tiled-maps/SKILL.md).

Plugin brand assets and their per-package source notices are described in
[Plugin logos](plugin-logos.md).

Asset-specific terms are documented in the
[provider logo notes](../src/renderer/assets/providers/README.md) and the
[Home](../src/renderer/assets/home/OFL.txt) and
[Sidebar](../src/renderer/assets/sidebar/OFL.txt) font licenses.
