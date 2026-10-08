# Runtime

```text
┌──────────── Desktop app / web renderer ─────────────┐
│  Conversation            │  Live preview / watch    │
└──────────────┬──────────────────────────────────────┘
               │ local HTTP + SSE (127.0.0.1)
┌──────────────┴──────── Local daemon ────────────────┐
│  Pi agent · playtest · Asset Canvas · plugins · MCP │
│  project workspaces · preview dev server            │
└──────────────┬──────────────────────────────────────┘
               │ Publish (static build only)
┌──────────────┴──────── OhMyGame Cloud ──────────────┐
│  immutable deployments · Community                  │
└─────────────────────────────────────────────────────┘
```

Everything except publishing runs locally. The code is the source of truth for
the HTTP API and event names; this document covers the parts that are not
obvious from it.

## Processes

`bun run dev` starts the React renderer on `http://127.0.0.1:43120` and the
Fastify daemon on `http://127.0.0.1:43110`. Vite proxies the renderer's `/api`
requests to the daemon.

`bun run dev:desktop` starts Vite and Electron. Electron starts the compiled
daemon itself on an available loopback port, waits for `/health`, and passes
the daemon address plus a random process-scoped token through the isolated
preload bridge. The renderer has no Node.js access.

Bun 1.4.2 installs dependencies and executes builds, tests, and most preparation
scripts. Pinned Plugin archives use Node to preserve their locked ZIP checksums;
desktop runtime preparation uses Node and its built-in environment-file loader.
Standalone daemon development and `bun run start` use Node.js 22.19+
explicitly; desktop development and packaged apps run the daemon with
Electron's embedded Node.js. Desktop packages retain the checksum-pinned
Node.js 22.19.0/npm distribution for workspace commands and MCP servers.
New workspaces still default to npm, and existing package-manager choices remain
authoritative. Prepared examples retain their npm lockfiles.

Build and test commands select Bun explicitly. `bunfig.toml` disables automatic
dotenv loading, automatic peer installation, and global Node-to-Bun substitution,
so a daemon's `node` command runs the real Node executable. Runtime preparation
loads `.env.local` while preserving values supplied by the parent process.
`bun run test:node-runtime` builds the daemon and checks startup and its
authenticated API with Node. `PI_CODING_AGENT_DIR` can isolate the desktop
agent's configuration during verification.

The full Bun daemon experiment remains on `chore/bun-runtime`; the adopted
toolchain stage is on `chore/bun-toolchain`. See the
[adoption report](experiments/bun-toolchain-2026-10-07.md) for validation and
measured tradeoffs, including corrections to the earlier experiment's baseline.

Electron main owns only desktop lifecycle. Projects, conversations, previews,
and events live in the daemon. Closing the last window quits the application
and gives the daemon time to stop active Pi and preview processes.

The renderer receives a small runtime event stream over SSE rather than Pi's
internal event objects. Reconnects replay recent events, and conversations are
restored from Pi's session files, so a reload does not lose or duplicate turns.

## Trust boundary

Pi runs in trusted-local mode. The workspace is Pi's working directory, but
`cwd` is not an operating-system security boundary, and enabled Pi tools run
without an OhMyGame approval prompt. Provider credentials stay in the daemon
and are never written to workspaces or returned to the renderer.

## Agent game use

The desktop runtime exposes game interaction and verification as the Pi custom
tool `game_use`. This is an OhMyGame core capability rather than a Plugin:

1. The current Web adapter starts or reuses the project's local Preview and
   accepts only a path, query, or hash on that Preview origin.
2. A private child-process IPC channel forwards typed requests from the daemon
   to Electron main. It is not part of the renderer API.
3. Electron main owns hidden, per-playtest `BrowserWindow` sessions using the
   bundled Chromium runtime.
4. The custom tool returns bounded DOM, canvas, console, failed-request, and
   optional game-state data. PNG captures are returned to the model as image
   content.

The tool supports `open`, `inspect`, `act`, `capture`, and `close`. Runtime
adapters receive a typed open target; the Web adapter uses a Preview URL while
other adapters can use their project or process identity. Actions
cover semantic or coordinate clicks, text input, instant or held key presses,
touch, bounded waits, viewport resizing, and the optional game bridge below.
Calls are sequential, abort with the Agent turn, and time out after 30 seconds.
Sessions are destroyed when explicitly closed, when the daemon or Electron app
shuts down, or after an open failure. At most four sessions may remain open at
once, which bounds hidden-window resource use if an Agent misses cleanup.

