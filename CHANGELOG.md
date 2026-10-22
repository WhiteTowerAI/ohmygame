# Changelog

User-visible changes are collected here when maintainers prepare a release.
Older versions are documented in
[GitHub Releases](https://github.com/WhiteTowerAI/ohmygame/releases).

## [0.0.0-beta.4.12] - 2026-10-22

### Added

- Connect external Claude Code, Codex, and other MCP clients to OhMyGame's
  media, canvas, project, and playtesting tools through Settings → MCP Server.
  ([#325](https://github.com/WhiteTowerAI/ohmygame/pull/325) by @dogxii)
- Explore optional Beta plugins for Blender, Godot, TapTap Maker, Cocos Creator,
  Unity, Unreal Engine, Aseprite, Tiled, WeChat Mini Games, and Douyin Mini Games.
  Enable them from the sidebar's Plugins library; these workflows remain experimental.
  ([#278](https://github.com/WhiteTowerAI/ohmygame/pull/278) by @dogxii)

### Changed

- Set up a model provider or installed coding agent during first-run onboarding,
  choose a default model, and optionally connect creative tools before starting.
  ([#331](https://github.com/WhiteTowerAI/ohmygame/pull/331) by @dogxii)
- Browse Community in a responsive cover grid with visible titles, creators,
  engagement counts, search, sorting, and matching cards on creator profiles.
  ([#357](https://github.com/WhiteTowerAI/ohmygame/pull/357) by @dogxii)
- Publish Interactive Stories up to 100 MiB, with a longer upload timeout and
  media optimization in a temporary copy that preserves the original assets.
  ([#333](https://github.com/WhiteTowerAI/ohmygame/pull/333) by @82228)
- Connect Codex Image using its saved sign-in without an extra capability check,
  and simplify provider detail controls. Availability and quota errors are reported
  when generating an image.
  ([#356](https://github.com/WhiteTowerAI/ohmygame/pull/356) by @dogxii)

### Fixed

- Preserve recoverable canvas drafts when concurrent changes would merge into
  invalid node references, and offer conflict choices instead of losing edits.
  ([#342](https://github.com/WhiteTowerAI/ohmygame/pull/342) by @jsdhwfmax)
- Avoid a Windows checkpoint write failure when multiple files have the same
  contents and are saved at the same time.
  ([#373](https://github.com/WhiteTowerAI/ohmygame/pull/373) by @xinyang6879)
- Keep the previous story picture visible while the next node's media loads,
  reducing black flashes between story nodes.
  ([#343](https://github.com/WhiteTowerAI/ohmygame/pull/343) by @82228)
- Improve Windows title bar and sidebar appearance, keep installer progress
  moving forward, allow more time for first-start plugin preparation, and
  prevent a failed process check from incorrectly blocking installation.
  ([#352](https://github.com/WhiteTowerAI/ohmygame/pull/352) by @82228,
  [#369](https://github.com/WhiteTowerAI/ohmygame/pull/369) by @82228)
- Keep composer attachment and context menus usable near window edges and in
  short viewports, with scrolling when the full menu does not fit.
  ([#352](https://github.com/WhiteTowerAI/ohmygame/pull/352) by @82228,
  [#361](https://github.com/WhiteTowerAI/ohmygame/pull/361) by @xinyang6879)
- Make plugin Skills available to installed coding agents and prevent Codex
  startup failures caused by reserved tool names.
  ([#278](https://github.com/WhiteTowerAI/ohmygame/pull/278) by @dogxii)
- Remove the confusing Off map badge from scene cards while keeping visibility
  controls available.
  ([#346](https://github.com/WhiteTowerAI/ohmygame/pull/346) by @82228)

## [0.0.0-beta.4.11] - 2026-10-20

### Added

- Generate images with Codex CLI using its saved sign-in, independently of the
  conversation agent, from canvas image nodes or any agent's `generate_image` tool.
  ([#332](https://github.com/WhiteTowerAI/ohmygame/pull/332) by @dogxii)
- Use Gemini 4 Argon with Google Gemini and Vertex AI, including Low, Medium,
  and High reasoning, through the bundled Pi 1.3 upgrade.
  ([#316](https://github.com/WhiteTowerAI/ohmygame/pull/316) by @dihuangdh)
- Preview Markdown files with project-relative links and images in Code, and
  start publishing with the `/publish` command.
  ([#309](https://github.com/WhiteTowerAI/ohmygame/pull/309) by @dogxii)

### Changed

- Load long conversation histories, generate Scene thumbnails, and export
  media-heavy projects more efficiently.
  ([#329](https://github.com/WhiteTowerAI/ohmygame/pull/329) by @82228)
- Label coding-agent quota percentages as used, keep slash-menu usage compact,
  and show agent brand icons in model selection.
  ([#326](https://github.com/WhiteTowerAI/ohmygame/pull/326) by @dogxii)
- Kimi Coding now uses OpenAI Chat Completions through Pi 1.3; existing custom
  Base URL overrides for `kimi-coding` must include `/v1`.
  ([#316](https://github.com/WhiteTowerAI/ohmygame/pull/316) by @dihuangdh)

### Fixed

- Merge uncontested canvas node conversions without reporting a board conflict,
  while preserving conflict choices for incompatible concurrent edits.
  ([#336](https://github.com/WhiteTowerAI/ohmygame/pull/336) by @dihuangdh)
- Keep canvas connections available after importing images and saving. Generation
  prompts support Enter to generate and Shift+Enter for a new line, with input-method
  composition and video reference selection protected from accidental submission.
  ([#334](https://github.com/WhiteTowerAI/ohmygame/pull/334) by @dogxii)
- Include prebuilt Interactive Story runtime resources in desktop packages so
  story creation, legacy upgrades, and previews work inside the packaged app.
  ([#328](https://github.com/WhiteTowerAI/ohmygame/pull/328) by @ElenaYU-77)
- Discover Codex CLIs bundled with the macOS Codex and ChatGPT apps, refresh
  discovery on rescan, and explain unavailable manually selected executables.
  ([#327](https://github.com/WhiteTowerAI/ohmygame/pull/327) by @ElenaYU-77)
- Keep differential update downloads within bounded multipart Range batches to
  reduce CDN-triggered full-download fallbacks. This takes effect after installing
  this version; older installed versions keep their existing downloader.
  ([#323](https://github.com/WhiteTowerAI/ohmygame/pull/323) by @dihuangdh)
- Prevent the Design canvas viewport from flashing when opened, and correct
  project settings typography and copy.
  ([#335](https://github.com/WhiteTowerAI/ohmygame/pull/335) by @dihuangdh,
  [#324](https://github.com/WhiteTowerAI/ohmygame/pull/324) by @82228)

## [0.0.0-beta.4.10] - 2026-10-19

### Added

- Use installed Claude Code, Codex, and OpenCode CLIs in conversations, with
  their own accounts and models, native reasoning controls, and OhMyGame's
  tools, checkpoints, and Undo.
  ([#299](https://github.com/WhiteTowerAI/ohmygame/pull/299) by @dogxii)
- Manage coding agents in Settings → Agents, choose Standard or Full access
  permissions, and view reported Claude Code and Codex account usage limits.
  ([#302](https://github.com/WhiteTowerAI/ohmygame/pull/302) by @dogxii,
  [#304](https://github.com/WhiteTowerAI/ohmygame/pull/304) by @dogxii,
  [#305](https://github.com/WhiteTowerAI/ohmygame/pull/305) by @dogxii)
- A Visual Novel template with editable scripts, choices, save slots, Auto,
  Skip, Log, and Settings, plus cross-Scene music and richer Main menu controls.
  ([#284](https://github.com/WhiteTowerAI/ohmygame/pull/284) by @dihuangdh)
- Trim videos in the Library and on Asset Canvas, preview the selected range,
  and save it as a new video while keeping the original.
  ([#265](https://github.com/WhiteTowerAI/ohmygame/pull/265) by @dihuangdh)
- Trim a Scene's background video without changing the original asset or other
  Scenes, with precise time controls and Undo/Redo.
  ([#312](https://github.com/WhiteTowerAI/ohmygame/pull/312) by @82228)
- Generate sound effects and instrumental music with Volcengine Seed Audio.
  A compatible connected provider is required.
  ([#288](https://github.com/WhiteTowerAI/ohmygame/pull/288) by @82228)
- Open a project's workspace folder from recent-project and Projects menus
  in the desktop app, replacing the obsolete Game design shortcut.
  ([#315](https://github.com/WhiteTowerAI/ohmygame/pull/315) by @dogxii)

### Changed

- New Interactive Stories run as independent web pages, with a project-owned
  runtime, persistent saves, and static publishing and HTML export. Existing
  stories keep working and can upgrade with an option to undo the upgrade.
  ([#284](https://github.com/WhiteTowerAI/ohmygame/pull/284) by @dihuangdh)
- New projects can be named automatically from the first meaningful request;
  stable icon and color placeholders make projects easier to recognize.
  ([#291](https://github.com/WhiteTowerAI/ohmygame/pull/291) by @dogxii)
- Checkpoints respect workspace `.gitignore` rules and prune unreferenced
  snapshots without removing recorded turn history.
  ([#280](https://github.com/WhiteTowerAI/ohmygame/pull/280) by @xuhongbo)
- The Windows setup wizard lets users choose the installation directory and
  current-user or all-users installation, preserving existing upgrade settings.
  ([#306](https://github.com/WhiteTowerAI/ohmygame/pull/306) by @82228)
- Seedance video generation includes audio.
  ([#271](https://github.com/WhiteTowerAI/ohmygame/pull/271) by @82228)
- Release notes credit the authors of linked contributions.
  ([#283](https://github.com/WhiteTowerAI/ohmygame/pull/283) by @xuhongbo)

### Fixed

- Codex's macOS command sandbox can read the system OpenSSL configuration
  required by Node/npm when installing project dependencies.
  ([#321](https://github.com/WhiteTowerAI/ohmygame/pull/321) by @dihuangdh)
- Compatible coding-agent CLIs are checked for required capabilities instead
  of rejected solely by version; local compatibility and startup failures have
  clearer diagnostics.
  ([#317](https://github.com/WhiteTowerAI/ohmygame/pull/317) by @dogxii)
- Codex-generated images appear in the conversation and are available to the
  project.
  ([#318](https://github.com/WhiteTowerAI/ohmygame/pull/318) by @dihuangdh)
- Preview servers keep running during checkpoint snapshots, and file reads
  remain available while writes wait for a consistent snapshot.
  ([#268](https://github.com/WhiteTowerAI/ohmygame/pull/268) by @dihuangdh,
  [#273](https://github.com/WhiteTowerAI/ohmygame/pull/273) by @dihuangdh)
- Static video previews support seeking, and HEAD requests ignore byte ranges.
  ([#272](https://github.com/WhiteTowerAI/ohmygame/pull/272) by @dihuangdh,
  [#300](https://github.com/WhiteTowerAI/ohmygame/pull/300) by @jsdhwfmax)
- AI plugin authoring validates required Skill metadata and supports configuring
  and testing drafts before installation.
  ([#277](https://github.com/WhiteTowerAI/ohmygame/pull/277) by @dogxii)
- Git Changes compares files removed from the index against HEAD, and project
  exports avoid asset-name collisions on case-insensitive file systems.
  ([#281](https://github.com/WhiteTowerAI/ohmygame/pull/281) by @jsdhwfmax,
  [#269](https://github.com/WhiteTowerAI/ohmygame/pull/269) by @jsdhwfmax)
- Pages keep their horizontal alignment when scrollbars appear, and the plan
  mode label no longer wraps in narrow composer toolbars.
  ([#303](https://github.com/WhiteTowerAI/ohmygame/pull/303) by @dogxii,
  [#308](https://github.com/WhiteTowerAI/ohmygame/pull/308) by @dogxii)
- The extra-high reasoning level is translated in the Simplified Chinese UI.
  ([#282](https://github.com/WhiteTowerAI/ohmygame/pull/282) by @dogxii)

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.9...v0.0.0-beta.4.10

## [0.0.0-beta.4.9] - 2026-10-16

### Added

- Per-turn file diffs with Undo and Reapply, plus a read-only Git Changes view
  in Code.
  ([#246](https://github.com/WhiteTowerAI/ohmygame/pull/246) by @dogxii)
- Export Interactive Stories as editable projects.
  ([#253](https://github.com/WhiteTowerAI/ohmygame/pull/253) by @dihuangdh)
- A background video timeline in the Scene workbench, with playback, scrubbing,
  and Mark to attach a specific moment to an agent message.
  ([#264](https://github.com/WhiteTowerAI/ohmygame/pull/264) by @dihuangdh)
- Doubao speech generation with voice selection and preview, plus speech,
  sound-effect, and music nodes on Asset Canvas. Audio generation requires a
  compatible connected provider.
  ([#259](https://github.com/WhiteTowerAI/ohmygame/pull/259) by @82228)
- Skills in the composer's slash menu.
  ([#257](https://github.com/WhiteTowerAI/ohmygame/pull/257) by @dogxii)

### Changed

- Plugins have Public and Personal collections, separate AI setup sessions,
  enable/disable controls, Personal plugin editing, and ZIP import/export.
  ([#250](https://github.com/WhiteTowerAI/ohmygame/pull/250) by @dogxii)
- Model selection and reasoning controls share a compact composer control.
  ([#252](https://github.com/WhiteTowerAI/ohmygame/pull/252) by @dogxii)
- The Asset Canvas Library picker starts with the current project selected.
  ([#261](https://github.com/WhiteTowerAI/ohmygame/pull/261) by @dogxii)
- OpenAI and Anthropic browser sign-in options explain subscription limits.
  ([#267](https://github.com/WhiteTowerAI/ohmygame/pull/267) by @dihuangdh)

### Fixed

- Desktop apps check for updates periodically and on return to the window,
  with retries after failed checks.
  ([#260](https://github.com/WhiteTowerAI/ohmygame/pull/260) by @82228)
- Provider settings open without waiting for cloud verification.
  ([#262](https://github.com/WhiteTowerAI/ohmygame/pull/262) by @dogxii)
- Leaked thinking tags no longer appear in agent conversations or Canvas text.
  ([#263](https://github.com/WhiteTowerAI/ohmygame/pull/263) by @dogxii)
- The mouse wheel pans the canvas over node content.
  ([#255](https://github.com/WhiteTowerAI/ohmygame/pull/255) by @dihuangdh)
- New project can open an existing workspace folder.
  ([#251](https://github.com/WhiteTowerAI/ohmygame/pull/251) by @dihuangdh)
- Removed the empty-state prompt overlay from the Story canvas.
  ([#254](https://github.com/WhiteTowerAI/ohmygame/pull/254) by @dogxii)

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.8...v0.0.0-beta.4.9

## [0.0.0-beta.4.8] - 2026-10-14

### Added

- Community search, sorting, and time filters, creator profiles, and owner
  controls to edit or unpublish a game.
  ([#242](https://github.com/WhiteTowerAI/ohmygame/pull/242) by @dogxii)
- MiniMax H3 and H3-Max video generation with your own MiniMax China or Global
  API key. ([#240](https://github.com/WhiteTowerAI/ohmygame/pull/240) by @82228)
- Release notes in Settings → About, available offline and shown with
  available updates.
  ([#239](https://github.com/WhiteTowerAI/ohmygame/pull/239) by @dogxii)
- Option-drag (Alt-drag on Windows and Linux) duplicates canvas nodes.
  ([#230](https://github.com/WhiteTowerAI/ohmygame/pull/230) by @LZWcc)
- Image generation accepts a resolution and aspect ratio.
  ([#244](https://github.com/WhiteTowerAI/ohmygame/pull/244) by @82228)

### Changed

- New installations connect directly by default, and network settings are
  simpler, with clear mode hints and unsaved-change feedback.
  ([#238](https://github.com/WhiteTowerAI/ohmygame/pull/238) by @dogxii)
- Provider detail pages are reorganized, with a breadcrumb, a single connection
  row, a compact model list, and an Advanced section.
  ([#231](https://github.com/WhiteTowerAI/ohmygame/pull/231) by @dihuangdh)
- First-run setup selects the connected provider's recommended model, and
  Settings and setup list providers in the same order.
  ([#228](https://github.com/WhiteTowerAI/ohmygame/pull/228) by @dihuangdh,
  [#229](https://github.com/WhiteTowerAI/ohmygame/pull/229) by @dihuangdh)
- Back from a project returns to the page it was opened from.
  ([#241](https://github.com/WhiteTowerAI/ohmygame/pull/241) by @dogxii)
- The agent runtime is updated to Pi 1.2.0, and Azure provider settings are
  migrated automatically.
  ([#237](https://github.com/WhiteTowerAI/ohmygame/pull/237) by @dihuangdh)

### Fixed

- New projects show the empty preview instead of an error.
  ([#232](https://github.com/WhiteTowerAI/ohmygame/pull/232) by @dihuangdh)
- A preview stopped while restarting no longer stays marked as ready.
  ([#243](https://github.com/WhiteTowerAI/ohmygame/pull/243) by @dogxii)
- The light canvas background outside onboarding is restored.
  ([#245](https://github.com/WhiteTowerAI/ohmygame/pull/245) by @dogxii)

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.7...v0.0.0-beta.4.8

## [0.0.0-beta.4.7] - 2026-10-13

### Added

- A first-run welcome and model connection flow, with an option to reopen setup
  from About.
  ([#227](https://github.com/WhiteTowerAI/ohmygame/pull/227) by @dogxii)
- A Simplified Chinese interface and README.
  ([#223](https://github.com/WhiteTowerAI/ohmygame/pull/223) by @dihuangdh,
  [#215](https://github.com/WhiteTowerAI/ohmygame/pull/215) by @dihuangdh)
- Preset and custom plugin icons.
  ([#216](https://github.com/WhiteTowerAI/ohmygame/pull/216) by @dogxii)
- Independent OpenAI image connections alongside chat sign-in.
  ([#226](https://github.com/WhiteTowerAI/ohmygame/pull/226) by @dogxii)
- A switch for automatic publishing covers.
  ([#214](https://github.com/WhiteTowerAI/ohmygame/pull/214) by @dogxii)

### Changed

- Model and reasoning controls are separate in the composer.
  ([#225](https://github.com/WhiteTowerAI/ohmygame/pull/225) by @dogxii)
- Playtest controls stay outside the game's input surface.
  ([#222](https://github.com/WhiteTowerAI/ohmygame/pull/222) by @dogxii)

### Fixed

- Interrupted Responses WebSocket streams can recover.
  ([#212](https://github.com/WhiteTowerAI/ohmygame/pull/212) by @dogxii)
- Closing playtest windows, broken Windows output pipes, and interrupted update
  downloads no longer crash the desktop app.
  ([#218](https://github.com/WhiteTowerAI/ohmygame/pull/218) by @dihuangdh,
  [#219](https://github.com/WhiteTowerAI/ohmygame/pull/219) by @dihuangdh,
  [#220](https://github.com/WhiteTowerAI/ohmygame/pull/220) by @dihuangdh)
- Windows title bars use the bundled application icon.
  ([#217](https://github.com/WhiteTowerAI/ohmygame/pull/217) by @82228)
- Static preview directories redirect to trailing-slash URLs.
  ([#210](https://github.com/WhiteTowerAI/ohmygame/pull/210) by @jsdhwfmax)
- Deleted canvas images with parentheses in their names are removed from embeds.
  ([#167](https://github.com/WhiteTowerAI/ohmygame/pull/167) by @xuhongbo)
- File operations preserve truncated UTF-8 text and allow case-only renames.
  ([#162](https://github.com/WhiteTowerAI/ohmygame/pull/162) by @xuhongbo,
  [#166](https://github.com/WhiteTowerAI/ohmygame/pull/166) by @xuhongbo)
- Scene backgrounds preserve quoted attributes, and Scenes without saved
  positions are placed clear of other cards.
  ([#160](https://github.com/WhiteTowerAI/ohmygame/pull/160) by @xuhongbo,
  [#169](https://github.com/WhiteTowerAI/ohmygame/pull/169) by @xuhongbo)

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.6...v0.0.0-beta.4.7

## [0.0.0-beta.4.6] - 2026-10-12

### Added

- An AI plugin builder workspace with persistent configuration, installation,
  deletion, and uninstall controls.
  ([#205](https://github.com/WhiteTowerAI/ohmygame/pull/205) by @dogxii)
- Canvas media nodes use recorded image and video dimensions for their initial
  size.
  ([#198](https://github.com/WhiteTowerAI/ohmygame/pull/198) by @dihuangdh)

### Changed

- Image history is bounded to reduce request size, with optimized OpenAI image
  requests.
  ([#203](https://github.com/WhiteTowerAI/ohmygame/pull/203) by @dogxii)
- Image reference limits use model-specific defaults.
  ([#204](https://github.com/WhiteTowerAI/ohmygame/pull/204) by @dogxii)

### Fixed

- Windows updates avoid installer conflicts and provide recovery actions when
  an update fails.
  ([#200](https://github.com/WhiteTowerAI/ohmygame/pull/200) by @82228)
- Canvas boards keep opening when older content nodes have saved sizes.
  ([#197](https://github.com/WhiteTowerAI/ohmygame/pull/197) by @dihuangdh)
- Generated images use file extensions matching their actual format.
  ([#201](https://github.com/WhiteTowerAI/ohmygame/pull/201) by @dihuangdh)
- Repeated attachment names are numbered instead of rejected.
  ([#199](https://github.com/WhiteTowerAI/ohmygame/pull/199) by @dihuangdh)
- Recent project cards show project activity.
  ([#207](https://github.com/WhiteTowerAI/ohmygame/pull/207) by @dogxii)
- Canvas reference removal icons are centered.
  ([#206](https://github.com/WhiteTowerAI/ohmygame/pull/206) by @dogxii)

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.5...v0.0.0-beta.4.6
