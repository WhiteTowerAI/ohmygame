---
name: wechat-minigame
description: Adapt and package WeChat Mini Games, diagnose WeChat DevTools or device failures, and prepare explicitly requested test-version uploads.
---

# WeChat Mini Games

Identify the source engine, source directory, generated mini-game directory, AppID, and installed WeChat DevTools version. Use a General workspace for engine sources. WeChat Mini Games use a platform runtime rather than a browser DOM; a Web build or ordinary mini-program automation does not establish mini-game compatibility.

## Adapt and package

Use the engine's existing WeChat exporter and matching SDK. For Cocos Creator, pair with its engine workflow and preserve the exported adapter. For Unity, identify the platform conversion SDK and its supported Unity version before building; a generic WebGL export alone is insufficient. If no supported exporter exists, report the missing integration rather than inventing a conversion command.

Make reproducible changes in source or build configuration. Keep `game.json`, `project.config.json`, generated entrypoints, engine adapters, subpackages, and resource paths consistent with the actual mini-game output directory. Preserve existing project and private developer-tool settings. Configure an AppID supplied by the user or existing project; a placeholder or tourist mode does not prove real account access.

Use the installed platform SDK's supported `wx` APIs for lifecycle, touch input, storage, audio, network, and assets as required by the feature. Check current package limits, domain allowlists, and base-library requirements against the project's target instead of hardcoding historical limits. Disabling checks in the simulator is not a device fix.

## Developer tools and device checks

Locate **WeChat DevTools**, not the ordinary WeChat chat app. Open/import the generated mini-game directory. Use the installed developer tool's CLI help and [official CLI documentation](https://developers.weixin.qq.com/minigame/dev/devtools/cli.html) for its actual commands and service prerequisites; do not assume a CLI or MCP intended for mini-program pages can inspect a game canvas.

Read compilation and runtime logs, exercise the changed interaction in the simulator, and generate a device preview when account access permits. Verify touch input, relaunch/storage behavior, and any changed audio or network flow on the device. OhMyGame's browser `game_use` does not control WeChat DevTools or prove device behavior. If these environments are unavailable, report the exact checks still needed.

## Upload and release

A local build or device preview request does not authorize a test-version upload, review submission, or publication. For an explicitly requested test upload, confirm the selected AppID, artifact directory, version, description, and account permissions. Use the official logged-in developer tool or supported CI flow; keep private keys in the platform's private local setup, outside plugin files and chat. Inspect the result before retrying an upload whose outcome is unknown.

Report build, simulator, device preview, upload, review, and release separately. A test-version upload is not a production publication. OhMyGame Community publishing targets a different destination.

Reference for the initial engine route: [Creator WeChat integration](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-wechatgame.html).
