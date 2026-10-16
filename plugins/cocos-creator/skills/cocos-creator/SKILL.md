---
name: cocos-creator
description: Develop Cocos Creator scenes, TypeScript components, and assets, and build Web or mini-game artifacts using an installed Creator editor.
---

# Cocos Creator

Inspect `package.json`, `settings/`, and the project's Creator metadata to identify the editor version and existing build targets. The initial workflow targets Creator 3.8 LTS; use the project's matching editor rather than migrating it. Locate the local Creator executable through its installation or Dashboard. Quote absolute executable and project paths.

Use a General project for the Creator source directory. Keep OhMyGame's web preview off for native editor and mini-game work. A Web export can use browser preview after its real build and serving command have been established.

## Edit and build

Preserve asset `.meta` files and UUID references. Use Creator APIs for the detected version, retain existing component registration and serialized properties, and let the editor maintain imported caches. Do not edit generated `library/`, `temp/`, or build output as source. Reuse the project's build profiles and platform adapters.

Creator's own executable provides the build entrypoint. For 3.8, an illustrative Web build is:

```text
<CREATOR> --project <ABSOLUTE_PROJECT> --build "platform=web-mobile;debug=true"
```

Read the matching editor's help and existing configuration before choosing options. Prefer a build configuration exported by Creator for platform-specific settings; `configPath` belongs inside the `--build` option string. Use `--project` for 3.x. The separate open-source `cocos-cli` is not a substitute for Creator's mini-game packaging pipeline.

For WeChat or Douyin, use the corresponding enabled platform Skill when available, or the official platform integration instructions. Keep one engine project with separate target configurations and output directories. Do not create a second engine implementation for each platform. Initialize only an empty, explicitly selected directory using a template supported by the installed editor.

## Verification

Record the editor version, target, build configuration, output path, exit status, and relevant logs. Read Creator's documented exit codes and logs; do not interpret an unusual exit status as success without evidence. Confirm that output belongs to this build, then open it in the actual browser or platform developer tool.

Exercise the changed input and state transitions and inspect runtime errors. For asset changes, check the imported appearance and references in Creator. A successful build establishes packaging only; mini-game device behavior, upload, review, and publication have their own checks.

Official references: [Creator 3.8 CLI](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-in-command-line.html), [WeChat export](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-wechatgame.html), [Douyin export](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-bytedance-mini-game.html).