The Preview toolbar can reveal the same isolated windows in a watch mode. These
are independent, movable, resizable native windows with the normal macOS title
bar and traffic-light controls. Showing them initially does not take focus, but
they accept normal window interaction after the user clicks them. They do not
stay above unrelated applications. This does not reuse the user Preview or
mirror screenshots: the user sees the exact Chromium surface receiving Agent
input. Closing the watch surface hides it without terminating the playtest
session.

Playtest windows use an isolated partition with sandboxing, context isolation,
and Node integration disabled. Main-frame navigation stays on the original
Preview origin, popups and downloads are blocked, and permissions are denied
except pointer and keyboard lock for game input. Only loopback HTTP Preview
URLs are accepted. This capability is available only when the daemon is owned
by the Electron process; browser-only daemon development does not register the
tool.

This is deliberately a game-use runtime, not unrestricted Browser Use or
desktop Computer Use. It provides the smallest stable surface needed for
repeatable gameplay and visual checks without adding Playwright, Puppeteer, or
a system Chrome dependency to generated games.

### Runtime adapter boundary

`game_use` is backed by a typed runtime adapter. The adapter advertises its
runtime, supported project types, input methods, observations, deterministic
operations, and whether it can be shown in watch mode. The daemon registers
the tool only when the current project's type is included in those capabilities.

The shipped adapter is `web` for `web-game` and `interactive-story` projects
and uses Electron's bundled Chromium. Godot and Unity projects do not receive this tool yet. When
their runtime bridges are added, they should implement the same adapter
contract for launch or attach, input, screenshots, state, reset or stepping,
and shutdown. An editor MCP connection alone is not a runtime adapter and
must not be presented as gameplay verification.

### Optional game bridge

Games with random, timed, or deeply nested states may expose a serializable,
test-only bridge while the `ohmygamePlaytest` query parameter is present:

```ts
declare global {
  interface Window {
    __OHMYGAME_PLAYTEST__?: {
      snapshot?: () => unknown | Promise<unknown>;
      reset?: () => void | Promise<void>;
      setSeed?: (seed: number) => void | Promise<void>;
      step?: (milliseconds: number) => void | Promise<void>;
    };
  }
}

export {};
```

`snapshot()` should return compact JSON-serializable simulation state, not
renderer objects or credentials. The other methods should perform one named,
deterministic operation and may be asynchronous. The driver advertises only
methods that exist. Games must remain fully playable without this bridge, and
playtests should still use real input and screenshots to verify what a player
sees. Capture analysis reports opacity and luminance variance as a blank-frame
warning; it is a heuristic rather than a semantic visual assertion.

## Persistence

Each project lives under the daemon data directory:

```text
projects/<project-id>/
├── project.json   project identity and latest publication
├── cover.webp     custom cover; its presence stops automatic replacement
├── cover-auto.webp last automatic cover, retained when a custom cover is applied
├── workspace/     the project files (or an existing folder in the desktop app)
└── session/       Pi session files, one per conversation
```

Removing a project never deletes an existing folder used as its workspace.

Project covers are saved independently of publishing. Selecting an image in the
publish dialog previews it; **Apply cover** saves it and stops automatic cover
replacement. **Restore automatic cover** returns to the last automatic cover,
or an Interactive Story's Scene thumbnail when available. Automatic captures
cannot overwrite a custom cover, including captures already in flight. Existing
covers from older app versions are protected as custom covers until the user
restores automatic mode. Restoring removes the custom cover; the automatic
cover is retained separately. Duplicating a project preserves both covers.
The Community cover is a snapshot in the published Deployment and changes only
when an update is published; publication details show that snapshot.

## Publishing

A workspace is publishable when it has a non-empty `scripts.build` that
produces a static `index.html` under `dist`, `build`, or `out`, or has a root
`index.html`. Only that static output is uploaded; hidden files, dependencies,
and symbolic links are skipped, and binary assets are preserved byte for byte.
The workspace, Pi sessions, conversations, and credentials are never sent.

Each publish creates an immutable Deployment of the same Game, so the play link
stays the same. The project stores only the publication identity: Game ID,
Deployment ID, play URL, publish time, and the published title and description.

The Publish v1 contract is in the
[`ohmygame-cloud` repository](https://github.com/WhiteTowerAI/ohmygame-cloud/blob/main/docs/publish-v1.md).
