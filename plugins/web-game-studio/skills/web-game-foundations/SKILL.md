---
name: web-game-foundations
description: Set or repair browser-game architecture, including engine choice, game-state ownership, input, assets, save data, debugging, and performance boundaries.
---

# Web Game Foundations

Use this skill for architecture decisions or cross-cutting changes. For focused work in an established project, preserve its working boundaries and change only what the request requires.

## Choose The Runtime

- Preserve the existing runtime for features and bug fixes unless it blocks the requested outcome.
- Prefer Phaser for a new sprite, tilemap, arcade, tactics, or side-view 2D game.
- Prefer plain Three.js for a new imperative 3D runtime in TypeScript or Vite.
- Prefer React Three Fiber only when React state and composition are genuine requirements.
- Keep a working Canvas, Babylon.js, PlayCanvas, or custom runtime when the user or project has already chosen it.

## Stable Boundaries

- Simulation owns rules, entities, progression, timers, collisions, and saveable state.
- Rendering owns scene composition, animation playback, cameras, particles, and presentation state.
- Map keyboard, pointer, touch, and gamepad inputs to named game actions in one place.
- Keep text-heavy HUD and menus in DOM unless the visual design requires canvas or WebGL UI.
- Address assets through stable manifest keys rather than scattering file paths through gameplay code.
- Save serializable game state, not renderer objects.
- Keep debug and performance probes removable or easy to disable.

Use these boundaries in proportion to the project. A small game does not need an enterprise framework, but its rules should not become inseparable from rendering callbacks.

## Multiplayer

For OhMyGame online play, use Colyseus rooms and WebSocket with server-authoritative rules. Call `multiplayer_setup` when available for local tests; it starts a daemon-owned loopback backend and writes `src/ohmygame/client.js`, an integration guide, `multiplayer.json`, and `public/manifest.json`. Read that guide before implementing the game. No cloud deployment is needed for local validation.

Choose the actual server rules adapter: `gomoku`, `stones`, or `arena`. Other rules require a registered server adapter; an SDK connection does not turn arbitrary local game rules into multiplayer. If the service, adapter, or tool is unavailable, report the missing setup. Do not silently use PeerJS, WebRTC, public signaling/STUN/TURN servers, or client-authoritative boards as substitutes. Honor an explicitly requested alternative stack and explain that the platform's Colyseus publishing checks do not support it.

Load the runtime manifest, send player intent through the SDK, and render authoritative snapshots. Handle room creation, joining, waiting for another player, rejected commands, disconnect, refresh, and connection timeout. Test two independent guests, including an invalid action and reconnect. Use session-scoped guest identities for two-tab local tests. Local rooms end when the daemon stops; rerun setup after restarting it. Public publishing requires a separately hosted HTTPS backend and an immutable deployment whose rules and configuration match the game.

## Before Implementation

For a new or substantially changed game, establish:

- player fantasy and primary verbs
- core loop, success, failure, and restart behavior
- camera and input model
- simulation and rendering ownership
- asset organization and loading states
- HUD and menu surfaces
- save, debug, and performance expectations

Once the stack is clear, continue with the relevant runtime skill rather than expanding the architecture indefinitely.
