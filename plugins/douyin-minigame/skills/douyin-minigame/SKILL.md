---
name: douyin-minigame
description: Adapt and package games for Douyin Mini Games, diagnose developer-tool or device previews, and perform explicitly requested test uploads.
---

# Douyin Mini Games

Identify the engine, its Douyin exporter or SDK, the generated game directory, and the AppID. A Web build or a WeChat adapter does not make a Douyin game.

## Package

Use the engine's own route: Cocos Creator's Douyin mini-game build target, or the platform's Unity conversion SDK, distinguishing its WebGL and native targets. Keep changes in engine source or build configuration, not generated output.

Check `project.config.json`, `game.json`, entry points, subpackages, and resource paths against the exporter's output, and keep the existing AppID. Use `tt` APIs for lifecycle, touch, storage, audio, and networking.

## Developer tools

Import the generated directory into Douyin's game developer tool. Verify the change in its simulator and in a device preview. The mini-game CLI is `tt-minigame-ide-cli` (command `tmg`), not the mini-app CLI; read `npx -y --package=tt-minigame-ide-cli@2.1.1 tmg --help` before choosing commands.

## Upload

A build or preview request does not authorize an upload. Upload only when explicitly asked: confirm the AppID, output directory, version, and description, and use the developer tool's own login. Keep credentials out of the workspace and chat. Check an upload with an unknown outcome before retrying. Upload, review, and release are separate steps.
