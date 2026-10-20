---
name: cocos-creator
description: Develop Cocos Creator 3.x scenes, TypeScript components, and assets, and build Web or mini-game output with the installed Creator editor.
---

# Cocos Creator

Read the project's Creator version from `package.json` (`creator.version`) and use the matching editor installed through Cocos Dashboard; do not migrate the project. This workflow targets Creator 3.8 LTS.

## Edit

Keep every asset's `.meta` file and UUID references. Use the engine APIs of the project's version and keep existing component registration and serialized properties. Never edit `library/`, `temp/`, or build output as source.

## Build

```text
<CREATOR> --project <ABSOLUTE_PROJECT> --build "platform=web-mobile;debug=true"
```

Exit code 36 means success; 32 (invalid parameters) and 34 (build error) mean failure. Prefer a build configuration exported from Creator's Build panel, passed as `configPath=<FILE>` inside the `--build` string. The standalone `cocos-cli` cannot package mini-games.

For WeChat or Douyin, also follow that platform's Skill when it is enabled. Keep one engine project with a separate build configuration and output directory per platform.

Open the output in a browser or the platform's developer tool and exercise the changed behavior; a successful build proves packaging only.
