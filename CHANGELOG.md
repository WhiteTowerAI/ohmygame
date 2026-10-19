# Changelog

User-visible changes are collected here when maintainers prepare a release.
Older versions are documented in
[GitHub Releases](https://github.com/WhiteTowerAI/ohmygame/releases).

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
