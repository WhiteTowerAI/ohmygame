---
name: douyin-minigame
description: Adapt and package Douyin Mini Games, diagnose developer-tool or device previews, and perform explicitly requested test-version uploads.
---

# Douyin Mini Games

Identify the source engine/version, source directory, generated game directory, AppID, platform SDK, and installed game developer tools. Use a General workspace for engine sources and keep native/developer-tool previews separate from OhMyGame's browser preview.

## Adapt and package

Use the engine's matching Douyin integration. Cocos Creator provides a Douyin build target; Unity projects need the platform's supported Unity conversion SDK. Preserve that SDK's project layout and distinguish WebGL from native game targets. A Web build and a WeChat adapter do not by themselves create a Douyin game.

Keep platform changes in engine source/configuration or a reproducible build step. Check generated `project.config.json`, `game.json`, entrypoints, resource paths, and subpackages against the actual exporter version. Retain existing AppID and developer settings. Use supported `tt` APIs for lifecycle, touch, storage, audio, and networking as needed; check current limits and target base-library support in the official docs.

For CLI integration, the official mini-game package is `tt-minigame-ide-cli`, distinct from similarly named small-app tooling. Read the installed tool's help before selecting commands. When an ephemeral CLI is needed, the researched entrypoint is `npx -y --package=tt-minigame-ide-cli@2.1.1 tmg --help`; pin a different release only after checking its game SDK compatibility. Do not auto-install or configure other AI clients.

## Preview and verify

Import the generated directory in the official game developer tool. Read compile/runtime diagnostics and verify the changed flow in its simulator. Use the platform's preview flow on an authorized device/account and check touch input, storage after relaunch, and any changed audio/network behavior. Developer-tool startup and browser screenshots do not establish device gameplay.

For Unity, follow the actual SDK's preview instructions and target-specific prerequisites. Report missing tools, login, AppID access, or device evidence precisely instead of claiming the preview passed.

## Upload and release

For an explicitly requested upload, confirm the AppID, target, artifact directory, version, description, and account permissions. Prefer the official tool's login/credential storage; keep credentials outside plugin files and chat. Preserve the operation result and check status before retrying an upload with an unknown outcome.

Report local packaging, simulator, device preview, test upload, review, and production release independently. An instruction to build or run locally does not authorize a test-version upload or production publication.

Official references: [Creator export](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-bytedance-mini-game.html), [platform package layout and CLI requirements](https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/guide/game-engine/rd-to-SCgame/unity-game-access/install-connect/unity-new), [Unity device preview](https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/dev-tools/developer-instrument/development-assistance/unity-game-preview).
