---
name: wechat-minigame
description: Adapt and package games for WeChat Mini Games, diagnose WeChat DevTools or device issues, and perform explicitly requested test uploads.
---

# WeChat Mini Games

Mini games run on WeChat's own runtime, not a browser DOM, and differ from mini programs. Identify the engine, its WeChat exporter or SDK, the generated mini-game directory, and the AppID.

## Package

Use the engine's own route: Cocos Creator's `wechatgame` build target, or the platform's Unity conversion SDK with its supported Unity versions. A generic Web or WebGL build is not a mini game; do not hand-write a conversion. Keep changes in engine source or build configuration, not generated output.

Keep `game.json`, `project.config.json`, subpackages, and resource paths consistent with the output directory, and keep the existing AppID and developer settings. Use `wx` APIs for lifecycle, touch, storage, audio, and networking. Check package-size limits, domain allowlists, and base-library versions against the current official docs.

## DevTools

Use **WeChat DevTools**, not the WeChat chat app. Its CLI is `<install>/Contents/MacOS/cli` on macOS and `<install>/cli.bat` on Windows. The CLI requires the service port enabled in Settings → Security. Use `cli open --project <DIR>` and `cli preview --project <DIR>`. Mini-program automation tools cannot inspect a game canvas.

Read compile and runtime logs in the simulator, then check touch, storage after relaunch, and any changed audio or networking on a device preview.

## Upload

A build or preview request does not authorize an upload. Upload only when explicitly asked: confirm the AppID, output directory, version, and description, then run `cli upload --project <DIR> -v <VERSION> -d <DESCRIPTION>` or the project's CI setup. Keep upload keys out of the workspace and chat. Check an upload with an unknown outcome before retrying. Upload, review, and release are separate steps.
