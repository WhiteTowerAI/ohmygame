# Changelog

User-visible changes are collected here when maintainers prepare a release.
Older versions are documented in
[GitHub Releases](https://github.com/WhiteTowerAI/ohmygame/releases).

## [0.0.0-beta.4.7] - 2026-10-13

### Added

- A first-run welcome and model connection flow, with an option to reopen setup
  from About. ([#227](https://github.com/WhiteTowerAI/ohmygame/pull/227))
- A Simplified Chinese interface and README.
  ([#223](https://github.com/WhiteTowerAI/ohmygame/pull/223),
  [#215](https://github.com/WhiteTowerAI/ohmygame/pull/215))
- Preset and custom plugin icons.
  ([#216](https://github.com/WhiteTowerAI/ohmygame/pull/216))
- Independent OpenAI image connections alongside chat sign-in.
  ([#226](https://github.com/WhiteTowerAI/ohmygame/pull/226))
- A switch for automatic publishing covers.
  ([#214](https://github.com/WhiteTowerAI/ohmygame/pull/214))

### Changed

- Model and reasoning controls are separate in the composer.
  ([#225](https://github.com/WhiteTowerAI/ohmygame/pull/225))
- Playtest controls stay outside the game's input surface.
  ([#222](https://github.com/WhiteTowerAI/ohmygame/pull/222))

### Fixed

- Interrupted Responses WebSocket streams can recover.
  ([#212](https://github.com/WhiteTowerAI/ohmygame/pull/212))
- Closing playtest windows, broken Windows output pipes, and interrupted update
  downloads no longer crash the desktop app.
  ([#218](https://github.com/WhiteTowerAI/ohmygame/pull/218),
  [#219](https://github.com/WhiteTowerAI/ohmygame/pull/219),
  [#220](https://github.com/WhiteTowerAI/ohmygame/pull/220))
- Windows title bars use the bundled application icon.
  ([#217](https://github.com/WhiteTowerAI/ohmygame/pull/217))
- Static preview directories redirect to trailing-slash URLs.
  ([#210](https://github.com/WhiteTowerAI/ohmygame/pull/210))
- Deleted canvas images with parentheses in their names are removed from embeds.
  ([#167](https://github.com/WhiteTowerAI/ohmygame/pull/167))
- File operations preserve truncated UTF-8 text and allow case-only renames.
  ([#162](https://github.com/WhiteTowerAI/ohmygame/pull/162),
  [#166](https://github.com/WhiteTowerAI/ohmygame/pull/166))
- Scene backgrounds preserve quoted attributes, and Scenes without saved
  positions are placed clear of other cards.
  ([#160](https://github.com/WhiteTowerAI/ohmygame/pull/160),
  [#169](https://github.com/WhiteTowerAI/ohmygame/pull/169))

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.6...v0.0.0-beta.4.7

## [0.0.0-beta.4.6] - 2026-10-12

### Added

- An AI plugin builder workspace with persistent configuration, installation,
  deletion, and uninstall controls. ([#205](https://github.com/WhiteTowerAI/ohmygame/pull/205))
- Canvas media nodes use recorded image and video dimensions for their initial
  size. ([#198](https://github.com/WhiteTowerAI/ohmygame/pull/198))

### Changed

- Image history is bounded to reduce request size, with optimized OpenAI image
  requests. ([#203](https://github.com/WhiteTowerAI/ohmygame/pull/203))
- Image reference limits use model-specific defaults.
  ([#204](https://github.com/WhiteTowerAI/ohmygame/pull/204))

### Fixed

- Windows updates avoid installer conflicts and provide recovery actions when
  an update fails. ([#200](https://github.com/WhiteTowerAI/ohmygame/pull/200))
- Canvas boards keep opening when older content nodes have saved sizes.
  ([#197](https://github.com/WhiteTowerAI/ohmygame/pull/197))
- Generated images use file extensions matching their actual format.
  ([#201](https://github.com/WhiteTowerAI/ohmygame/pull/201))
- Repeated attachment names are numbered instead of rejected.
  ([#199](https://github.com/WhiteTowerAI/ohmygame/pull/199))
- Recent project cards show project activity.
  ([#207](https://github.com/WhiteTowerAI/ohmygame/pull/207))
- Canvas reference removal icons are centered.
  ([#206](https://github.com/WhiteTowerAI/ohmygame/pull/206))

**Full Changelog**: https://github.com/WhiteTowerAI/ohmygame/compare/v0.0.0-beta.4.5...v0.0.0-beta.4.6
