---
name: game-ui-frontend
description: Design and implement browser-game HUDs, menus, overlays, responsive layouts, touch controls, and visual feedback without obscuring the playfield.
---

# Game UI Frontend

Build interface surfaces that support play rather than turning the game into a generic dashboard. Preserve an established visual language when modifying an existing game.

## Visual Direction

Before substantial UI work, identify the game's fantasy, camera, primary actions, information hierarchy, material language, typography, palette, and motion tone. Use CSS variables for shared theme values.

## Layout Rules

- Protect the center and primary action area of the playfield.
- Keep critical status persistent, secondary information compact, and rare actions behind menus or drawers.
- Prefer contextual prompts and transient feedback over permanent instruction panels.
- Use DOM for text-heavy HUD, menus, settings, inventories, and accessible controls unless the design requires in-world UI.
- Keep HUD readable over motion without flattening the game beneath excessive panels or blur.
- Do not use landing-page heroes, SaaS dashboard grids, decorative card stacks, or large explanatory text over active play.

## Responsive And Input Behavior

- Design inside an iframe at both wide and narrow sizes without horizontal overflow.
- Respect safe areas and ensure the smallest supported viewport remains playable.
- Provide touch targets and control placement appropriate to mobile play when mobile is in scope.
- Pause or gate camera and gameplay input under menus, dialogs, and inventories.
- Make pointer lock, drag-look, focus, pause, and resume states explicit.
- Respect reduced-motion preferences for nonessential UI motion.

## Change Modes

- For a feature, connect UI state to the actual game-state owner rather than duplicating it locally.
- For a visual bug, reproduce the affected viewport and state before changing layout rules.
- For polish, favor a few meaningful transitions tied to danger, reward, state change, or onboarding.

Verify representative gameplay states on desktop and mobile viewports, including overlay open and closed states. Use `../game-playtest/SKILL.md` for structured visual QA.
