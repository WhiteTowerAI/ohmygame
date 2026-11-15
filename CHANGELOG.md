# Changelog

User-visible changes are collected here when maintainers prepare a release.
Older versions are documented in
[GitHub Releases](https://github.com/WhiteTowerAI/ohmygame/releases).

## [0.0.0-beta.5.7] - 2026-11-12

### Added

- Play Web Games online with friends: the agent sets up turn-based or realtime
  rooms, and players' sign-in, cloud saves and leaderboards, on OhMyGame's game
  service, so publishing needs no server of your own.
  ([#759](https://github.com/WhiteTowerAI/ohmygame/pull/759) by @xinyang6879)
- Browse plugins as in an app store: Discover with categories, recommended
  order, and a page for each plugin with screenshots and details; Installed
  with updates first; and Mine for the plugins you make with AI.
  ([#769](https://github.com/WhiteTowerAI/ohmygame/pull/769) by @dogxii)
- Check pixel art in Image tools: logical size, colours, stray pixels, outline
  and feet row, and whether several sprites match.
  ([#774](https://github.com/WhiteTowerAI/ohmygame/pull/774) by @xinyang6879)
- Add a Japanese README.
  ([#753](https://github.com/WhiteTowerAI/ohmygame/pull/753) by @eltociear)

### Changed

- Give each plugin one switch: adding a plugin or turning it on allows what it
  asks for, with no second approval, and projects can still turn it off for
  themselves. Plugins that use newer manifest fields still install, and a new
  version removes older ones no project uses.
  ([#769](https://github.com/WhiteTowerAI/ohmygame/pull/769) by @dogxii)
- Fix pixel art finds the real pixel grid, even when its cells are uneven, so
  generated pixel art no longer comes out as a mosaic.
  ([#774](https://github.com/WhiteTowerAI/ohmygame/pull/774) by @xinyang6879)
- Shorten the README to a landing page that links to the website's docs.
  ([#757](https://github.com/WhiteTowerAI/ohmygame/pull/757) by @dogxii)

### Fixed

- Find coding agents that npm installed, such as Gemini CLI, on Windows.
  ([#769](https://github.com/WhiteTowerAI/ohmygame/pull/769) by @dogxii)
- Title successful Canvas actions, such as Created and Downloaded, as results
  rather than failures.
  ([#774](https://github.com/WhiteTowerAI/ohmygame/pull/774) by @xinyang6879)
- Say when a copy button could not copy to the clipboard.
  ([#738](https://github.com/WhiteTowerAI/ohmygame/pull/738) by @jay23606)

## [0.0.0-beta.5.6] - 2026-11-11

### Added

- Add ElevenLabs for speech, sound effects, music and transcription, with your
  account's voices, Transcribe to text on an audio node, and the newer Sound
  Effects v3 and Music v2.5 models.
  ([#748](https://github.com/WhiteTowerAI/ohmygame/pull/748) by @dihuangdh,
  [#768](https://github.com/WhiteTowerAI/ohmygame/pull/768) by @idontcarethishahaha)
- Set default models for speech, sound effects and music, for every project or
  for one.
  ([#756](https://github.com/WhiteTowerAI/ohmygame/pull/756) by @dihuangdh)
- Add a pixel art fixer to Canvas images, which makes a clean pixel-art copy
  and leaves the source untouched.
  ([#743](https://github.com/WhiteTowerAI/ohmygame/pull/743) by @idontcarethishahaha)
- Sort Library and project assets by date, size or name, and filter them by
  when they were added or changed.
  ([#742](https://github.com/WhiteTowerAI/ohmygame/pull/742) by @dogxii)
- Keep the sidebar's projects in an order you choose: drag them, or use Alt
  with the arrow keys, and pick how many show. The section is now Quick access.
  ([#745](https://github.com/WhiteTowerAI/ohmygame/pull/745) by @dogxii)
- Let a General project without a web preview add the Game panel, and show a
  project's own panels in Code.
  ([#733](https://github.com/WhiteTowerAI/ohmygame/pull/733) by @dogxii)
- Add OhMyGame's own plugins from its `@ohmygame` npm scope.
  ([#766](https://github.com/WhiteTowerAI/ohmygame/pull/766) by @dogxii)

### Changed

- Make audio one Canvas node and one agent tool for speech, sound effects and
  music, choose from compact controls under the node, and give the node the
  16:9 media shape. Existing boards open in the new form.
  ([#748](https://github.com/WhiteTowerAI/ohmygame/pull/748) by @dihuangdh,
  [#752](https://github.com/WhiteTowerAI/ohmygame/pull/752) by @dihuangdh,
  [#749](https://github.com/WhiteTowerAI/ohmygame/pull/749) by @dihuangdh,
  [#768](https://github.com/WhiteTowerAI/ohmygame/pull/768) by @idontcarethishahaha,
  [#770](https://github.com/WhiteTowerAI/ohmygame/pull/770) by @xinyang6879)
- Set up Doubao Speech as one provider for TTS 2.0 and Seed Audio, with one API
  key, switch and voice.
  ([#751](https://github.com/WhiteTowerAI/ohmygame/pull/751) by @dihuangdh,
  [#755](https://github.com/WhiteTowerAI/ohmygame/pull/755) by @dihuangdh)
- Show generated images, videos and 3D models as small thumbnails beside the
  tool calls that made them, instead of large previews after the reply.
  ([#763](https://github.com/WhiteTowerAI/ohmygame/pull/763) by @dihuangdh)
- Run Claude Code's media generation calls side by side, and label calls
  waiting behind a running one as queued.
  ([#765](https://github.com/WhiteTowerAI/ohmygame/pull/765) by @dihuangdh)
- Give each project action one home: one Project settings dialog for every
  project type, and Play in the top bar for interactive stories too.
  ([#741](https://github.com/WhiteTowerAI/ohmygame/pull/741) by @dogxii,
  [#739](https://github.com/WhiteTowerAI/ohmygame/pull/739) by @dihuangdh,
  [#740](https://github.com/WhiteTowerAI/ohmygame/pull/740) by @dihuangdh)
- Show Community pages you've seen at once while they refresh, with card
  skeletons and a loading screen while a game starts.
  ([#746](https://github.com/WhiteTowerAI/ohmygame/pull/746) by @dogxii)
- Show 3D preview controls only for models with animations, and play the clip
  without turning the model.
  ([#762](https://github.com/WhiteTowerAI/ohmygame/pull/762) by @dihuangdh)
- Point plugin and project `$schema` links at ohmygame.ai.
  ([#729](https://github.com/WhiteTowerAI/ohmygame/pull/729) by @dogxii)

### Removed

- Remove the Three.js World and Image to Three.js plugins. The copy OhMyGame
  installed is uninstalled once.
  ([#734](https://github.com/WhiteTowerAI/ohmygame/pull/734) by @dogxii)

### Fixed

- Offer a link to copy when the system can't open it, such as on Windows
  without a default browser, and ignore copies that fail because the window
  lost focus.
  ([#758](https://github.com/WhiteTowerAI/ohmygame/pull/758) by @dihuangdh)
- Start a conversation without a model on the one its picker shows.
  ([#724](https://github.com/WhiteTowerAI/ohmygame/pull/724) by @dogxii)
- Open a project's Canvas even when the project has its own `design/` folder
  or `canvas.json`.
  ([#761](https://github.com/WhiteTowerAI/ohmygame/pull/761) by @dogxii)
- Ready the plugin author packages for npm, and list every part of a plugin
  when you review it before adding.
  ([#731](https://github.com/WhiteTowerAI/ohmygame/pull/731) by @dogxii)
- Fix spacing and colors in the AI workspace Overview, plugin lists, the audio
  panel in light mode and the media submenu.
  ([#754](https://github.com/WhiteTowerAI/ohmygame/pull/754) by @dogxii,
  [#750](https://github.com/WhiteTowerAI/ohmygame/pull/750) by @dihuangdh,
  [#747](https://github.com/WhiteTowerAI/ohmygame/pull/747) by @xinyang6879)

## [0.0.0-beta.5.5] - 2026-11-06

### Added

- Open the plugin market, read from its published index, and offer only
  updates the market allows.
  ([#710](https://github.com/WhiteTowerAI/ohmygame/pull/710) by @dogxii)
- Let plugins do much more: run, capture and play the game and extend its
  preview; react to hooks such as a finished turn or an image about to be
  generated; publish projects and add themes; add canvas nodes, presets and
  chains; and bring their own model providers and agents.
  ([#688](https://github.com/WhiteTowerAI/ohmygame/pull/688) by @dogxii,
  [#701](https://github.com/WhiteTowerAI/ohmygame/pull/701) by @dogxii,
  [#702](https://github.com/WhiteTowerAI/ohmygame/pull/702) by @dogxii,
  [#703](https://github.com/WhiteTowerAI/ohmygame/pull/703) by @dogxii,
  [#704](https://github.com/WhiteTowerAI/ohmygame/pull/704) by @dogxii)
- Add tools for plugin authors: the `ohmygame-plugin` CLI, a
  `create-ohmygame-plugin` template, a development mode and export.
  ([#707](https://github.com/WhiteTowerAI/ohmygame/pull/707) by @dogxii)
- Let a project hold panels of its own in `.ohmygame/panels/`, which its agent
  can write, shown beside the chat once you allow what each asks for.
  ([#722](https://github.com/WhiteTowerAI/ohmygame/pull/722) by @dogxii)
- Rename, reorder and repoint coding agent accounts from a menu on each
  account.
  ([#709](https://github.com/WhiteTowerAI/ohmygame/pull/709) by @dogxii)

### Changed

- Record each project's type in its root `ohmygame.json` and use it when
  opening folders and importing archives, preserving the project's settings
  and refusing to reopen it as a different type.
  ([#726](https://github.com/WhiteTowerAI/ohmygame/pull/726) by @dogxii)
- Run the Plugin Builder as a project with the full project chat, let it make
  every kind of plugin, and split the Plugins page by what you want to do.
  ([#713](https://github.com/WhiteTowerAI/ohmygame/pull/713) by @dogxii,
  [#725](https://github.com/WhiteTowerAI/ohmygame/pull/725) by @dogxii)
- Make plugin uninstalls, updates, errors and safe mode clearer and safer, and
  describe what a plugin asks for in plain, grouped lines.
  ([#695](https://github.com/WhiteTowerAI/ohmygame/pull/695) by @dogxii,
  [#714](https://github.com/WhiteTowerAI/ohmygame/pull/714) by @dogxii)
- Keep everything OhMyGame stores for a project in its folder's `.ohmygame/`,
  so the folder is the whole project. Existing projects move over when opened.
  ([#721](https://github.com/WhiteTowerAI/ohmygame/pull/721) by @dogxii)
- Show generated images as thumbnails in the tool details instead of a large
  gallery after the reply.
  ([#699](https://github.com/WhiteTowerAI/ohmygame/pull/699) by @dogxii)
- Keep 3D previews still until you press Play, and load large 3D files and
  canvas media only when needed.
  ([#684](https://github.com/WhiteTowerAI/ohmygame/pull/684) by @82228,
  [#712](https://github.com/WhiteTowerAI/ohmygame/pull/712) by @dogxii)
- Report OhMyGame as Claude Code's client, with a switch to turn it off.
  ([#708](https://github.com/WhiteTowerAI/ohmygame/pull/708) by @dogxii)

### Fixed

- Make streaming chat replies much lighter on the app, and stop game stills
  from stalling tab switches.
  ([#711](https://github.com/WhiteTowerAI/ohmygame/pull/711) by @dogxii,
  [#712](https://github.com/WhiteTowerAI/ohmygame/pull/712) by @dogxii,
  [#718](https://github.com/WhiteTowerAI/ohmygame/pull/718) by @dogxii)
- Load the Code file tree one folder at a time, so large projects open fast,
  and add a Refresh files button.
  ([#698](https://github.com/WhiteTowerAI/ohmygame/pull/698) by @82228)
- Continue the same Codex conversation after a stop or a failed request.
  ([#700](https://github.com/WhiteTowerAI/ohmygame/pull/700) by @dogxii)
- Restore drag-to-select on an empty canvas.
  ([#697](https://github.com/WhiteTowerAI/ohmygame/pull/697) by @dogxii)
- Keep the Windows Back and Forward buttons visible and clickable.
  ([#694](https://github.com/WhiteTowerAI/ohmygame/pull/694) by @idontcarethishahaha)
- Find Godot on Windows by its release file names, WinGet, Scoop and every
  Steam library.
  ([#705](https://github.com/WhiteTowerAI/ohmygame/pull/705) by @xinyang6879)
- Use the plain refresh icon for Restart to update.
  ([#696](https://github.com/WhiteTowerAI/ohmygame/pull/696) by @xinyang6879)
- Leave stored data that can't be read as it is instead of overwriting it.
  ([#719](https://github.com/WhiteTowerAI/ohmygame/pull/719) by @dogxii)

## [0.0.0-beta.5.4] - 2026-11-04

### Changed

- Rename the home page's creative templates to asset templates, move them
  below Explore, and give each card a short description of what it makes.
  ([#685](https://github.com/WhiteTowerAI/ohmygame/pull/685) by @dihuangdh)
- Rewrite the pixel-art and effect template guides to start with how to begin,
  with shorter step lists and where each result fits in a game.
  ([#686](https://github.com/WhiteTowerAI/ohmygame/pull/686) by @dihuangdh)

### Fixed

- Stop showing "The background service is unavailable" when macOS reopens the
  app, such as after an update, before its background service has started.
  ([#690](https://github.com/WhiteTowerAI/ohmygame/pull/690) by @xinyang6879)

## [0.0.0-beta.5.3] - 2026-11-04

### Added

- Add pixel-art canvas templates and reusable asset workflows for characters,
  effects, objects, scenes, skins and terrain.
- Add bundled media tools for image processing and FFmpeg-backed audio/video
  workflows in the desktop app.

### Improved

- Improve project switching, canvas performance, interactive workspace
  rendering, preview reliability and desktop window controls.
- Improve the updater, startup loading experience, external MCP paths and
  agent runtime recovery across platforms.

### Fixed

- Package the media dependencies required by installed desktop builds and
  validate the bundled FFmpeg license on Windows.

## [0.0.0-beta.5.2] - 2026-11-03

### Fixed

- Show plugin panels, such as TapTap Maker, in the installed app, where they
  were blank in 0.0.0-beta.5.1.
  ([#663](https://github.com/WhiteTowerAI/ohmygame/pull/663) by @dogxii)

## [0.0.0-beta.5.1] - 2026-11-03

### Added

- A new look across the app: a sidebar with Home, Projects, Library, Community
  and Plugins, redesigned pages, and a launch screen that picks the AI from
  cards. Every screen follows the appearance and the Neutral, Warm and High
  contrast palettes.
  ([#457](https://github.com/WhiteTowerAI/ohmygame/pull/457) by @dogxii,
  [#458](https://github.com/WhiteTowerAI/ohmygame/pull/458) by @dogxii,
  [#471](https://github.com/WhiteTowerAI/ohmygame/pull/471) by @dogxii,
  [#472](https://github.com/WhiteTowerAI/ohmygame/pull/472) by @dogxii,
  [#474](https://github.com/WhiteTowerAI/ohmygame/pull/474) by @dogxii,
  [#476](https://github.com/WhiteTowerAI/ohmygame/pull/476) by @dogxii,
  [#478](https://github.com/WhiteTowerAI/ohmygame/pull/478) by @dogxii,
  [#506](https://github.com/WhiteTowerAI/ohmygame/pull/506) by @dogxii,
  [#508](https://github.com/WhiteTowerAI/ohmygame/pull/508) by @dogxii,
  [#509](https://github.com/WhiteTowerAI/ohmygame/pull/509) by @dogxii,
  [#511](https://github.com/WhiteTowerAI/ohmygame/pull/511) by @dogxii,
  [#514](https://github.com/WhiteTowerAI/ohmygame/pull/514) by @dogxii,
  [#522](https://github.com/WhiteTowerAI/ohmygame/pull/522) by @dogxii,
  [#530](https://github.com/WhiteTowerAI/ohmygame/pull/530) by @dogxii)
- Projects open in a workspace of panels (Chat, Game, Design, Canvas, Code,
  Assets) that can be arranged in four areas, with a project rail, a top bar
  with Play and Publish, and layout presets. The interactive story editor uses
  the same panels, and the game design document opens as its own Design panel.
  ([#486](https://github.com/WhiteTowerAI/ohmygame/pull/486) by @dogxii,
  [#488](https://github.com/WhiteTowerAI/ohmygame/pull/488) by @dogxii,
  [#490](https://github.com/WhiteTowerAI/ohmygame/pull/490) by @dogxii,
  [#491](https://github.com/WhiteTowerAI/ohmygame/pull/491) by @dogxii,
  [#494](https://github.com/WhiteTowerAI/ohmygame/pull/494) by @dogxii,
  [#499](https://github.com/WhiteTowerAI/ohmygame/pull/499) by @dogxii,
  [#561](https://github.com/WhiteTowerAI/ohmygame/pull/561) by @dihuangdh)
- Start every project from Home: send a prompt to create the project at once,
  with its type and plugins chosen in the prompt box. The new-project dialog
  opens only when something needs an answer.
  ([#477](https://github.com/WhiteTowerAI/ohmygame/pull/477) by @dogxii,
  [#525](https://github.com/WhiteTowerAI/ohmygame/pull/525) by @dogxii,
  [#535](https://github.com/WhiteTowerAI/ohmygame/pull/535) by @dogxii,
  [#538](https://github.com/WhiteTowerAI/ohmygame/pull/538) by @dogxii,
  [#551](https://github.com/WhiteTowerAI/ohmygame/pull/551) by @dihuangdh,
  [#552](https://github.com/WhiteTowerAI/ohmygame/pull/552) by @dihuangdh,
  [#553](https://github.com/WhiteTowerAI/ohmygame/pull/553) by @dihuangdh)
- A command menu (⌘K / Ctrl+K) lists pages, panels, layouts and projects, with
  ⌘N for a new project and ⌘, for Settings.
  ([#500](https://github.com/WhiteTowerAI/ohmygame/pull/500) by @dogxii)
- While the Chat panel is closed, the composer floats over the middle of the
  project.
  ([#501](https://github.com/WhiteTowerAI/ohmygame/pull/501) by @dogxii)
- Mention any number of plugins and Skills in a message; they show as chips in
  the prompt, and every agent receives each Skill named.
  ([#548](https://github.com/WhiteTowerAI/ohmygame/pull/548) by @dihuangdh,
  [#549](https://github.com/WhiteTowerAI/ohmygame/pull/549) by @dihuangdh)
- Schedule a message for later with `/later`.
  ([#652](https://github.com/WhiteTowerAI/ohmygame/pull/652) by @dogxii)
- Archive conversations, and see a status line under the composer.
  Conversation history opens from an icon in the chat header.
  ([#522](https://github.com/WhiteTowerAI/ohmygame/pull/522) by @dogxii,
  [#634](https://github.com/WhiteTowerAI/ohmygame/pull/634) by @dogxii)
- Click chat images to view them larger, and copy or save them with a
  right-click.
  ([#639](https://github.com/WhiteTowerAI/ohmygame/pull/639) by @dogxii)
- Desktop notifications for approvals, questions, plans and finished or failed
  turns, with a Dock badge on macOS and a taskbar overlay on Windows.
  ([#481](https://github.com/WhiteTowerAI/ohmygame/pull/481) by @dihuangdh)
- Tune a running game's values from a **Tune** panel without reloading it.
  ([#614](https://github.com/WhiteTowerAI/ohmygame/pull/614) by @dogxii)
- Record a running game to a video in the Library from the top bar, or with
  Cmd/Ctrl+Shift+R.
  ([#619](https://github.com/WhiteTowerAI/ohmygame/pull/619) by @dogxii)
- Export the web build from the Publish menu, to host the game elsewhere.
  ([#503](https://github.com/WhiteTowerAI/ohmygame/pull/503) by @dogxii)
- Connect canvas nodes from ports and pick references on the board, and let
  the agent generate up to eight canvas nodes in one call.
  ([#638](https://github.com/WhiteTowerAI/ohmygame/pull/638) by @dogxii,
  [#628](https://github.com/WhiteTowerAI/ohmygame/pull/628) by @dogxii)
- Settings → Account shows token usage over 7 days, 30 days or all time, by
  model and by project, with a shareable image.
  ([#621](https://github.com/WhiteTowerAI/ohmygame/pull/621) by @dogxii)
- Choose in Settings → About whether usage data is sent; when signed in, it is
  linked to the account id only.
  ([#466](https://github.com/WhiteTowerAI/ohmygame/pull/466) by @dihuangdh)
- Plugin format 2: plugins can add project types, Skills, tools, MCP servers
  (local or HTTP), panels and commands, and are turned on per project. Add
  plugins from npm, GitHub or a local package, or browse and install them from
  the plugin market. The Plugin Builder creates format 2 plugins.
  ([#456](https://github.com/WhiteTowerAI/ohmygame/pull/456) by @dogxii,
  [#539](https://github.com/WhiteTowerAI/ohmygame/pull/539) by @dogxii,
  [#545](https://github.com/WhiteTowerAI/ohmygame/pull/545) by @dogxii,
  [#577](https://github.com/WhiteTowerAI/ohmygame/pull/577) by @dogxii,
  [#584](https://github.com/WhiteTowerAI/ohmygame/pull/584) by @dogxii,
  [#592](https://github.com/WhiteTowerAI/ohmygame/pull/592) by @dogxii,
  [#594](https://github.com/WhiteTowerAI/ohmygame/pull/594) by @dogxii,
  [#610](https://github.com/WhiteTowerAI/ohmygame/pull/610) by @dogxii)
- Plugin panels look like part of the app and can use page components, a brand
  colour, a toolbar, toasts and questions, and the project's files.
  ([#602](https://github.com/WhiteTowerAI/ohmygame/pull/602) by @dogxii,
  [#606](https://github.com/WhiteTowerAI/ohmygame/pull/606) by @dogxii,
  [#616](https://github.com/WhiteTowerAI/ohmygame/pull/616) by @dogxii,
  [#618](https://github.com/WhiteTowerAI/ohmygame/pull/618) by @dogxii,
  [#626](https://github.com/WhiteTowerAI/ohmygame/pull/626) by @dogxii,
  [#627](https://github.com/WhiteTowerAI/ohmygame/pull/627) by @dogxii,
  [#629](https://github.com/WhiteTowerAI/ohmygame/pull/629) by @dogxii,
  [#630](https://github.com/WhiteTowerAI/ohmygame/pull/630) by @dogxii,
  [#633](https://github.com/WhiteTowerAI/ohmygame/pull/633) by @dogxii,
  [#637](https://github.com/WhiteTowerAI/ohmygame/pull/637) by @dogxii,
  [#642](https://github.com/WhiteTowerAI/ohmygame/pull/642) by @dogxii)
- MCP servers you add yourself now live in Settings → MCP Connections.
  ([#580](https://github.com/WhiteTowerAI/ohmygame/pull/580) by @dogxii)
- TapTap Maker shows its setup as steps until it is ready, connects from a
  folder that already has files, reports Maker's own preview errors and
  retries failed downloads.
  ([#568](https://github.com/WhiteTowerAI/ohmygame/pull/568) by @dogxii,
  [#603](https://github.com/WhiteTowerAI/ohmygame/pull/603) by @dogxii,
  [#609](https://github.com/WhiteTowerAI/ohmygame/pull/609) by @dogxii,
  [#632](https://github.com/WhiteTowerAI/ohmygame/pull/632) by @dogxii,
  [#540](https://github.com/WhiteTowerAI/ohmygame/pull/540) by @dogxii,
  [#576](https://github.com/WhiteTowerAI/ohmygame/pull/576) by @dogxii)
- Windows and Linux get Back and Forward in the title bar, and the Windows
  title bar menus follow the UI language.
  ([#502](https://github.com/WhiteTowerAI/ohmygame/pull/502) by @dogxii,
  [#643](https://github.com/WhiteTowerAI/ohmygame/pull/643) by @dogxii,
  [#646](https://github.com/WhiteTowerAI/ohmygame/pull/646) by @dogxii)

### Changed

- The bundled plugins (Godot, Unreal Engine, img2threejs, TapTap Maker and the
  Skills-only plugins) are now format 2 plugins, and Godot is one plugin.
  ([#572](https://github.com/WhiteTowerAI/ohmygame/pull/572) by @dogxii,
  [#575](https://github.com/WhiteTowerAI/ohmygame/pull/575) by @dogxii,
  [#577](https://github.com/WhiteTowerAI/ohmygame/pull/577) by @dogxii,
  [#581](https://github.com/WhiteTowerAI/ohmygame/pull/581) by @dogxii,
  [#568](https://github.com/WhiteTowerAI/ohmygame/pull/568) by @dogxii)
- A plugin runs only in the project types it names.
  ([#578](https://github.com/WhiteTowerAI/ohmygame/pull/578) by @dogxii)
- After a usage limit resets, an agent continues the turn on its own while
  OhMyGame is open, and the error card shows when it will.
  ([#648](https://github.com/WhiteTowerAI/ohmygame/pull/648) by @dogxii,
  [#651](https://github.com/WhiteTowerAI/ohmygame/pull/651) by @dogxii)
- An unused game preview stops after a minute, and at most one keeps running
  after leaving a project.
  ([#641](https://github.com/WhiteTowerAI/ohmygame/pull/641) by @dogxii)
- Settings → Providers shows and hides models with a checkbox on every
  provider's rows, and Settings → MCP Server shows other MCP clients the
  launcher's command, arguments and environment as separate fields.
  ([#529](https://github.com/WhiteTowerAI/ohmygame/pull/529) by @dogxii,
  [#533](https://github.com/WhiteTowerAI/ohmygame/pull/533) by @dogxii,
  [#524](https://github.com/WhiteTowerAI/ohmygame/pull/524) by @dogxii)
- Community leads with search and **My games**, and reloads when the window
  returns.
  ([#562](https://github.com/WhiteTowerAI/ohmygame/pull/562) by @dihuangdh)
- Agents that join a conversation get a shorter handoff, with only what they
  cannot find themselves.
  ([#597](https://github.com/WhiteTowerAI/ohmygame/pull/597) by @dogxii,
  [#607](https://github.com/WhiteTowerAI/ohmygame/pull/607) by @dogxii)

### Removed

- Plugin format 1. Installed format 1 plugins are not converted; their data
  stays on disk unused. Projects made with format 1 TapTap Maker, Godot or
  Unreal Engine plugins are not migrated.
  ([#583](https://github.com/WhiteTowerAI/ohmygame/pull/583) by @dogxii,
  [#605](https://github.com/WhiteTowerAI/ohmygame/pull/605) by @dogxii)

### Fixed

- Keep Claude Code's session after **Stop**, and keep the chosen account,
  model and thinking level when a message is edited.
  ([#596](https://github.com/WhiteTowerAI/ohmygame/pull/596) by @dogxii,
  [#650](https://github.com/WhiteTowerAI/ohmygame/pull/650) by @dogxii,
  [#653](https://github.com/WhiteTowerAI/ohmygame/pull/653) by @dogxii)
- Keep the file tree and the open file in place when files refresh, and keep
  recent projects from reordering on open.
  ([#625](https://github.com/WhiteTowerAI/ohmygame/pull/625) by @dogxii,
  [#528](https://github.com/WhiteTowerAI/ohmygame/pull/528) by @dogxii)
- Don't reload the game for design canvas changes, and don't show a missing
  dev script error on a new empty project.
  ([#489](https://github.com/WhiteTowerAI/ohmygame/pull/489) by @dogxii,
  [#585](https://github.com/WhiteTowerAI/ohmygame/pull/585) by @dihuangdh)
- Show images that file tools return in their details, and say that the retry
  count covers the whole turn.
  ([#624](https://github.com/WhiteTowerAI/ohmygame/pull/624) by @dogxii,
  [#623](https://github.com/WhiteTowerAI/ohmygame/pull/623) by @dogxii)
- Back and Forward in a project's title bar take clicks on macOS.
  ([#558](https://github.com/WhiteTowerAI/ohmygame/pull/558) by @dihuangdh)
- Note a plugin's change before it runs, so a failure can't lose its Undo.
  ([#644](https://github.com/WhiteTowerAI/ohmygame/pull/644) by @dogxii)
- Use the CLI's default config directory for the System default agent account.
  ([#512](https://github.com/WhiteTowerAI/ohmygame/pull/512) by @dogxii)
- Long sessions use less memory, and sending a message reads only what the
  session gained.
  ([#631](https://github.com/WhiteTowerAI/ohmygame/pull/631) by @dogxii,
  [#636](https://github.com/WhiteTowerAI/ohmygame/pull/636) by @dogxii)
- Make the publish cover preview crop match project and Community cards.
  ([#485](https://github.com/WhiteTowerAI/ohmygame/pull/485) by @dihuangdh)
- Fix layout and styling issues in the composer, menus, sheets, sidebar,
  canvas and Settings.
  ([#505](https://github.com/WhiteTowerAI/ohmygame/pull/505) by @dogxii,
  [#534](https://github.com/WhiteTowerAI/ohmygame/pull/534) by @dogxii,
  [#536](https://github.com/WhiteTowerAI/ohmygame/pull/536) by @dogxii,
  [#537](https://github.com/WhiteTowerAI/ohmygame/pull/537) by @dogxii,
  [#550](https://github.com/WhiteTowerAI/ohmygame/pull/550) by @dihuangdh,
  [#556](https://github.com/WhiteTowerAI/ohmygame/pull/556) by @dihuangdh,
  [#557](https://github.com/WhiteTowerAI/ohmygame/pull/557) by @dihuangdh,
  [#559](https://github.com/WhiteTowerAI/ohmygame/pull/559) by @dihuangdh,
  [#560](https://github.com/WhiteTowerAI/ohmygame/pull/560) by @dihuangdh,
  [#563](https://github.com/WhiteTowerAI/ohmygame/pull/563) by @dihuangdh,
  [#564](https://github.com/WhiteTowerAI/ohmygame/pull/564) by @dihuangdh,
  [#586](https://github.com/WhiteTowerAI/ohmygame/pull/586) by @dihuangdh,
  [#620](https://github.com/WhiteTowerAI/ohmygame/pull/620) by @dogxii,
  [#645](https://github.com/WhiteTowerAI/ohmygame/pull/645) by @dogxii,
  [#647](https://github.com/WhiteTowerAI/ohmygame/pull/647) by @dogxii)

## [0.0.0-beta.5.0] - 2026-10-29

### Added

- Browse every image, video, and audio file of an Interactive Story in a new
  **Assets** tab, with type and collection filters, search, preview, and
  **Show in Code**.
  ([#445](https://github.com/WhiteTowerAI/ohmygame/pull/445) by @dihuangdh)
- Play a Scene's background video through instead of cutting it short on a
  click, and offer **Skip** when the player has seen the Scene before. A Scene
  opened with Allow Back can return when its video ends.
  ([#429](https://github.com/WhiteTowerAI/ohmygame/pull/429) by @dihuangdh,
  [#448](https://github.com/WhiteTowerAI/ohmygame/pull/448) by @dihuangdh)
- Start from **Last Bus (末班)**, a 39-Scene interactive film example that
  includes its design canvas, planning documents, generation history, and
  drafts. Home's Explore section now shows two rows of examples.
  ([#449](https://github.com/WhiteTowerAI/ohmygame/pull/449) by @dihuangdh,
  [#451](https://github.com/WhiteTowerAI/ohmygame/pull/451) by @dihuangdh,
  [#450](https://github.com/WhiteTowerAI/ohmygame/pull/450) by @dihuangdh)
- Choose from the full Doubao TTS 2.0 preset voice catalog, grouped by
  language with official samples that use no synthesis quota, and tune pitch,
  volume, speed, dialect, pronunciation, SSML, trailing silence, and bit rate.
  ([#406](https://github.com/WhiteTowerAI/ohmygame/pull/406) by @dogxii)
- Open a Music canvas from the Asset Canvas home's quick start row, which no
  longer offers Seedance 2.0.
  ([#444](https://github.com/WhiteTowerAI/ohmygame/pull/444) by @dihuangdh,
  [#469](https://github.com/WhiteTowerAI/ohmygame/pull/469) by @xinyang6879)

### Changed

- Coding agents now use their own permission modes, named as in each CLI, and
  approval cards offer the agent's own Always allow and session options. The
  default lets agents work without asking; existing settings move to that
  default, and another mode can be chosen in **Settings → Agents**.
  ([#460](https://github.com/WhiteTowerAI/ohmygame/pull/460) by @dihuangdh)
- Every Interactive Story now plays as a web story. A story made before web
  stories is upgraded when it is opened in the editor, without an undo, and
  Scene sources are checked as the browser loads them, so package imports and
  non-module files imported as modules are reported with a fix.
  ([#436](https://github.com/WhiteTowerAI/ohmygame/pull/436) by @dihuangdh,
  [#438](https://github.com/WhiteTowerAI/ohmygame/pull/438) by @dihuangdh)
- The Story map Scene now lays out the story in its own code. A Story map Scene
  made from the earlier Template no longer draws; ask the Agent to rewrite it
  from the current Template. The story itself still opens and plays.
  ([#439](https://github.com/WhiteTowerAI/ohmygame/pull/439) by @dihuangdh)
- Asset Canvas always offers Sound effect and Music, and the Agent always has
  its audio tools, even before an audio provider is connected; the node then
  says no audio model is available. Music and Audio creation nodes no longer
  show audio settings.
  ([#443](https://github.com/WhiteTowerAI/ohmygame/pull/443) by @dihuangdh,
  [#469](https://github.com/WhiteTowerAI/ohmygame/pull/469) by @xinyang6879,
  [#470](https://github.com/WhiteTowerAI/ohmygame/pull/470) by @xinyang6879)

### Removed

- **Restore to before this message** in Chat. **Edit** changes only the
  conversation, and **Undo** on a turn's change summary takes its files back.
  ([#463](https://github.com/WhiteTowerAI/ohmygame/pull/463) by @dihuangdh)
- Audio reference uploads, subtitles, and SRT/WebVTT downloads. Existing
  canvases and audio stay readable.
  ([#469](https://github.com/WhiteTowerAI/ohmygame/pull/469) by @xinyang6879)
- The Variables list in Story settings and the "No exits yet" note on Scene
  cards. Playtest still shows Variable values.
  ([#441](https://github.com/WhiteTowerAI/ohmygame/pull/441) by @dihuangdh,
  [#434](https://github.com/WhiteTowerAI/ohmygame/pull/434) by @dihuangdh)

### Fixed

- Keep an unsent Home prompt after visiting a project and returning.
  ([#461](https://github.com/WhiteTowerAI/ohmygame/pull/461) by @dihuangdh)
- Open the earliest Interactive Stories, whose `graph.json` could not be read,
  by upgrading them on open.
  ([#437](https://github.com/WhiteTowerAI/ohmygame/pull/437) by @dihuangdh)
- Start the macOS app when an agent in a sandbox calls `ohmygame-mcp` while
  OhMyGame is closed, and stop a closing window from crashing the app.
  ([#453](https://github.com/WhiteTowerAI/ohmygame/pull/453) by @dihuangdh,
  [#452](https://github.com/WhiteTowerAI/ohmygame/pull/452) by @dihuangdh)
- Stop Scene thumbnail captures from logging `Invalid thumbnail request`
  errors.
  ([#440](https://github.com/WhiteTowerAI/ohmygame/pull/440) by @dihuangdh)

## [0.0.0-beta.4.15] - 2026-10-27

### Added

- Manage separate Claude Code and Codex account configurations, choose the
  default for new chats, and switch accounts in a chat while keeping sign-ins,
  models, usage limits, and native sessions separate.
  ([#403](https://github.com/WhiteTowerAI/ohmygame/pull/403) by @dogxii)
- Opt in to continue a chat once a reported usage limit resets. OhMyGame sends
  one continuation 30 seconds after the last exhausted window resets while the
  conversation stays open; sending a message or cancelling clears the schedule.
  ([#424](https://github.com/WhiteTowerAI/ohmygame/pull/424) by @dogxii)
- Preview horizontal phone games with a Mobile landscape preset, including a
  saved project default and a 667 × 375 Play window.
  ([#399](https://github.com/WhiteTowerAI/ohmygame/pull/399) by @grootbro)
- Prepare a TapTap Maker game's store page, Spark version binding, precheck,
  and review with the new TapTap Release Skill and the official TapTap CLI.
  ([#422](https://github.com/WhiteTowerAI/ohmygame/pull/422) by @dogxii)

### Changed

- Follow project activity and automatic naming over an event stream, and pause
  Canvas polling while the window is hidden until it becomes visible again.
  ([#425](https://github.com/WhiteTowerAI/ohmygame/pull/425) by @dogxii)
- Reuse running Canvas generations and current output from unchanged settings
  when an agent requests media, avoiding another paid run unless a new variation
  is explicitly requested. The Canvas Generate button still starts a new run.
  ([#423](https://github.com/WhiteTowerAI/ohmygame/pull/423) by @dogxii)

### Fixed

- Keep a user-started Canvas generation running when an agent following that
  job is stopped; stopping a generation the agent started still cancels it.
  ([#426](https://github.com/WhiteTowerAI/ohmygame/pull/426) by @dogxii)
- Capture Scene thumbnails after restoring a workspace, show capture failures
  without repeatedly retrying the same version, and use a video's opening frame
  as the fallback cover for video-only Scenes.
  ([#428](https://github.com/WhiteTowerAI/ohmygame/pull/428) by @dihuangdh)
- Discover custom MCP search tool schemas before sending supported arguments,
  and parse multiline event-stream search results and errors correctly.
  ([#419](https://github.com/WhiteTowerAI/ohmygame/pull/419) by @dogxii,
  [#401](https://github.com/WhiteTowerAI/ohmygame/pull/401) by @grootbro)
- Load hosted Community covers directly from their HTTPS URLs while keeping
  local debug covers available through the daemon.
  ([#408](https://github.com/WhiteTowerAI/ohmygame/pull/408) by @dihuangdh)
- Serve static preview scripts, stylesheets, and WebAssembly with the correct
  media types when filename extensions use uppercase or mixed case.
  ([#400](https://github.com/WhiteTowerAI/ohmygame/pull/400) by @grootbro)
- Open General Game workspaces with the conversation pane expanded, and
  recalculate the input's height when the pane is expanded or resized.
  ([#421](https://github.com/WhiteTowerAI/ohmygame/pull/421) by @dogxii)
- Check native process identities asynchronously so CLI and image startup do
  not block on PowerShell, while preserving identity checks during recovery.
  ([#420](https://github.com/WhiteTowerAI/ohmygame/pull/420) by @dogxii)

## [0.0.0-beta.4.14] - 2026-10-26

### Added

- Create a new chat from a completed agent response, carrying the conversation
  through that response into an independent chat.
  ([#404](https://github.com/WhiteTowerAI/ohmygame/pull/404) by @dogxii)
- Drop a project ZIP onto the Projects page to import it as a new project.
  ([#389](https://github.com/WhiteTowerAI/ohmygame/pull/389) by @dogxii)
- Like Community games directly from their cards without signing in.
  ([#397](https://github.com/WhiteTowerAI/ohmygame/pull/397) by @dogxii)
- Export a diagnostics ZIP with redacted desktop logs and system information
  from Settings → About.
  ([#354](https://github.com/WhiteTowerAI/ohmygame/pull/354) by @xuhongbo)
- Add refreshed, localized Story scene templates with bundled Last Bus artwork
  copied into each project that uses it.
  ([#379](https://github.com/WhiteTowerAI/ohmygame/pull/379) by @82228,
  [#411](https://github.com/WhiteTowerAI/ohmygame/pull/411) by @xinyang6879)

### Changed

- Refresh configured Pi model catalogs in the background and offer a manual
  refresh in provider settings.
  ([#392](https://github.com/WhiteTowerAI/ohmygame/pull/392) by @dogxii)
- Update bundled 3D model versions and provider operation limits, including
  Meshy T2.5 and Tripo v3.
  ([#391](https://github.com/WhiteTowerAI/ohmygame/pull/391) by @dogxii)
- Load non-home screens on demand to reduce the initial renderer payload.
  ([#394](https://github.com/WhiteTowerAI/ohmygame/pull/394) by @dogxii,
  [#393](https://github.com/WhiteTowerAI/ohmygame/pull/393) by @dogxii)

### Fixed

- Keep Meshy animation selections and previews stable while the 3D catalog
  refreshes, and use Canvas node titles for downloaded media filenames.
  ([#395](https://github.com/WhiteTowerAI/ohmygame/pull/395) by @dogxii,
  [#398](https://github.com/WhiteTowerAI/ohmygame/pull/398) by @dogxii)
- Explain why a Story cannot start and provide a path back to its editor.
  ([#367](https://github.com/WhiteTowerAI/ohmygame/pull/367) by @xuhongbo)
- Improve Windows Codex discovery and sandbox diagnostics, protect Pi credential
  folders from coding agents, and keep the daemon access token off the renderer
  command line.
  ([#409](https://github.com/WhiteTowerAI/ohmygame/pull/409) by @82228,
  [#359](https://github.com/WhiteTowerAI/ohmygame/pull/359) by @xuhongbo,
  [#363](https://github.com/WhiteTowerAI/ohmygame/pull/363) by @xuhongbo)

## [0.0.0-beta.4.13] - 2026-10-23

### Added

- Export any project as a ZIP with its settings, cover, and workspace, and import
  it as a new project on another computer. Interactive Story exports include
  referenced Library assets, and older Story project ZIPs remain importable.
  ([#355](https://github.com/WhiteTowerAI/ohmygame/pull/355) by @xuhongbo)
- Drop, paste, or upload text documents, CSV/TSV tables, and more image, audio,
  video, and 3D formats into the canvas. Keep other files, including source,
  fonts, and ZIPs, as project file nodes with a desktop file-location action.
  ([#380](https://github.com/WhiteTowerAI/ohmygame/pull/380) by @dogxii,
  [#381](https://github.com/WhiteTowerAI/ohmygame/pull/381) by @dogxii)
- Confirm folder imports before copying files, with choices to preserve the
  directory structure as one folder node, import files separately, or cancel.
  Repeated file and folder names are kept without overwriting existing imports.
  ([#382](https://github.com/WhiteTowerAI/ohmygame/pull/382) by @dogxii)

### Changed

- Claude Code, Codex, and OpenCode now load your existing CLI settings, Hooks,
  MCP servers, Skills, and instructions while retaining OhMyGame's selected
  permissions. OpenCode requires version 2.1.0 or newer in the 2.x series;
  upgrade v1 before using it. If OpenCode reports saved project grants, remove
  those grants in OpenCode and check again.
  ([#376](https://github.com/WhiteTowerAI/ohmygame/pull/376) by @dogxii)
- Community view counts now measure successful game-entry requests, including
  repeat visits, refreshes, and direct shared links, rather than unique visitors.
  Counts start at zero with the matching Cloud migration and survive updates to
  the same published game. Hosted deployments need the matching Cloud API and
  play-count migration.
  ([#353](https://github.com/WhiteTowerAI/ohmygame/pull/353) by @dogxii)

### Fixed

- Keep Library and Community controls, plugin cards, and external-agent actions
  usable in narrow windows, including long plugin names and translated labels.
  ([#372](https://github.com/WhiteTowerAI/ohmygame/pull/372) by @dogxii)

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
- The Windows installer is shown in English or Simplified Chinese, matching the
  app's languages; other system languages get English.
  ([#377](https://github.com/WhiteTowerAI/ohmygame/pull/377) by @dihuangdh)

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
  [#369](https://github.com/WhiteTowerAI/ohmygame/pull/369) by @82228,
  [#377](https://github.com/WhiteTowerAI/ohmygame/pull/377) by @dihuangdh)
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
